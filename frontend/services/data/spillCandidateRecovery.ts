import type { StoreApi } from '../agent/types';
import type { CandidateRecoveryCheckpoint } from './datasetRecoveryContract';
import type { RecoveryOptions } from './datasetRecovery';
import type { RecoveryDependencies } from './datasetRecoveryActions';
import { restoreAcceptedDataset } from './datasetRecoveryActions';
import type { RecoveredCandidateReview } from './candidateRecovery';
import { verifyAcceptedSpillMarker } from './acceptedSpill';
import { SOURCE_STREAM_LIMITS,seedRecoveredSourceStreamBudget } from '../agent/execution/codeSourceRecordStream';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { assertRunActive,rootStore } from '../session/sessionOwnership';
import { bindRecoverySource } from './immutableCsvSource';
import { bindSpillCandidateValidationContract } from './spillCandidateValidation';
import { preparePiExecutor } from '../agent/runtime/pi/piExecutorPreparation';
import { createCandidateCommitService } from './candidateCommit';
import { restoreAgentTask } from '../agent/runtime/pi/piTaskContract';
import { chargeTaskBudget,pauseTaskBudget,resumeTaskBudget,DEFAULT_TASK_LIMITS } from '../agent/runtime/pi/piTaskBudget';
import { persistCurrentAppSessionSnapshot } from '../persistence/currentSessionPersistence';
import { datasetCommitBindings } from '../persistence/datasetCommitProjection';
import { commitHeadKey,commitIntentKey } from '../../types/datasetCommit';
import { getStorageDatabase } from '../storageService';

type Entry={service:ReturnType<typeof createCandidateCommitService>;exact:import('./candidateCommit').CandidateCommitReview;capsule:object;
    owner:StoreApi['getState'];scope:object;runId:string;checkpointDigest:string;goal:string;continuation:import('../agent/runtime/pi/piCodingTask').PiTaskContinuation};
const reviews=new WeakMap<RecoveredCandidateReview,Entry>();
const own=(store:StoreApi)=>{const lease=store.executionContext?.lease;if(!lease)throw new Error('scope_revoked');assertRunActive(store,lease);return lease;};
/** A saved spill proposal supplies no custody or grant. Reattach + independently re-execute + revalidate
 * through the real task adapter before creating a NEW live exact service review. Old scratch is never promoted.
 */
