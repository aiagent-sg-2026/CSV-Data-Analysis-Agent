import { deleteDB } from 'idb';
import Papa from 'papaparse';
import { openStorageDatabase, writeReportProjection, CURRENT_SESSION_KEY, type StorageDatabase } from '../storageService';
import { DATASET_COMMITS_STORE, commitIntentKey, commitApprovalKey, type DatasetCommitMarker } from '../../types/datasetCommit';
import { commitDatasetTransaction, readCommitIntent } from '../persistence/datasetCommitStorage';
import { reconcileReportCommit } from '../persistence/datasetCommitProjection';
import { buildPersistedReportRecord } from '../persistence/persistedAppState';
import { createCandidateCommitService } from './candidateCommit';
import { prepareCandidateCommitFixture } from './candidateCommitQualificationFixture';
import { DuckDbWorkerClient } from '../workers/duckDbWorkerClient';
import { getCsvDatasetLoadVersion } from '../../utils/datasetId';
import { beginSessionTransition, beginRun, cancelOwnedRun } from '../session/sessionOwnership';
import type { CandidateCheck } from './candidateStagingQualification';
import type { primeDuckDbDataset } from '../duckdb/queryEngine';

type Fault = { mode: 'abort' | 'abort_unknown' | 'quota' | 'lost_ack' | 'unknown' | 'head_read' | 'hold' | ''; tripped?: boolean; failRead?: boolean; marker?: DatasetCommitMarker; onHeld?: () => void };
/** Qualification-only fault adapter around real IDB requests/transactions, never a fake transaction store. */
export const withCommitStorageFault = (db: StorageDatabase, fault: Fault): StorageDatabase => new Proxy(db, {
    get(target,property) {
        if(property==='get')return (...args:unknown[])=>{if(fault.failRead&& (fault.mode!=='head_read'||String(args[1]).startsWith('["head",')))throw new Error('injected_read_unavailable');return Reflect.apply(target.get,target,args);};
        if(property==='transaction')return (...args:unknown[])=>{
            const tx=Reflect.apply(target.transaction,target,args) as ReturnType<StorageDatabase['transaction']>;
            const done=tx.done.then(()=>{
                if(fault.mode==='head_read')fault.failRead=true;
                if(!fault.tripped&&['lost_ack','unknown'].includes(fault.mode)){fault.tripped=true;fault.failRead=fault.mode==='unknown';throw new Error('injected_ack_loss');}
            });
            void done.catch(()=>undefined);
            return new Proxy(tx,{get(transaction,key){
                if(key==='done')return done;
                if(key==='objectStore')return (name: typeof DATASET_COMMITS_STORE | 'reports')=>{
                    const objectStore=transaction.objectStore(name);
                    return new Proxy(objectStore,{get(store,method){
                        if(name===DATASET_COMMITS_STORE&&method==='add')return async(value:DatasetCommitMarker)=>{
                            fault.marker=structuredClone(value);const result=await Reflect.apply(store.add,store,[value]);
                            if(!fault.tripped&&['abort','abort_unknown'].includes(fault.mode)){fault.tripped=true;fault.failRead=fault.mode==='abort_unknown';transaction.abort();throw new DOMException('Injected transaction abort','AbortError');}
                            if(!fault.tripped&&fault.mode==='hold'){
                                fault.tripped=true;
                                const pump=()=>{void store.get('__qualification_hold__').then(pump,()=>undefined);};pump();fault.onHeld?.();
                                return new Promise<never>(()=>undefined);
                            }
                            return result;
                        };
                        if(name===DATASET_COMMITS_STORE&&method==='put')return (value:unknown)=>{
                            if(!fault.tripped&&fault.mode==='quota'){fault.tripped=true;throw new DOMException('Injected quota exhaustion','QuotaExceededError');}
                            return Reflect.apply(store.put,store,[value]);
                        };
                        const value=Reflect.get(store,method,store);return typeof value==='function'?value.bind(store):value;
                    }});
                };
                const value=Reflect.get(transaction,key,transaction);return typeof value==='function'?value.bind(transaction):value;
            }});
        };
        const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    },
});

