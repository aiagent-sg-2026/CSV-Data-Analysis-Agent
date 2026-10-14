import type { StoreApi } from '../agent/types';
import { assertRunActive, canCommitRun, rootStore } from '../session/sessionOwnership';
import type { CandidateRecoveryCheckpoint } from './datasetRecoveryContract';
import type { DatasetCommitMarker } from '../../types/datasetCommit';
import { DATASET_COMMITS_STORE, commitHeadKey, commitIntentKey, commitApprovalKey } from '../../types/datasetCommit';
import { getStorageDatabase } from '../storageService';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { reconstructDatasetCommit, verifyReplayManifest, type RecoveryOptions } from './datasetRecovery';
import { readExactCommit, installVerifiedDatasetCommit, type RecoveryDependencies } from './datasetRecoveryActions';
import { readRetainedRows } from '../persistence/datasetRetention';
import { persistCurrentAppSessionSnapshot, queueSessionWrite } from '../persistence/currentSessionPersistence';
import { buildPersistedReportRecord } from '../persistence/persistedAppState';
import { datasetCommitBindings } from '../persistence/datasetCommitProjection';
import { commitDatasetTransaction } from '../persistence/datasetCommitStorage';
import { restoreAgentTask } from '../agent/runtime/pi/piTaskContract';
import { DEFAULT_TASK_LIMITS, chargeTaskBudget, pauseTaskBudget, resumeTaskBudget } from '../agent/runtime/pi/piTaskBudget';
import { buildBuiltinToolRegistry, resolveAllowedTools } from '../agent/tools/toolRegistry';
import { buildToolAvailabilityContext } from '../agent/tools/toolGovernance';

const own = (store: StoreApi) => { const lease = store.executionContext?.lease; if (!lease) throw new Error('scope_revoked'); assertRunActive(store, lease); return lease; };
const policy = (store: StoreApi) => {
    const s = store.getState(), allowed = resolveAllowedTools(buildBuiltinToolRegistry(s.columnProfiles?.map(c => c.name) ?? []),
        buildToolAvailabilityContext(s,{hasCsvData:Boolean(s.datasetBundle)}));
    if (!allowed.decisions['data.mutate']?.allowed) throw new Error('capability_unavailable'); return JSON.stringify(s.settings.runtimeAccessControl);
};
const checkpointDigest = (checkpoint: Omit<CandidateRecoveryCheckpoint, 'digest'>) => codeDigest(checkpoint);
const verifyCheckpoint = async (checkpoint: CandidateRecoveryCheckpoint) => {
    const { digest, ...body } = checkpoint;
    if (body.version !== 1 || await checkpointDigest(body) !== digest || !/^candidate-recovery-[a-f0-9-]{36}$/.test(body.checkpointId)
        ||!Number.isSafeInteger(body.repetitions) || body.repetitions < 0
        || body.repetitions > 2 || typeof body.failureKey !== 'string'||body.failureKey!==''&&!/^[a-f0-9]{64}$/.test(body.failureKey)) throw new Error('recovery_checkpoint_invalid');
    const task = restoreAgentTask(body.task);
    if (task.status !== 'awaiting_approval' || task.capabilityGrants.length || task.taskId !== body.proposal.audit.taskId
        ||task.sessionId!==body.proposal.sessionId||task.revision!==body.proposal.audit.taskRevision
        ||task.scope.digest!==body.proposal.validation.scopeDigest||task.goal!==body.proposal.replayManifest?.validationBinding.goal
        ||JSON.stringify(task.inputBindings)!==JSON.stringify(body.proposal.inputBindings)
        || Object.entries(task.budget.limits).some(([key, value]) => value > DEFAULT_TASK_LIMITS[key as keyof typeof DEFAULT_TASK_LIMITS])) throw new Error('recovery_checkpoint_invalid');
    await verifyReplayManifest(body.proposal); return task;
};
export interface RecoveredCandidateReview { reviewId: string; digest: string; expiresAt: number; checkpointId: string;
    tables: Array<{ name: string; rowCount: number; columns: string[] }> }
