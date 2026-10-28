import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { ClarificationOption, ClarificationRequest } from '../../../../types';
import type { StoreApi } from '../../types';
import type { PiFollowUpRequest, PiFollowUpResult } from './piFollowUpRuntimeService';
import type { ResolvedAnswerScope } from './queryEvidence';
import { createCandidateCommitService, type CandidateCommitReview } from '../../../data/candidateCommit';
import { assertRunActive, awaitOwned, registerSessionResource, rootStore } from '../../../session/sessionOwnership';
import { createChatMessage } from '../../../../utils/messageState';
import { finalizeRuntimeOutcome } from '../runtimeFinalize';
import { markTurnWaitingForClarification } from '../runtimeState';
import { persistCurrentAppSessionSnapshot } from '../../../persistence/currentSessionPersistence';
import { publishPiCandidateReview, retirePiCandidateReview } from './piCandidateReviewState';

type Service = ReturnType<typeof createCandidateCommitService>;
type Entry = { lease: NonNullable<StoreApi['executionContext']>['lease']; taskId: string; service: Service; review: CandidateCommitReview; capsule: object; pending: ClarificationRequest;
    initial?: (store:StoreApi,marker:import('../../../../types/datasetCommit').DatasetCommitMarker,stream?:StreamFn)=>Promise<import('./initialAnalysisTypes').InitialAnalysisRunOutcome>;
    request?: PiFollowUpRequest; history?: AgentMessage[]; scope?: ResolvedAnswerScope; stream?: StreamFn; sealed: boolean; unregister?: () => void };
const entries = new WeakMap<StoreApi['getState'], Entry>();
const copy = <T>(value: T): T => structuredClone(value);
const removeEntry = (key: StoreApi['getState'], entry: Entry) => {
    retirePiCandidateReview(key, entry.review.reviewId);
    entry.unregister?.();
    if (entries.get(key) === entry) entries.delete(key);
};

