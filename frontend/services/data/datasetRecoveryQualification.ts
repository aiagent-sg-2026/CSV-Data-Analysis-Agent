import { deleteDB } from 'idb';
import Papa from 'papaparse';
import { openStorageDatabase, writeReportProjection, CURRENT_SESSION_KEY, type StorageDatabase } from '../storageService';
import { DATASET_COMMITS_STORE, commitHeadKey } from '../../types/datasetCommit';
import { DATASET_RETENTION_STORE, RETENTION_POLICY, type DatasetRetainedArtifact } from './datasetRecoveryContract';
import { buildPersistedReportRecord } from '../persistence/persistedAppState';
import { prepareCandidateCommitFixture } from './candidateCommitQualificationFixture';
import { stageRecoveryQualificationCandidate } from './datasetRecoveryQualificationFixture';
import { createCandidateCommitService } from './candidateCommit';
import { restoreAcceptedDataset, retainAcceptedDataset, reviewDatasetRollback, commitDatasetRollback, listRollbackTargets, type RecoveryDependencies } from './datasetRecoveryActions';
import { recoverCandidateReview, commitRecoveredCandidate } from './candidateRecovery';
import { readRetainedRows, collectRetainedRows, RETAINED_DATA_ROOT, type RetentionDirectory } from '../persistence/datasetRetention';
import { beginRun, finishRun, scopeRunStore, beginSessionTransition, cancelOwnedRun, assertRunActive } from '../session/sessionOwnership';
import { reconstructDatasetCommit } from './datasetRecovery';
import { DuckDbWorkerClient } from '../workers/duckDbWorkerClient';
import { getCsvDatasetLoadVersion } from '../../utils/datasetId';
import { sha256Bytes } from './sourceDigest';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { withCommitStorageFault } from './candidateCommitQualification';
import type { CandidateCheck } from './candidateStagingQualification';
import type { StoreApi } from '../agent/types';
import type { DatasetCommitMarker } from '../../types/datasetCommit';
import { createAndStoreTabSessionId } from '../../store/sessionLifecycle';

const modes=['source-reload','retained-reopen','source-mismatch','environment-unavailable','uncertain-effect','lost-ack-reload','uncertain-read',
    'missing-retained-file','retention-quota','retention-write-failure','gc-pins-expiry','gc-session-boundary','gc-read-pin',
    'rollback-append','rollback-awaiting-source','rollback-contender','interrupted-approval','interrupted-budget','history-fork-reopen',
    'stateful-replay','multi-table-rollback'] as const;
const original=()=>new File(['Name,Amount\nTotal Solutions,0\n Detail ,-5\nSubtotal,-5\n'],'synthetic-commit.csv');
const rootDirectory=()=>navigator.storage.getDirectory();
const folderFor=async(record:DatasetRetainedArtifact)=> (await (await (await rootDirectory()).getDirectoryHandle(RETAINED_DATA_ROOT))
    .getDirectoryHandle(await sha256Bytes(new TextEncoder().encode(record.sessionId)))).getDirectoryHandle(record.recordId);
const seal=async(marker:DatasetCommitMarker)=>{const {digest:_digest,...body}=marker.replayManifest!;marker.replayManifest!.digest=await codeDigest(body);};
const errorCode=(error:unknown)=>error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'qualification_failed';