type Prepared = { owner: StoreApi['getState']; scope: object; runId: string; checkpoint: CandidateRecoveryCheckpoint;
    result: Awaited<ReturnType<typeof reconstructDatasetCommit>>; policy: string };
const reviews = new WeakMap<RecoveredCandidateReview, Prepared>();

/** Interrupted approval is metadata only. Explicit revalidation produces a new exact review. */
export const recoverCandidateReview = async (store: StoreApi, options: RecoveryOptions = {}, dependencies: RecoveryDependencies = {}):
    Promise<{ status: 'review'; review: RecoveredCandidateReview } | { status: 'already_committed'; marker: DatasetCommitMarker }> => {
    const lease = own(store); let checkpoint = store.getState().candidateRecovery;
    if (!checkpoint) throw new Error('recovery_checkpoint_unavailable');
    const db = await (dependencies.database ?? getStorageDatabase)(); own(store);
    const saved=await db.get('reports',lease.scope.sessionId);own(store);
    const canonical=saved?.appState.candidateRecovery;
    if(canonical?.checkpointId===checkpoint.checkpointId&&canonical.digest!==checkpoint.digest){
        if(canonical.proposal.program.sha256!==checkpoint.proposal.program.sha256||canonical.proposal.validation.outputDigest!==checkpoint.proposal.validation.outputDigest)throw new Error('recovery_checkpoint_invalid');
        const dimensions=Object.keys(checkpoint.task.budget.used) as Array<keyof typeof checkpoint.task.budget.used>;
        const savedHigher=dimensions.some(k=>canonical.task.budget.used[k]>checkpoint!.task.budget.used[k]);
        const liveHigher=dimensions.some(k=>canonical.task.budget.used[k]<checkpoint!.task.budget.used[k]);
        if(savedHigher&&liveHigher)throw new Error('recovery_checkpoint_conflict');
        if(savedHigher||!liveHigher&&canonical.repetitions>=checkpoint.repetitions){checkpoint=canonical;store.setState({candidateRecovery:canonical});}
    }
    const task = await verifyCheckpoint(checkpoint); own(store); const capturedPolicy = policy(store);
    // A successful read is required. A failed journal read must never be treated as absence.
    const durable = await db.get(DATASET_COMMITS_STORE, checkpoint.proposal.recordId); own(store);
    if (durable) {
        if (durable.kind !== 'commit' || durable.program.sha256 !== checkpoint.proposal.program.sha256
            || durable.validation.outputDigest !== checkpoint.proposal.validation.outputDigest) throw new Error('idempotency_conflict');
        const head = await db.get(DATASET_COMMITS_STORE, commitHeadKey(durable.sessionId)); own(store);
        if (head?.kind !== 'head') throw new Error('commit_marker_invalid');
        const current = await readExactCommit(db, { sessionId: head.sessionId, commitId: head.commitId, revision: head.revision }); own(store);
        const result = await reconstructDatasetCommit(store, current, { ...options, readParent: ref => readExactCommit(db, ref), readMaterial: m => readRetainedRows(db, m, dependencies.directory) }); own(store);
        store.setState({ datasetBundle: structuredClone(current.bundle), candidateRecovery: null, datasetCommitBindingStatus: 'awaiting_source' });
        await installVerifiedDatasetCommit(store, db, current, result, dependencies); return { status: 'already_committed', marker: current };
    }
    const head = await db.get(DATASET_COMMITS_STORE, commitHeadKey(checkpoint.proposal.sessionId)); own(store);
    if (head && (head.kind !== 'head' || head.commitId !== checkpoint.proposal.parentCommitId)) throw new Error('input_version_changed');
    if (JSON.stringify(datasetCommitBindings(store.getState().datasetBundle!)) !== JSON.stringify(checkpoint.proposal.inputBindings)) throw new Error('input_version_changed');
    if (checkpoint.repetitions >= 2) throw new Error('recovery_no_progress');
    let activeCharge = 5000, cursor: DatasetCommitMarker | undefined = checkpoint.proposal, depth = 0;
    while (cursor) {
        if (++depth > 17) throw new Error('recovery_chain_capacity');
        const manifest = await verifyReplayManifest(cursor); own(store);
        activeCharge += Number((cursor.environment.limits as { timeoutMs: number }).timeoutMs) + 5000;
        cursor = manifest.parent ? await readExactCommit(db, manifest.parent) : undefined; own(store);
    }
    const charged = chargeTaskBudget(resumeTaskBudget(task.budget), { transformationAttempts: 1, toolCalls: 2, activeMs: activeCharge });
    if (!charged.accepted) throw new Error('recovery_task_budget_exhausted');
    const { digest: _digest, ...body } = checkpoint;
    const chargedBody = { ...body, task: { ...task, budget: pauseTaskBudget(charged.budget) } };
    const next = { ...chargedBody, digest: await checkpointDigest(chargedBody) }; own(store);
    store.setState({ candidateRecovery: next });
    if (!await (dependencies.persist?.(store) ?? persistCurrentAppSessionSnapshot(store.getState(), { store, scope: lease.scope }))) throw new Error('recovery_checkpoint_unavailable'); own(store);
    let result: Prepared['result'];
    try {
        result = await reconstructDatasetCommit(store, checkpoint.proposal, { ...options, deadline: Date.now() + activeCharge,
            readParent: ref => readExactCommit(db, ref), readMaterial: m => readRetainedRows(db, m, dependencies.directory) }); own(store);
    } catch (error) {
        if (canCommitRun(store, lease)) {
            const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'recovery_execution_failed';
            const key = await codeDigest([checkpoint.proposal.program.sha256, reason]); own(store);
            const { digest: _chargedDigest, ...failed } = next;
            const failedBody = { ...failed, failureKey: key, repetitions: checkpoint.failureKey === key ? checkpoint.repetitions + 1 : 1 };
            store.setState({ candidateRecovery: { ...failedBody, digest: await checkpointDigest(failedBody) } }); own(store);
            await (dependencies.persist?.(store) ?? persistCurrentAppSessionSnapshot(store.getState(), { store, scope: lease.scope }));
        }
        throw error;
    }
    const reviewBody = { reviewId: `recovery-review-${crypto.randomUUID()}`, checkpointId: checkpoint.checkpointId, expiresAt: Date.now() + 300_000,
        tables: checkpoint.proposal.bundle.tables.map(t => ({ name: t.name, rowCount: t.rowCount, columns: t.schema.map(c => c.name) })) };
    const review = Object.freeze({ ...reviewBody, digest: await codeDigest({ ...reviewBody, checkpoint: next.digest, policy: capturedPolicy }) }); own(store);
    reviews.set(review, { owner: rootStore(store).getState, scope: lease.scope, runId: lease.runId, checkpoint: next, result, policy: capturedPolicy });
    return { status: 'review', review };
};