/** Only the live host capsule carries authority. Persisted review references require a new review after reload. */
export const requestPiCandidateApproval = async (store: StoreApi, candidateId: string, primaryTable: string): Promise<ClarificationRequest> => {
    const lease = store.executionContext?.lease;
    if (!lease || !store.piTask) throw new Error('approval_invalid');
    assertRunActive(store, lease);
    const key = rootStore(store).getState;
    const previous=entries.get(key);
    if(previous&&previous.taskId!==store.piTask.snapshot.taskId)removeEntry(key,previous);
    if (entries.has(key)) throw new Error('approval_already_pending');
    const service = createCandidateCommitService(store);
    const review = await service.review(candidateId, {primaryTable, idempotencyKey:`intent-${crypto.randomUUID()}`});
    assertRunActive(store, lease);
    const checkpoint = await service.recoveryCheckpoint(review); assertRunActive(store, lease);
    store.setState({candidateRecovery:checkpoint});
    if (!await persistCurrentAppSessionSnapshot(store.getState(),{store,scope:lease.scope})) throw new Error('recovery_checkpoint_unavailable');
    assertRunActive(store, lease);
    const capsule = service.suspend(review);
    const inference=store.candidateStaging?.validationRequirements().inference;
    const pending: ClarificationRequest = {interactionKind:'approval',allowFreeText:false,clarificationMode:'options',
        question:`Approve this exact validated dataset candidate?\nPrimary table: ${review.primaryTable}. ${review.tables.map(t=>`${t.name}: ${t.rowCount} rows`).join('; ')}.\n${inference?`AI-inferred semantics: ${inference.assumptions.join(' ')}\n`:''}Candidate: ${review.candidateId}\nReview: ${review.reviewDigest}\nProgram: ${review.programDigest}\nValidation: ${review.validationDigest}\nExpires: ${new Date(review.expiresAt).toISOString()}. ${review.acceptedStreamedDual ? `Approval atomically retains BOTH streamed tables (${review.acceptedStreamedDual.tables.map(t=>`${t.name}: ${t.rowCount} rows / ${t.bytes} bytes`).join('; ')}), source-bound implicit cell lineage, program and independent receipts. Keys/relationships: ${JSON.stringify(review.relationships)}. Grains/units: ${JSON.stringify(review.grains)}. Ordered source keys; no arbitrary joins or summary/detail summation. Meaning selection is NOT this exact Dataset Commit approval.` : review.acceptedDualGrain ? `Approval retains BOTH tables with source, program, independent receipts and lineage in local durable storage (${review.acceptedDualGrain.bytes} bytes). Keys/relationships: ${JSON.stringify(review.relationships)}. Grains/units: ${JSON.stringify(review.grains)}. Summary/excluded rows are evidence only. No joins or summary/detail summation. This is separate from meaning selection.` : review.spill?`Approved projected rows will be retained in immutable local backing (${review.spill.bytes} bytes). Source: ${review.spill.source.sha256}. Meaning/units: ${JSON.stringify(review.spill.meaning)}. Structural scratch alone is not approval.`:'Rows are transient by default; verified source reattachment or explicit local retention supports recovery.'}`,
        options:[{label:'Approve',value:'approve'},{label:'Deny',value:'deny'}],
        resumeContext:{piCandidateApproval:{reviewId:review.reviewId,reviewDigest:review.reviewDigest}}};
    const entry: Entry = {lease,taskId:store.piTask.snapshot.taskId,service,review,capsule,pending,sealed:false};
    entries.set(key,entry);
    entry.unregister=registerSessionResource(lease.scope,()=>removeEntry(key,entry));
    return pending;
};
export const pendingPiCandidateApproval = (store: StoreApi) => {
    const entry=entries.get(rootStore(store).getState);
    return entry?.lease===store.executionContext?.lease?entry?.pending:undefined;
};
export const discardPiCandidateApproval = (store: StoreApi) => {
    const key=rootStore(store).getState,entry=entries.get(key);
    if(entry?.lease===store.executionContext?.lease)removeEntry(key,entry);
};
export const sealPiCandidateApproval = (store: StoreApi, pending: ClarificationRequest, request: PiFollowUpRequest,
    history: AgentMessage[], scope: ResolvedAnswerScope, stream?: StreamFn,
    initial?:NonNullable<Entry['initial']>) => {
    const entry = entries.get(rootStore(store).getState);
    const ref=pending.resumeContext?.piCandidateApproval,continuation=pending.resumeContext?.piTaskContinuation,task=store.piTask?.snapshot;
    if (!entry || entry.sealed || entry.lease!==store.executionContext?.lease || !task || !continuation
        ||ref?.reviewId!==entry.review.reviewId||ref.reviewDigest!==entry.review.reviewDigest||pending.question!==entry.pending.question
        ||JSON.stringify(pending.options)!==JSON.stringify(entry.pending.options)||continuation.taskId!==task.taskId
        ||continuation.revision!==task.revision||continuation.scopeDigest!==task.scope.digest) throw new Error('approval_invalid');
    if(Boolean(initial)!==(entry.lease.kind==='initial_analysis'))throw new Error('approval_invalid');
    entry.initial=initial;entry.pending=copy(pending);entry.request=copy(request);entry.history=copy(history);entry.scope=copy(scope);entry.stream=stream;entry.sealed=true;
    publishPiCandidateReview(store, entry.lease, entry.review, entry.pending);
};

/** The live capsule, never a persisted/model discriminator, selects the fresh lease kind. */
export const piCandidateApprovalRunKind=(store:StoreApi,pending:ClarificationRequest):'initial_analysis'|'follow_up'=>{
    const e=entries.get(rootStore(store).getState),ref=pending.resumeContext?.piCandidateApproval;
    return e?.sealed&&e.initial&&ref?.reviewId===e.review.reviewId&&ref.reviewDigest===e.review.reviewDigest?'initial_analysis':'follow_up';
};

