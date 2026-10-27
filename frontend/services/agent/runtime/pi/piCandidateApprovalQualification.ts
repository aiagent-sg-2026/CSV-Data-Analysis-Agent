import {deleteDB} from 'idb';
import Papa from 'papaparse';
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai';
import type {StreamFn} from '@earendil-works/pi-agent-core';
import type {CsvData} from '../../../../types';
import type {StoreApi} from '../../types';
import {prepareCandidateCommitFixture} from '../../../data/candidateCommitQualificationFixture';
import {createCandidateCommitService} from '../../../data/candidateCommit';
import {openStorageDatabase} from '../../../storageService';
import {DuckDbWorkerClient} from '../../../workers/duckDbWorkerClient';
import {getCsvDatasetLoadVersion} from '../../../../utils/datasetId';
import {beginRun,finishRun,scopeRunStore,beginSessionTransition,cancelOwnedRun} from '../../../session/sessionOwnership';
import {preparePiExecutor} from './piExecutorPreparation';
import {runPiFollowUpTurn} from './piFollowUpRuntimeService';
import type {PiLoopCheck} from './piCodingLoopQualification';
import {queueSessionWrite} from '../../../persistence/currentSessionPersistence';

export {qualifySourceStream} from '../../execution/codeSourceStreamQualification';
export {qualifySpillCandidate} from '../../execution/spillCandidateQualification';
import { prepareSpillCommitFixture } from '../../../data/spillCommitQualificationFixture';
export {restoreAcceptedDataset} from '../../../data/datasetRecoveryActions';
export {executeManagedDataQuery} from '../../../duckdb/queryEngine';
export {createCandidateCommitService} from '../../../data/candidateCommit';
export {preparePiInitialCodingUiSmoke} from './piInitialCodingQualification';
export {preparePiStructureRepairSmoke,queryPiStructureRepairSmoke} from './piStructureRepairQualification';
export {preparePiLargeCoordinatorSmoke} from './piLargeCoordinatorQualification';
export {executeEvaluationCase,executeEvaluationInitialProbe} from './piEvaluationRuntime';
export {runWeightedMedianDemoProbe} from './piWeightedMedianQualification';
export {runRepairComputationDemoProbe} from './piRepairComputationQualification';