export const commitRecoveredCandidate = async (store: StoreApi, review: RecoveredCandidateReview, dependencies: RecoveryDependencies = {}) => {
    const lease = own(store), prepared = reviews.get(review);
    if (!prepared || prepared.owner !== rootStore(store).getState || prepared.scope !== lease.scope || prepared.runId === lease.runId
        || Date.now() >= review.expiresAt || store.getState().candidateRecovery?.digest !== prepared.checkpoint.digest || prepared.policy !== policy(store)) throw new Error('approval_invalid');
    const db = await (dependencies.database ?? getStorageDatabase)(); own(store);
    const proposal = prepared.checkpoint.proposal, sessionId = lease.scope.sessionId;
    const key = commitIntentKey(sessionId, proposal.idempotencyKey), existing = await db.get(DATASET_COMMITS_STORE, key); own(store);
    if (existing) {
        if (existing.kind !== 'commit' || existing.validation.outputDigest !== proposal.validation.outputDigest || existing.program.sha256 !== proposal.program.sha256) throw new Error('idempotency_conflict');
        await installVerifiedDatasetCommit(store, db, existing, prepared.result, dependencies); return existing;
    }
    const inputsUnchanged = () => {
        const bundle = store.getState().datasetBundle;
        if (!bundle || JSON.stringify(datasetCommitBindings(bundle)) !== JSON.stringify(proposal.inputBindings)) throw new Error('input_version_changed');
    };
    inputsUnchanged();
    const head = await db.get(DATASET_COMMITS_STORE, commitHeadKey(sessionId)); own(store);
    if (head && (head.kind !== 'head' || head.commitId !== proposal.parentCommitId)) throw new Error('input_version_changed');
    const commitId = `commit-${crypto.randomUUID()}`, approvalId = `approval-${crypto.randomUUID()}`, now = new Date().toISOString(), revision = head?.kind === 'head' ? head.revision + 1 : 1;
    const bundle = { ...structuredClone(proposal.bundle), acceptedCommit: { sessionId, commitId, revision }, updatedAt: now };
    const { digest: _oldManifestDigest, ...oldManifest } = proposal.replayManifest!;
    const manifestBody = { ...oldManifest, validationBinding: { ...oldManifest.validationBinding, sessionId, sessionEpoch: lease.scope.epoch } };
    const manifest = { ...manifestBody, digest: await codeDigest(manifestBody) }; own(store);
    const { receiptDigest: _oldReceiptDigest, ...oldValidation } = proposal.validation;
    const validationBody = { ...oldValidation, candidateId: `candidate-${crypto.randomUUID()}`, validationId: `validation-${crypto.randomUUID()}`,
        namespaceId: `recovery-${crypto.randomUUID()}`, taskRevision: prepared.checkpoint.task.revision + 1, sessionId, sessionEpoch: lease.scope.epoch,
        runId: lease.runId, turnId: lease.turnId, toolCallId: `host-recovery-${crypto.randomUUID()}`, stepId: `recovery-${crypto.randomUUID()}`,
        contractDigest: await codeDigest(manifest.validationBinding) };
    const validation = { ...validationBody, receiptDigest: await codeDigest(validationBody) }; own(store);
    const committedBudget=chargeTaskBudget(resumeTaskBudget(prepared.checkpoint.task.budget),{toolCalls:1});
    if(!committedBudget.accepted)throw new Error('recovery_task_budget_exhausted');
    const marker: DatasetCommitMarker = { ...structuredClone(proposal), sessionId, commitId, revision,
        taskBudget:committedBudget.budget,
        recordId: key, intentKey: key, approvalKey: commitApprovalKey(sessionId, approvalId), parentCommitId: head?.kind === 'head' ? head.commitId : null,
        bundle, replayManifest: manifest, validation, candidateId: validation.candidateId,
        payloadDigest: await codeDigest({ checkpoint: prepared.checkpoint.digest, review: review.digest, sessionId, commitId }),
        audit: { ...proposal.audit, sessionEpoch: lease.scope.epoch, taskRevision: validation.taskRevision, runId: lease.runId, turnId: lease.turnId,
            toolCallId: validation.toolCallId, stepId: validation.stepId, grantDigest: await codeDigest({ kind: 'host-local-recovery', scope: lease.scope, runId: lease.runId, review: review.digest }), committedAt: now },
        previousCommit:manifest.inputBundle.acceptedCommit,
        approval: { approvalId, reviewDigest: review.digest, approvedAt: Date.now(), expiresAt: review.expiresAt, consumedAt: Date.now() } }; own(store);
    let admitted = false;
    try {
        await queueSessionWrite(async () => {
            own(store);
            return commitDatasetTransaction(db, marker, buildPersistedReportRecord(store.getState(), { id: sessionId, filename: bundle.source.fileName }),
                () => { own(store); inputsUnchanged(); if (store.getState().candidateRecovery?.digest !== prepared.checkpoint.digest || prepared.policy !== policy(store)) throw new Error('approval_invalid'); },
                () => { admitted = true; store.setState({ datasetCommitBindingStatus: 'commit_unknown', activeDataQuery: null, datasetSemanticSnapshot: null }); });
        });
    } catch (error) {
        if (!admitted) throw error;
        let durable;
        try { durable = await db.get(DATASET_COMMITS_STORE, key); } catch { throw new Error('commit_outcome_unknown'); }
        if (durable?.kind !== 'commit' || durable.payloadDigest !== marker.payloadDigest) throw new Error('recovery_not_committed');
    }
    own(store); await installVerifiedDatasetCommit(store, db, marker, prepared.result, dependencies); return marker;
};