const modes=['atomic-success','abort-retry','quota-retry','same-key-concurrent','payload-conflict','version-contenders','approval-consumption',
    'lost-ack','unknown-reconcile','unknown-abort-retry','head-read-failure','stale-projections','session-switch','binding-failure','metadata-reopen'] as const;
export const qualifyCandidateCommit = async(signal:AbortSignal,onObservation?:(check:CandidateCheck)=>void)=>{
    const observations:CandidateCheck[]=[];
    const client=new DuckDbWorkerClient();
    const retire=()=>client.retireSession();signal.addEventListener('abort',retire,{once:true});
    const bind:typeof primeDuckDbDataset=async(data,abortSignal)=>{
        if(!data)throw new Error('no_dataset');
        const binding={tableName:'session_clean_dataset',loadVersion:getCsvDatasetLoadVersion(data)};
        await client.initDuckDb(45000,abortSignal);
        await client.loadCleanDataset({...binding,csvText:Papa.unparse(data.data),csvFileName:data.fileName},45000,abortSignal);
        return {...binding,engine:'duckdb',fallbackReason:null,fallbackStage:null};
    };
    try {
        for(const mode of modes){
            if(signal.aborted)break;
            const started=performance.now(),name=`csv-agent-ca132-${crypto.randomUUID()}`;
            const db=await openStorageDatabase(name);let f:Awaited<ReturnType<typeof prepareCandidateCommitFixture>>|undefined;
            let abort:()=>void=()=>undefined;
            try {
                f=await prepareCandidateCommitFixture({signal});
                const fixture=f;abort=()=>cancelOwnedRun(fixture.root);signal.addEventListener('abort',abort,{once:true});
                const baseline=buildPersistedReportRecord(f.root.getState(),{id:f.lease.scope.sessionId,filename:'synthetic-commit.csv'});
                const original=JSON.stringify(f.root.getState().rawCsvData);
                const fault:Fault={mode:mode==='abort-retry'?'abort':mode==='unknown-abort-retry'?'abort_unknown':mode==='head-read-failure'?'head_read':mode==='quota-retry'?'quota':mode==='lost-ack'?'lost_ack':mode==='unknown-reconcile'?'unknown':
                    ['payload-conflict','version-contenders','approval-consumption'].includes(mode)?'abort':''};
                const service=createCandidateCommitService(f.store,{database:async()=>withCommitStorageFault(db,fault),
                    bind:mode==='binding-failure'?async()=>{throw new Error('injected_rebind_failure');}:bind,
                    onAdmitted:mode==='session-switch'?()=>{beginSessionTransition(fixture.root);fixture.root.setState({sessionId:'replacement',isBusy:true});beginRun(fixture.root,'follow_up','replacement-run');}:undefined});
                const review=await service.review(f.candidate.candidateId,{idempotencyKey:'qualification-intent',primaryTable:'facts'}),approval=service.approve(review);
                const first=await service.commit(approval);let passed=false;
                const details:Record<string,unknown>={status:first.status,acknowledgement:first.acknowledgement};
                if(mode==='atomic-success'){
                    const query=await client.executeRawQuery({sql:'SELECT COUNT(*) n, SUM(TRY_CAST(Amount AS DOUBLE)) total FROM session_clean_dataset',selectedColumns:[],limit:10,
                        expectedBinding:{tableName:'session_clean_dataset',loadVersion:getCsvDatasetLoadVersion(f.root.getState().csvData!)}},10000,signal);
                    passed=first.status==='committed'&&first.acknowledgement==='installed'&&Number(query.rows[0]?.n)===2&&Number(query.rows[0]?.total)===-5;
                    details.marker=first.marker;details.report=await db.get('reports',baseline.id);details.query=query.rows;details.approvalConsumed=first.marker?.approval.approvalId===approval.approvalId;
                    passed&&=details.approvalConsumed===true;
                } else if(mode==='abort-retry'||mode==='quota-retry'){
                    const empty=await db.count(DATASET_COMMITS_STORE)===0&&await db.count('reports')===0;
                    const retry=await service.commit(approval);passed=first.status==='not_committed'&&first.admitted&&empty&&retry.status==='committed'&&retry.marker?.approval.approvalId===approval.approvalId;
                    details.abortedWithoutRecords=empty;details.retry=retry.status;
                } else if(mode==='same-key-concurrent'){
                    const replies=await Promise.all([service.commit(approval),service.commit(approval)]);
                    passed=first.status==='committed'&&replies.every(r=>r.status==='committed'&&r.replay&&r.marker?.commitId===first.marker?.commitId);
                    // Also challenge two real transactions concurrently; the queue is not the uniqueness authority.
                    const direct=await Promise.all([commitDatasetTransaction(db,first.marker!,baseline,()=>undefined),commitDatasetTransaction(db,first.marker!,baseline,()=>undefined)]);
                    passed&&=direct.every(r=>r.replay&&r.marker.commitId===first.marker?.commitId);
                    details.replayedTransactions=direct.length;
                } else if(['payload-conflict','version-contenders','approval-consumption'].includes(mode)){
                    const marker=fault.marker!;
                    if(mode==='version-contenders'){
                        const other={...structuredClone(marker),commitId:'competing-commit',recordId:commitIntentKey(marker.sessionId,'different-intent'),intentKey:commitIntentKey(marker.sessionId,'different-intent'),idempotencyKey:'different-intent',approvalKey:commitApprovalKey(marker.sessionId,'different-approval'),approval:{...marker.approval,approvalId:'different-approval'}};
                        other.bundle.acceptedCommit={sessionId:marker.sessionId,commitId:other.commitId,revision:1};
                        const results=await Promise.allSettled([commitDatasetTransaction(db,marker,baseline,()=>undefined),commitDatasetTransaction(db,other,baseline,()=>undefined)]);
                        passed=results.filter(r=>r.status==='fulfilled').length===1&&results.some(r=>r.status==='rejected'&&String(r.reason).includes('input_version_changed'));
                        details.winners=results.filter(r=>r.status==='fulfilled').length;
                    } else {
                        await commitDatasetTransaction(db,marker,baseline,()=>undefined);
                        const altered=structuredClone(marker);
                        if(mode==='payload-conflict')altered.payloadDigest='f'.repeat(64);
                        else {altered.recordId=commitIntentKey(marker.sessionId,'different-intent');altered.intentKey=altered.recordId;altered.idempotencyKey='different-intent';altered.parentCommitId=marker.commitId;altered.revision=2;altered.inputBindings=marker.outputBindings;}
                        let rejection='';try{await commitDatasetTransaction(db,altered,baseline,()=>undefined);}catch(error){rejection=error instanceof Error?error.message:'';}
                        passed=rejection===(mode==='payload-conflict'?'idempotency_conflict':'approval_consumed');details.rejection=rejection;
                    }
                } else if(mode==='lost-ack')passed=first.status==='committed'&&first.replay&&first.acknowledgement==='installed';
                else if(mode==='unknown-reconcile'||mode==='unknown-abort-retry'){
                    const originalRows=f.root.getState().csvData?.data.length===3,paused=f.root.getState().datasetCommitBindingStatus==='commit_unknown';
                    const pending=await service.commit(approval);fault.failRead=false;const retry=await service.commit(approval);
                    passed=first.status==='unknown'&&pending.status==='unknown'&&paused&&originalRows&&retry.status==='committed'&&retry.replay===(mode==='unknown-reconcile');details.retry=retry.status;
                } else if(mode==='head-read-failure'){
                    const blocked=f.root.getState().datasetCommitBindingStatus==='binding_failed';fault.failRead=false;
                    const retry=await service.commit(approval);passed=first.status==='committed'&&first.acknowledgement==='binding_failed'&&blocked&&retry.status==='committed'&&retry.replay&&retry.acknowledgement==='installed';
                } else if(mode==='stale-projections'){
                    for(const id of [baseline.id,CURRENT_SESSION_KEY,'archive-synthetic'])await writeReportProjection({...baseline,id},db);
                    const saved=await db.getAll('reports');passed=first.status==='committed'&&saved.length===3&&saved.every(r=>r.appState.datasetBundle?.acceptedCommit?.commitId===first.marker?.commitId&&r.appState.csvData===null&&r.appState.rawCsvData===null);
                    details.reconciledRecords=saved.length;
                } else if(mode==='session-switch'){
                    passed=first.status==='committed'&&first.acknowledgement==='revoked'&&f.root.getState().sessionId==='replacement'&&f.root.getState().activeExecution?.runId==='replacement-run'&&f.root.getState().isBusy;
                    await writeReportProjection(baseline,db);const archived=await db.get('reports',baseline.id);
                    passed&&=archived?.appState.datasetBundle?.acceptedCommit?.commitId===first.marker?.commitId;
                } else if(mode==='binding-failure')passed=first.status==='committed'&&first.acknowledgement==='binding_failed'&&f.root.getState().datasetCommitBindingStatus==='binding_failed';
                else if(mode==='metadata-reopen'){
                    db.close();const reopened=await openStorageDatabase(name);
                    try{const marker=await readCommitIntent(reopened,f.lease.scope.sessionId,review.idempotencyKey),report=await reopened.get('reports',baseline.id);
                        const restored=report&&await reconcileReportCommit({get:key=>reopened.get(DATASET_COMMITS_STORE,key)},report);
                        passed=marker?.commitId===first.marker?.commitId&&restored?.appState.csvData===null&&restored?.appState.datasetCommitBindingStatus==='awaiting_source';
                        details.rowsRetained=false;details.authorityRestored=false;
                    }finally{reopened.close();}
                }
                if(mode!=='metadata-reopen'){
                    const records=await db.getAll(DATASET_COMMITS_STORE);details.journalRecords=records.length;
                    passed&&=records.length===2&&records.filter(r=>r.kind==='commit').length===1&&records.filter(r=>r.kind==='head').length===1;
                }
                passed&&=JSON.stringify(f.root.getState().rawCsvData)===original;
                const observation={id:mode,passed:Boolean(passed),elapsedMs:Math.round(performance.now()-started),details};observations.push(observation);
                if(!signal.aborted)onObservation?.(observation);
                if(!passed)break;
            } finally {
                signal.removeEventListener('abort',abort);f?.cleanup();db.close();await deleteDB(name);
            }
        }
    } finally {signal.removeEventListener('abort',retire);client.retireSession();}
    return {passed:!signal.aborted&&observations.length===modes.length&&observations.every(c=>c.passed),observations,
        qualification:'CA-132 real IndexedDB and isolated QuickJS/DuckDB; public synthetic host executor fixture. Approval resume UI, durable rows/recovery and unfamiliar-model autonomy remain pending.'};
};

/** External browser harness closes this disposable page only after a real uncommitted marker write. */
export const startCommitInterruptionProbe = async(name:string,onHeld:()=>void)=>{
    if(!/^csv-agent-ca132-close-[a-f0-9-]+$/.test(name))throw new Error('qualification_database_invalid');
    const db=await openStorageDatabase(name),fixture=await prepareCandidateCommitFixture();
    const fault:Fault={mode:'hold',onHeld};
    const service=createCandidateCommitService(fixture.store,{database:async()=>withCommitStorageFault(db,fault),bind:async()=>{throw new Error('must_not_bind');}});
    const review=await service.review(fixture.candidate.candidateId,{idempotencyKey:'interruption-intent',primaryTable:'facts'});
    void service.commit(service.approve(review));
    return {sessionId:fixture.lease.scope.sessionId,idempotencyKey:review.idempotencyKey};
};