const modes=['fresh-commit-query','deny','edited-program','edited-input','revoked-grant','edited-policy','active-run-rejection','late-rebind','stop-before-admission'] as const;
/** Public synthetic qualification. Private database/client keep the visible app's storage and worker binding untouched. */
export const qualifyPiCandidateApproval=async(signal:AbortSignal,onObservation?:(check:PiLoopCheck)=>void)=>{
    const observations:PiLoopCheck[]=[],client=new DuckDbWorkerClient();
    const retire=()=>client.retireSession();signal.addEventListener('abort',retire,{once:true});
    try{for(const mode of modes){
        if(signal.aborted)break;
        const started=performance.now(),name=`csv-agent-ca133-${crypto.randomUUID()}`,db=await openStorageDatabase(name);
        let fixture:Awaited<ReturnType<typeof prepareCandidateCommitFixture>>|undefined,prep:Awaited<ReturnType<typeof preparePiExecutor>>|undefined;
        let fresh:ReturnType<typeof beginRun>|undefined,passed=false,status='unavailable',details:Record<string,unknown>={};
        const release: Array<()=>void>=[];
        try{
            fixture=await prepareCandidateCommitFixture({signal});const f=fixture;
            const bind=async(data:CsvData | null,abortSignal?:AbortSignal)=>{
                if(!data)throw new Error('no_dataset');
                const binding={tableName:'session_clean_dataset',loadVersion:getCsvDatasetLoadVersion(data)};
                await client.initDuckDb(45000,abortSignal);await client.loadCleanDataset({...binding,csvText:Papa.unparse(data.data),csvFileName:data.fileName},45000,abortSignal);
                return {...binding,engine:'duckdb' as const,fallbackReason:null,fallbackStage:null};
            };
            const service=createCandidateCommitService(f.store,{database:async()=>db,bind:mode==='late-rebind'?async()=>{
                beginSessionTransition(f.root);f.root.setState({sessionId:'replacement',isBusy:true});beginRun(f.root,'follow_up','replacement-run','replacement-turn');
                return {engine:'duckdb',tableName:'retired',loadVersion:'retired',fallbackReason:null,fallbackStage:null};
            }:bind});
            const review=await service.review(f.candidate.candidateId,{primaryTable:'facts',idempotencyKey:`qualification-${mode}`}),capsule=service.suspend(review);
            const pending=f.prep.task.suspend({question:'Exact review',options:[],interactionKind:'approval'}),saved=f.prep.task.snapshot;
            f.prep.task.close('blocked');finishRun(f.root,f.lease);
            const released=f.root.getState().activeExecution===null;
            fresh=beginRun(f.root,'follow_up',`resume-${crypto.randomUUID()}`,'resume-turn');const owned=scopeRunStore(f.root,fresh);
            const stop=()=>cancelOwnedRun(f.root);signal.addEventListener('abort',stop,{once:true});release.push(()=>signal.removeEventListener('abort',stop));
            prep=await preparePiExecutor(owned,{entryPoint:'follow_up',goal:saved.goal,continuation:pending.resumeContext!.piTaskContinuation});
            service.resume(capsule,owned);
            if(mode==='deny'){prep.task.rejectApproval();passed=!f.root.getState().datasetBundle?.acceptedCommit;status='denied';}
            else if(mode==='active-run-rejection'){
                let rejected=false;try{beginRun(f.root,'follow_up','contender-run');}catch{rejected=true;}
                passed=rejected&&f.root.getState().activeExecution?.runId===fresh.runId;status='active_run_rejected';
            }else{
                if(mode==='edited-program')await owned.codeExecution!.workspace.write(f.program.path,'return 999;',f.program.revision);
                if(mode==='edited-input')f.root.getState().csvData!.data[0].Amount=7;
                if(mode==='revoked-grant')(f.store.codeExecution as unknown as {revoke:(id:string)=>void}).revoke(f.execution.grant!.id);
                if(mode==='edited-policy')f.root.setState({settings:{...f.root.getState().settings,runtimeAccessControl:{permissionMode:'open',toolOverrides:{'data.mutate':'deny'},workspaceRules:{deniedPathPrefixes:[]}}}});
                let outcome;
                if(['edited-program','edited-input','revoked-grant','edited-policy'].includes(mode)){
                    try{service.approve(review);}catch{passed=true;}status='approval_rejected';
                }else if(mode==='stop-before-admission'){
                    const approval=service.approve(review);let unblock!:()=>void;const gate=new Promise<void>(r=>unblock=r);release.push(unblock);
                    const ahead=queueSessionWrite(()=>gate),running=service.commit(approval);cancelOwnedRun(f.root);unblock();await ahead;outcome=await running;
                    passed=outcome.status==='not_committed'&&!outcome.admitted;status=outcome.status;
                }else{
                    outcome=await service.commit(service.approve(review));status=outcome.status;
                    if(mode==='late-rebind')passed=outcome.status==='committed'&&outcome.acknowledgement==='revoked'&&f.root.getState().activeExecution?.runId==='replacement-run'&&f.root.getState().isBusy===true;
                    else{
                        prep.task.committed();
                        const rows=await client.executeRawQuery({sql:'SELECT COUNT(*) n, SUM(TRY_CAST(Amount AS DOUBLE)) total FROM session_clean_dataset',selectedColumns:[],limit:10,
                            expectedBinding:{tableName:'session_clean_dataset',loadVersion:getCsvDatasetLoadVersion(f.root.getState().csvData!)}},10000,signal);
                        f.prep.task.close('cancelled');finishRun(f.root,f.lease);
                        passed=outcome.status==='committed'&&outcome.acknowledgement==='installed'&&Number(rows.rows[0]?.n)===2&&Number(rows.rows[0]?.total)===-5
                            &&f.root.getState().activeExecution?.runId===fresh.runId&&prep.task.snapshot.taskId===saved.taskId&&prep.task.snapshot.budget.used.transformationAttempts===1;
                        details={query:rows.rows,commit:outcome.marker,taskId:saved.taskId,resumedTaskId:prep.task.snapshot.taskId,oldRunId:f.lease.runId,freshRunId:fresh.runId,budget:prep.task.snapshot.budget};
                    }
                }
                if(outcome)details={...details,acknowledgement:outcome.acknowledgement,admitted:outcome.admitted};
            }
            passed&&=released;
        }catch(error){status=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'qualification_failed';}
        finally{release.forEach(fn=>fn());prep?.task.close('cancelled');if(fixture&&fresh)finishRun(fixture.root,fresh);fixture?.cleanup();client.retireSession();db.close();await deleteDB(name);}
        const observation={id:mode,passed,status,elapsedMs:Math.round(performance.now()-started),details};observations.push(observation);if(!signal.aborted)onObservation?.(observation);
    }}finally{signal.removeEventListener('abort',retire);client.retireSession();}
    return {passed:observations.length===modes.length&&observations.every(o=>o.passed)&&!signal.aborted,observations};
};