export const recoverSpillCandidate=async(store:StoreApi,checkpoint:CandidateRecoveryCheckpoint,options:RecoveryOptions,dependencies:RecoveryDependencies)=>{
    const lease=own(store),{digest,...body}=checkpoint,proposal=checkpoint.proposal,task=restoreAgentTask(checkpoint.task);
    if(await codeDigest(body)!==digest||checkpoint.version!==1||checkpoint.repetitions>=2||task.status!=='awaiting_approval'
        ||task.capabilityGrants.length||task.taskId!==proposal.audit.taskId||task.revision!==proposal.audit.taskRevision
        ||task.scope.digest!==proposal.validation.scopeDigest||JSON.stringify(task.inputBindings)!==JSON.stringify(proposal.inputBindings)
        ||Object.entries(task.budget.limits).some(([k,v])=>v>DEFAULT_TASK_LIMITS[k as keyof typeof DEFAULT_TASK_LIMITS]))throw new Error('recovery_checkpoint_invalid');
    const manifest=await verifyAcceptedSpillMarker(proposal,true);own(store);
    const {digest:_manifestDigest,...manifestBody}=manifest;
    if(await codeDigest(manifestBody)!==manifest.digest)throw new Error('accepted_manifest_invalid');
    own(store);const db=await (dependencies.database??getStorageDatabase)();own(store);
    const durable=await db.get('dataset_commits',commitIntentKey(proposal.sessionId,proposal.idempotencyKey));own(store);
    if(durable){
        if(durable.kind!=='commit'||durable.activationFailed||durable.payloadDigest!==proposal.payloadDigest)throw new Error('approval_consumed');
        const marker=await restoreAcceptedDataset(store,options,dependencies);return {status:'already_committed' as const,marker};
    }
    const head=await db.get('dataset_commits',commitHeadKey(proposal.sessionId));own(store);
    if(head&&(head.kind!=='head'||head.commitId!==proposal.parentCommitId)
        ||JSON.stringify(datasetCommitBindings(store.getState().datasetBundle!))!==JSON.stringify(proposal.inputBindings)
        ||JSON.stringify(store.getState().datasetBundle?.source.inspection)!==JSON.stringify(manifest.source))throw new Error('input_version_changed');
    if(!options.file)throw new Error('recovery_source_unavailable');
    const sourceSignature=JSON.stringify(store.getState().datasetBundle),current=()=>{own(store);if(JSON.stringify(store.getState().datasetBundle)!==sourceSignature)throw new Error('input_version_changed');};
    // Reserve bounded work BEFORE reading source or creating a new runtime. Failures cannot reset the budget.
    const charge=chargeTaskBudget(resumeTaskBudget(task.budget),{transformationAttempts:1,toolCalls:2,activeMs:5000});
    if(!charge.accepted)throw new Error('recovery_task_budget_exhausted');
    const previousBudget=checkpoint.spillSourceBudget??manifest.sourceBudget;
    if(previousBudget.readBytes+manifest.source.byteSize*4>SOURCE_STREAM_LIMITS.cumulativeReadBytes
        ||previousBudget.attempts>=SOURCE_STREAM_LIMITS.attempts||previousBudget.activeMs>=SOURCE_STREAM_LIMITS.activeMs
        ||previousBudget.steps>=SOURCE_STREAM_LIMITS.steps)throw new Error('source_stream_budget_exhausted');
    // Unknown interruption reserves the full remaining time/step allowance. A completed new checkpoint
    // replaces this reservation with the actual metered floor; a crash cannot reset a partial attempt.
    const chargedBody={...body,repetitions:checkpoint.repetitions+1,task:{...task,budget:pauseTaskBudget(charge.budget)},
        spillSourceBudget:{attempts:previousBudget.attempts+1,readBytes:previousBudget.readBytes+manifest.source.byteSize*4,
            activeMs:SOURCE_STREAM_LIMITS.activeMs,steps:SOURCE_STREAM_LIMITS.steps}};
    const charged={...chargedBody,digest:await codeDigest(chargedBody)};current();store.setState({candidateRecovery:charged});
    if(!await (dependencies.persist?.(store)??persistCurrentAppSessionSnapshot(store.getState(),{store,scope:lease.scope})))throw new Error('recovery_checkpoint_unavailable');current();
    seedRecoveredSourceStreamBudget(store,manifest.source,{...previousBudget,readBytes:previousBudget.readBytes+manifest.source.byteSize});
    await bindRecoverySource(store,options.file,manifest.source);current();
    rootStore(store).candidateValidationContract=await bindSpillCandidateValidationContract(store,task.goal,manifest.meaning);current();
    const prep=await preparePiExecutor(store,{entryPoint:'follow_up',goal:task.goal,guest:options.guest,recoveryBudget:{...charged.task.budget,used:{...charged.task.budget.used,transformationAttempts:task.budget.used.transformationAttempts,toolCalls:task.budget.used.toolCalls+1}},spillFactory:dependencies.spillFactory});
    try{
        const program=await store.codeExecution!.workspace.write('/workspace/recovered-spill.js',proposal.program.content,0);
        const request={program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],mode:'source_records' as const,
            sourceRecords:{sourceId:manifest.source.sourceId,sha256:manifest.source.sha256,width:manifest.meaning.columns.length,initialState:structuredClone(proposal.spillRunRequest!.sourceRecords!.initialState)},
            output:{path:'/workspace/recovered-spill.json',expectedRevision:0,format:'json' as const}};
        const context={lease,toolCallId:'spill-recovery-code',stepId:'spill-recovery-code'};
        await prep.task.beforeTool('code.run',request,context.toolCallId);
        const execution=await store.codeExecution!.run(request,context);current();
        prep.task.afterTool('code.run',{status:'success',toolName:'code.run',message:execution.reasonCode,shouldStop:false,artifacts:{codeExecution:execution}},context);
        if(execution.status!=='succeeded')throw new Error(execution.reasonCode);
        const c=await store.candidateStaging!.stage(execution.jobId,{lease,toolCallId:'spill-recovery-stage',stepId:'spill-recovery-stage'});
        const v=await store.candidateStaging!.validate(c.candidateId,{lease,toolCallId:'spill-recovery-validate',stepId:'spill-recovery-validate'});current();
        if(v.decision!=='validated')throw new Error('recovery_validation_failed');
        prep.task.afterTool('candidate.validate',{status:'success',toolName:'candidate.validate',message:'Independently revalidated recovered spill.',shouldStop:false,artifacts:{candidate:{candidateId:c.candidateId}}},{lease,toolCallId:'spill-recovery-validate',stepId:'spill-recovery-validate'});
        const service=createCandidateCommitService(store,{database:dependencies.database,acceptedStorage:dependencies.acceptedStorage,prepareSpillBinding:dependencies.prepareSpillBinding});
        const exact=await service.review(c.candidateId,{idempotencyKey:`recovered-${crypto.randomUUID()}`,primaryTable:manifest.meaning.table});
        const next=await service.recoveryCheckpoint(exact);store.setState({candidateRecovery:next});
        if(!await (dependencies.persist?.(store)??persistCurrentAppSessionSnapshot(store.getState(),{store,scope:lease.scope})))throw new Error('recovery_checkpoint_unavailable');
        const capsule=service.suspend(exact),pending=prep.task.suspend({question:'Fresh recovered spill exact review',interactionKind:'approval',options:[]});
        store.setState({activeAgentTask:prep.task.snapshot});
        const review:RecoveredCandidateReview=Object.freeze({reviewId:exact.reviewId,digest:exact.reviewDigest,expiresAt:exact.expiresAt,checkpointId:next.checkpointId,tables:exact.tables,exact});
        reviews.set(review,{service,exact,capsule,owner:rootStore(store).getState,scope:lease.scope,runId:lease.runId,checkpointDigest:next.digest,
            goal:task.goal,continuation:pending.resumeContext!.piTaskContinuation!});
        return {status:'review' as const,review};
    }finally{prep.task.close('blocked');}
};
export const isLiveRecoveredSpill=(review:RecoveredCandidateReview)=>reviews.has(review);
export const commitRecoveredSpill=async(store:StoreApi,review:RecoveredCandidateReview)=>{
    const lease=own(store),entry=reviews.get(review);
    if(!entry||entry.owner!==rootStore(store).getState||entry.scope!==lease.scope||entry.runId===lease.runId
        ||store.getState().candidateRecovery?.digest!==entry.checkpointDigest||Date.now()>=review.expiresAt)throw new Error('approval_invalid');
    reviews.delete(review);
    const prep=await preparePiExecutor(store,{entryPoint:'follow_up',goal:entry.goal,continuation:entry.continuation});
    try{
        await prep.task.beforeTool('candidate.commit',{},`recovered-${entry.exact.reviewId}`);
        entry.service.resume(entry.capsule,store);
        const outcome=await entry.service.commit(entry.service.approve(entry.exact));own(store);
        if(outcome.status!=='committed'||outcome.acknowledgement!=='installed')throw new Error(outcome.reason??'committed_dataset_not_bound');
        prep.task.committed();return outcome.marker!;
    }finally{prep.task.close('completed');}
};