/** Private synthetic DB/OPFS namespaces, actual QuickJS/IDB/DuckDB boundaries, no provider. */
export const qualifyDatasetRecovery=async(signal:AbortSignal,onObservation?:(value:CandidateCheck)=>void)=>{
    const observations:CandidateCheck[]=[],client=new DuckDbWorkerClient(),retire=()=>client.retireSession();signal.addEventListener('abort',retire,{once:true});
    const bind:NonNullable<RecoveryDependencies['bind']>=async(data,abort)=>{
        if(!data)throw new Error('complete_input_unavailable');
        const binding={tableName:'session_clean_dataset',loadVersion:getCsvDatasetLoadVersion(data)};
        await client.initDuckDb(45000,abort);await client.loadCleanDataset({...binding,csvText:Papa.unparse(data.data),csvFileName:data.fileName},45000,abort);
        return {...binding,engine:'duckdb',fallbackReason:null,fallbackStage:null};
    };
    try{for(const mode of modes){
        if(signal.aborted)break;
        const started=performance.now(),name=`csv-agent-ca134-${crypto.randomUUID()}`;
        let db=await openStorageDatabase(name),f:Awaited<ReturnType<typeof prepareCandidateCommitFixture>>|undefined;
        let extra:Awaited<ReturnType<typeof stageRecoveryQualificationCandidate>>|undefined,lease:ReturnType<typeof beginRun>|undefined;
        let abort:()=>void=()=>undefined;const cleanupOwners=new Set<string>();let status='',passed=false;const details:Record<string,unknown>={};
        const deps:RecoveryDependencies={database:async()=>db,bind,persist:async(store)=>{
            const run=store.executionContext!.lease;assertRunActive(store,run);
            const state=store.getState(),report=buildPersistedReportRecord(state,{id:state.sessionId,filename:'synthetic-commit.csv'});
            await writeReportProjection(report,db);assertRunActive(store,run);await writeReportProjection({...report,id:CURRENT_SESSION_KEY},db);assertRunActive(store,run);return true;
        }};
        try{
            f=await prepareCandidateCommitFixture({signal});const fixture=f;cleanupOwners.add(f.lease.scope.sessionId);abort=()=>cancelOwnedRun(fixture.root);signal.addEventListener('abort',abort,{once:true});
            let store=f.store,prep=f.prep,candidate=f.candidate;
            if(mode==='stateful-replay'||mode==='multi-table-rollback'){
                prep.task.close('blocked');finishRun(f.root,f.lease);extra=await stageRecoveryQualificationCandidate(f.root,mode==='stateful-replay'?'stream':'multi');
                store=extra.store;prep=extra.prep;candidate=extra.candidate;
            }
            const fault={mode:mode==='lost-ack-reload'?'lost_ack' as const:'' as const};
            const service=createCandidateCommitService(store,{database:async()=>withCommitStorageFault(db,fault),bind});
            const review=await service.review(candidate.candidateId,{primaryTable:'facts',idempotencyKey:'qualification-recovery-intent'}),checkpoint=await service.recoveryCheckpoint(review);
            f.root.setState({candidateRecovery:checkpoint});await deps.persist!(store);
            const initial=['interrupted-approval','interrupted-budget'].includes(mode)?undefined:await service.commit(service.approve(review));
            const marker=initial?.marker??checkpoint.proposal;
            if(initial?.status!=='committed'&&initial!==undefined)throw new Error('initial_commit_failed');
            prep.task.close('blocked');finishRun(f.root,store.executionContext!.lease);
            const fresh=(replace=false)=>{
                if(lease)finishRun(fixture.root,lease);if(replace)beginSessionTransition(fixture.root);
                lease=beginRun(fixture.root,'follow_up',`recovery-${crypto.randomUUID()}`);return scopeRunStore(fixture.root,lease);
            };
            let owned=fresh();
            const removeReferences=async()=>{await db.delete(DATASET_COMMITS_STORE,commitHeadKey(marker.sessionId));for(const r of await db.getAll('reports'))await db.delete('reports',r.id);};
            if(mode==='source-reload'||mode==='lost-ack-reload'||mode==='stateful-replay'){
                const saved=await db.get('reports',marker.sessionId);db.close();db=await openStorageDatabase(name);owned=fresh(true);
                fixture.root.setState({datasetBundle:saved!.appState.datasetBundle,csvData:null,canonicalCsvData:null,rawCsvData:null,datasetCommitBindingStatus:'awaiting_source',activeDataQuery:null,candidateRecovery:null});
                await restoreAcceptedDataset(owned,{file:original()},deps);
                const query=await client.executeRawQuery({sql:'SELECT COUNT(*) n, SUM(TRY_CAST(Amount AS DOUBLE)) total FROM session_clean_dataset',selectedColumns:[],limit:10,
                    expectedBinding:{tableName:'session_clean_dataset',loadVersion:getCsvDatasetLoadVersion(fixture.root.getState().csvData!)}},10000,signal);
                passed=Number(query.rows[0]?.n)===2&&Number(query.rows[0]?.total)===-5&&await db.count(DATASET_COMMITS_STORE)===2;
                details.rows=2;details.total=-5;details.commitCount=1;details.metadataOnly=saved?.appState.csvData===null;status='verified_reconstruction';
            }else if(mode==='retained-reopen'||mode==='missing-retained-file'||mode.startsWith('gc-')||mode==='history-fork-reopen'){
                await retainAcceptedDataset(owned,deps);await retainAcceptedDataset(owned,deps);
                const records=await db.getAll(DATASET_RETENTION_STORE),record=records[0];details.retainedArtifacts=records.length;
                if(mode==='retained-reopen'){
                    db.close();db=await openStorageDatabase(name);owned=fresh(true);fixture.root.setState({csvData:null,canonicalCsvData:null,datasetCommitBindingStatus:'awaiting_source'});
                    await restoreAcceptedDataset(owned,{},deps);passed=fixture.root.getState().csvData?.data.length===2&&records.length===1&&fixture.root.getState().activeDataQuery===null;status='verified_retained_restore';
                }else if(mode==='missing-retained-file'){
                    await(await folderFor(record)).removeEntry('chunk-0');owned=fresh(true);fixture.root.setState({csvData:null,canonicalCsvData:null,datasetCommitBindingStatus:'awaiting_source'});
                    try{await restoreAcceptedDataset(owned,{},deps);}catch(error){status=errorCode(error);}
                    passed=status==='retention_rows_unavailable'&&fixture.root.getState().csvData===null;
                    await restoreAcceptedDataset(owned,{file:original()},deps);await retainAcceptedDataset(owned,deps);passed&&=fixture.root.getState().csvData?.data.length===2;details.explicitSourceRepair=true;
                }else if(mode==='history-fork-reopen'){
                    const state={...fixture.root.getState(),sessionId:`fork-${crypto.randomUUID()}`,csvData:null,canonicalCsvData:null,datasetCommitBindingStatus:'awaiting_source' as const};
                    await writeReportProjection(buildPersistedReportRecord(state,{id:state.sessionId,filename:'synthetic-commit.csv'}),db);owned=fresh(true);fixture.root.setState(state);owned=fresh(true);
                    db.close();db=await openStorageDatabase(name);const saved=await db.get('reports',state.sessionId);
                    await restoreAcceptedDataset(owned,{},deps);passed=saved?.appState.datasetBundle?.acceptedCommit?.commitId===marker.commitId&&fixture.root.getState().csvData?.data.length===2
                        &&await db.count(DATASET_COMMITS_STORE)===2;status='fork_reference_restored';
                }else{
                    await db.put(DATASET_RETENTION_STORE,{...record,expiresAt:0});
                    if(mode==='gc-pins-expiry'){
                        const protectedCount=await collectRetainedRows(db,marker.sessionId);await removeReferences();const removed=await collectRetainedRows(db,marker.sessionId);
                        passed=protectedCount===0&&removed===1&&(await db.get(DATASET_RETENTION_STORE,record.recordId))?.status==='deleted';details.protected=protectedCount;details.removed=removed;status='reference_pins_verified';
                    }else if(mode==='gc-session-boundary'){
                        const other={...record,recordId:`retained-${crypto.randomUUID()}`,sessionId:`other-${crypto.randomUUID()}`,commitId:'other-commit',expiresAt:0};await db.put(DATASET_RETENTION_STORE,other);
                        await removeReferences();const removed=await collectRetainedRows(db,marker.sessionId);
                        passed=removed===1&&(await db.get(DATASET_RETENTION_STORE,other.recordId))?.status==='ready';status='other_namespace_preserved';
                    }else{
                        await removeReferences();let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
                        const reading=readRetainedRows(db,marker,async()=>{started();await gate;return rootDirectory();});await began;
                        const protectedCount=await collectRetainedRows(db,marker.sessionId);release();const material=await reading;
                        const removed=await collectRetainedRows(db,marker.sessionId);passed=Boolean(material)&&protectedCount===0&&removed===1;status='active_read_pin_verified';
                    }
                }
            }else if(mode==='source-mismatch'||mode==='environment-unavailable'||mode==='uncertain-effect'||mode==='uncertain-read'){
                owned=fresh(true);
                if(mode==='uncertain-read'){
                    const blockedDb=new Proxy(db,{get(target,key){if(key==='get')return ()=>{throw new Error('journal_unavailable');};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
                    try{await restoreAcceptedDataset(owned,{file:original()},{...deps,database:async()=>blockedDb});}catch(error){status=errorCode(error);}
                    passed=status==='journal_unavailable'&&fixture.root.getState().datasetCommitBindingStatus==='commit_unknown';
                }else{
                    const altered=structuredClone(marker);
                    if(mode==='environment-unavailable'){altered.environment.runtime='missing-engine';altered.validation={...altered.validation,environmentDigest:await codeDigest(altered.environment)};}
                    if(mode==='uncertain-effect'){(altered.replayManifest as unknown as {effectSafety:string}).effectSafety='unknown_external_outcome';await seal(altered);}
                    try{await reconstructDatasetCommit(owned,altered,{file:mode==='source-mismatch'?new File(['Name,Amount\nWrong,999\n'],'wrong.csv'):original()});}catch(error){status=errorCode(error);}
                    passed=status===(mode==='source-mismatch'?'recovery_source_mismatch':mode==='environment-unavailable'?'recovery_environment_unavailable':'recovery_uncertain_effect');
                }
            }else if(mode==='retention-quota'||mode==='retention-write-failure'){
                if(mode==='retention-quota')await db.put(DATASET_RETENTION_STORE,{recordId:`retained-${crypto.randomUUID()}`,sessionId:'quota-reservation',commitId:'other-commit',manifestDigest:'a'.repeat(64),
                    sha256:'a'.repeat(64),byteSize:RETENTION_POLICY.totalBytes,chunks:1,createdAt:Date.now(),expiresAt:Date.now()+60000,status:'writing'});
                const before=fixture.root.getState().datasetBundle!.acceptedCommit!.commitId;
                try{await retainAcceptedDataset(owned,mode==='retention-write-failure'?{...deps,directory:async()=>{throw new DOMException('Injected write failure','QuotaExceededError');}}:deps);}catch(error){status=mode==='retention-write-failure'?'opfs_write_rejected':errorCode(error);}
                passed=status===(mode==='retention-quota'?'retention_total_quota':'opfs_write_rejected')&&fixture.root.getState().datasetBundle?.acceptedCommit?.commitId===before
                    &&!(await db.getAll(DATASET_RETENTION_STORE)).some(r=>r.status==='ready');
            }else if(mode.startsWith('rollback-')||mode==='multi-table-rollback'){
                finishRun(fixture.root,lease!);lease=undefined;
                extra=await stageRecoveryQualificationCandidate(fixture.root,'names');
                const second=createCandidateCommitService(extra.store,{database:async()=>db,bind}),r=await second.review(extra.candidate.candidateId,{primaryTable:'names',idempotencyKey:'qualification-second-version'});
                await second.commit(second.approve(r));extra.prep.task.close('completed');finishRun(fixture.root,extra.lease);owned=fresh(mode==='rollback-awaiting-source');
                const target=(await listRollbackTargets(owned,deps))[0];
                if(mode==='rollback-awaiting-source'){
                    try{await reviewDatasetRollback(owned,target,{},deps);}catch(error){status=errorCode(error);}
                    passed=status==='recovery_source_unavailable'&&await db.count(DATASET_COMMITS_STORE)===3;
                }else{
                    const exact=await reviewDatasetRollback(owned,target,{file:original()},deps);owned=fresh();
                    if(mode==='rollback-contender'){
                        const head=await db.get(DATASET_COMMITS_STORE,commitHeadKey(fixture.root.getState().sessionId));
                        if(head?.kind!=='head')throw new Error('commit_marker_invalid');await db.put(DATASET_COMMITS_STORE,{...head,revision:head.revision+1});
                        try{await commitDatasetRollback(owned,exact,deps);}catch(error){status=errorCode(error);}
                        passed=status==='commit_marker_invalid'&&await db.count(DATASET_COMMITS_STORE)===3;
                    }else{
                        const restored=await commitDatasetRollback(owned,exact,deps),duplicate=await commitDatasetRollback(owned,exact,deps);
                        passed=restored.commitId===duplicate.commitId&&restored.revision===3&&fixture.root.getState().csvData?.data[1].Amount===-5&&await db.count(DATASET_COMMITS_STORE)===4
                            &&restored.bundle.tables[0].schema.some(c=>c.name==='Amount')&&fixture.root.getState().activeDataQuery===null;
                        if(mode==='multi-table-rollback')passed&&=restored.bundle.tables.length===2&&restored.bundle.relationships[0]?.decision==='trusted';
                        details.appendedRevision=restored.revision;details.tableCount=restored.bundle.tables.length;details.relationshipCount=restored.bundle.relationships.length;status='rollback_appended_once';
                    }
                }
            }else{
                owned=fresh(true);fixture.root.setState({csvData:null,canonicalCsvData:null,rawCsvData:null,candidateRecovery:checkpoint});
                const result=await recoverCandidateReview(owned,{file:original()},deps);
                if(result.status!=='review')throw new Error('fresh_review_missing');
                details.attempts=fixture.root.getState().candidateRecovery?.task.budget.used.transformationAttempts;
                if(mode==='interrupted-approval'){
                    owned=fresh();const restored=await commitRecoveredCandidate(owned,result.review,deps);
                    passed=restored.audit.runId===lease!.runId&&restored.validation.runId===lease!.runId&&await db.count(DATASET_COMMITS_STORE)===2&&fixture.root.getState().candidateRecovery===null;
                    status='fresh_review_committed_once';
                }else{
                    // Real stale projection writes cannot reduce the already consumed counters.
                    await writeReportProjection(buildPersistedReportRecord({...fixture.root.getState(),candidateRecovery:checkpoint},{id:fixture.root.getState().sessionId,filename:'synthetic-commit.csv'}),db);
                    const saved=await db.get('reports',fixture.root.getState().sessionId);details.durableAttempts=saved?.appState.candidateRecovery?.task.budget.used.transformationAttempts;
                    owned=fresh(true);await recoverCandidateReview(owned,{file:original()},deps);owned=fresh(true);
                    try{await recoverCandidateReview(owned,{file:original()},deps);}catch(error){status=errorCode(error);}
                    passed=details.durableAttempts===2&&status==='recovery_task_budget_exhausted'&&await db.count(DATASET_COMMITS_STORE)===0;
                }
            }
        }catch(error){passed=false;status=errorCode(error);}
        finally{
            signal.removeEventListener('abort',abort);extra?.prep.task.close('cancelled');if(f&&lease)finishRun(f.root,lease);if(f&&extra)finishRun(f.root,extra.lease);f?.cleanup();client.retireSession();
            for(const owner of cleanupOwners)try{await(await(await rootDirectory()).getDirectoryHandle(RETAINED_DATA_ROOT)).removeEntry(await sha256Bytes(new TextEncoder().encode(owner)),{recursive:true});}catch{/* Only captured qualification namespaces are removed. */}
            db.close();await deleteDB(name);
        }
        const observation={id:mode,passed,status,elapsedMs:Math.round(performance.now()-started),details};observations.push(observation);if(!signal.aborted)onObservation?.(observation);
    }}finally{signal.removeEventListener('abort',retire);client.retireSession();}
    return {passed:observations.length===modes.length&&observations.every(o=>o.passed)&&!signal.aborted,observations};
};

/** Isolated browser QA only. No UI action invokes this synthetic seed helper. */
export const prepareDatasetRecoveryUiSmoke=async(root:StoreApi,mode:'ready'|'pending'|'rollback'='ready')=>{
    const sessionId=createAndStoreTabSessionId(),fixture=await prepareCandidateCommitFixture({root,sessionId});
    root.setState({currentView:'analysis_dashboard',initialAnalysisStatus:'ready',chatLifecycleState:'idle',isBusy:false});
    let store=fixture.store,prep=fixture.prep,candidate=fixture.candidate;
    if(mode==='rollback'){
        prep.task.close('blocked');finishRun(root,fixture.lease);
        const first=await stageRecoveryQualificationCandidate(root,'multi');store=first.store;prep=first.prep;candidate=first.candidate;
    }
    const service=createCandidateCommitService(store),review=await service.review(candidate.candidateId,{primaryTable:'facts',idempotencyKey:`ui-intent-${crypto.randomUUID()}`});
    if(mode==='pending'){
        const {requestPiCandidateApproval}=await import('../agent/runtime/pi/piCandidateApproval');
        const pending=await requestPiCandidateApproval(store,candidate.candidateId,'facts');
        // A reload will retain the durable checkpoint and discard this unsealed live locator.
        root.setState({pendingClarification:pending});prep.task.close('blocked');finishRun(root,store.executionContext!.lease);
    }else{
        const result=await service.commit(service.approve(review));if(result.status!=='committed'||result.acknowledgement!=='installed')throw new Error('ui_seed_commit_failed');
        prep.task.close('completed');finishRun(root,store.executionContext!.lease);
        if(mode==='rollback'){
            const next=await stageRecoveryQualificationCandidate(root,'names'),second=createCandidateCommitService(next.store);
            const exact=await second.review(next.candidate.candidateId,{primaryTable:'names',idempotencyKey:`ui-next-${crypto.randomUUID()}`});
            const secondResult=await second.commit(second.approve(exact));if(secondResult.status!=='committed'||secondResult.acknowledgement!=='installed')throw new Error('ui_seed_commit_failed');
            next.prep.task.close('completed');finishRun(root,next.lease);
        }
    }
    root.setState({activeAgentTask:null,isBusy:false,chatLifecycleState:'idle',pendingClarification:null,currentView:mode==='pending'?'file_upload':'analysis_dashboard'});
    return {caseName:'ca134-ui-seed',sessionId,mode,commit:root.getState().datasetBundle?.acceptedCommit,
        checkpoint:root.getState().candidateRecovery?.checkpointId};
};