/** Synthetic large qualification invokes the same request/review/approve runtime and React UI as small candidates. */
export const prepareSpillApprovalUiSmoke=async(root:StoreApi,file:File,scale=0,columns?:Parameters<typeof prepareSpillCommitFixture>[0]['columns'])=>{
    const fixture=await prepareSpillCommitFixture({root,file,scale,columns});let turn=0;
    const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    const stream:StreamFn=model=>{
        const content:AssistantMessage['content']=turn++===0?[{type:'toolCall',name:'candidate_request_approval',id:crypto.randomUUID(),arguments:{candidateId:fixture.candidate.candidateId,primaryTable:'records'}}]
            :turn===2?[{type:'toolCall',name:'data_query',id:crypto.randomUUID(),arguments:{explanation:'Deterministic accepted-record verification, not a live AI answer.',plan:{aggregates:[{function:'count',as:'RowCount'}]}}}]
                :[{type:'text',text:'Synthetic accepted-record verification finished.'}];
        const reason=content.some(c=>c.type==='toolCall')?'toolUse':'stop',message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:reason,timestamp:Date.now()};
        const result=createAssistantMessageEventStream();result.push({type:'start',partial:message});result.push({type:'done',reason,message});return result;
    };
    const before={hasOutput:Boolean(fixture.prep.task.outputReceipt()),plan:fixture.prep.task.plan,scope:fixture.prep.task.snapshot.scope};
    const result=await runPiFollowUpTurn({message:fixture.prep.task.snapshot.goal},fixture.store,stream);
    return {...fixture,result,before,oldRunId:fixture.lease.runId};
};

/** Used only by browser QA in an isolated, synthetic app context; the caller controls that context's lifecycle. */
export const preparePiApprovalUiSmoke=async(root:StoreApi)=>{
    const fixture=await prepareCandidateCommitFixture({root});
    let turn=0;
    const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    const stream:StreamFn=(model)=>{
        const content:AssistantMessage['content']=turn++===0?[{type:'toolCall',name:'candidate_request_approval',id:crypto.randomUUID(),arguments:{candidateId:fixture.candidate.candidateId,primaryTable:'facts'}}]
            :turn===2?[{type:'toolCall',name:'data_query',id:crypto.randomUUID(),arguments:{explanation:'Verify committed rows.',plan:{aggregates:[{function:'count',as:'RowCount'}]}}}]
                :[{type:'text',text:'999, completed.'}];
        const reason=content.some(c=>c.type==='toolCall')?'toolUse':'stop',message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:reason,timestamp:Date.now()};
        const result=createAssistantMessageEventStream();result.push({type:'start',partial:message});result.push({type:'done',reason,message});return result;
    };
    const result=await runPiFollowUpTurn({message:fixture.prep.task.snapshot.goal},fixture.store,stream);
    return {result,taskId:fixture.prep.task.snapshot.taskId,oldRunId:fixture.lease.runId,budget:fixture.prep.task.snapshot.budget,cleanup:fixture.cleanup};
};