const stopApproval = (store: StoreApi, text: string): PiFollowUpResult => {
    const lease=store.executionContext!.lease;
    assertRunActive(store,lease);
    store.piTask?.rejectApproval();
    const turn=store.getState().activeTurn;
    if(turn)finalizeRuntimeOutcome({store,turn:{...markTurnWaitingForClarification(turn,null),lastObservation:{type:'clarification',status:'blocked',summary:text}},preserveActiveTurn:true,
        outcome:{runId:lease.runId,turnId:lease.turnId,sessionId:lease.scope.sessionId,outcomeKind:'blocked',lifecycleState:'waiting_for_clarification',stage:'finalizing',
            reason:'pi_candidate_approval_stopped',retryable:false,eventType:'turn_blocked',eventMessage:text,assistantMessage:text}});
    store.setState({isBusy:false,chatLifecycleState:'blocked'});
    if(lease.kind==='initial_analysis')store.setState({isGeneratingReport:false,initialAnalysisStatus:'paused',initialAnalysisFailureKind:'analysis'});
    if(!turn) store.setState(prev=>({isBusy:false,chatLifecycleState:'blocked',chatHistory:[...prev.chatHistory,createChatMessage({sender:'ai',type:'ai_message',text,timestamp:new Date()})]}));
    return {status:'blocked',appTurnId:lease.turnId!,text};
};

export const resumePiCandidateApproval = async (pending: ClarificationRequest, choice: ClarificationOption, store: StoreApi,
    streamOverride?: StreamFn): Promise<PiFollowUpResult> => {
    const lease=store.executionContext?.lease;
    if(!lease||!store.piTask)throw new Error('approval_requires_fresh_lease');
    assertRunActive(store,lease);
    const key=rootStore(store).getState,entry=entries.get(key),ref=pending.resumeContext?.piCandidateApproval;
    if(!entry?.sealed||lease.kind!==entry.lease.kind||!ref||ref.reviewId!==entry.review.reviewId||ref.reviewDigest!==entry.review.reviewDigest
        ||JSON.stringify(pending.resumeContext?.piTaskContinuation)!==JSON.stringify(entry.pending.resumeContext?.piTaskContinuation))throw new Error('approval_invalid');
    // Claim synchronously before any await. Duplicate clicks cannot consume the capsule twice.
    removeEntry(key,entry);
    store.setState(prev=>({pendingClarification:null,chatHistory:[...prev.chatHistory,createChatMessage({sender:'user',type:'user_message',
        text:`Dataset candidate review: ${choice.label}`,clarificationSelection:choice,timestamp:new Date()})]}));
    if(choice.value==='deny'){store.setState({candidateRecovery:null});return stopApproval(store,'Candidate approval denied. Accepted data is unchanged.');}
    if(choice.value!=='approve')return stopApproval(store,'Invalid approval choice. Accepted data is unchanged.');
    let outcome;
    try {
        await store.piTask.beforeTool('candidate.commit',{},`approval-${entry.review.reviewId}`);
        entry.service.resume(entry.capsule,store);
        outcome=await awaitOwned(entry.service.commit(entry.service.approve(entry.review)),store,lease);
    } catch(error) {
        assertRunActive(store,lease);
        const reason=error instanceof Error&&/^[a-z_]+(?::[A-Za-z]+)?$/.test(error.message)?error.message:'approval_invalid';
        return stopApproval(store,`Candidate approval stopped: ${reason}. No new commit was admitted by this approval.`);
    }
    assertRunActive(store,lease);
    if(outcome.status!=='committed'||outcome.acknowledgement!=='installed')return stopApproval(store,
        `Candidate commit status: ${outcome.status}; ${outcome.acknowledgement??outcome.reason??'unavailable'}. Verification is blocked. Review durable commit state before retrying.`);
    store.piTask.committed();
    if(entry.initial){
        const result=await entry.initial(store,outcome.marker!,streamOverride??entry.stream);
        return {status:result.status==='degraded'?'completed':result.status,appTurnId:lease.turnId??lease.runId,
            text:result.error?.message??`Initial analysis ${result.status}. Current-version cards: ${result.trustedCardIds.length}.`};
    }
    const scope=entry.scope!.requiresEvidence?entry.scope!:{requiresEvidence:true,queries:[{role:'verification',plan:{aggregates:[{function:'count' as const,as:'RowCount'}]}}],complete:true,unresolved:[]};
    const {runPiFollowUpTurn}=await import('./piFollowUpRuntimeService');
    return runPiFollowUpTurn({...entry.request!,taskContinuation:undefined,continuation:{scope,history:entry.history!,commitId:outcome.marker!.commitId}},store,streamOverride??entry.stream);
};
