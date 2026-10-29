import { captureOwnedPiTaskIdentity, isCurrentPiTaskIdentity } from './runtime/pi/piCodingTask';
import type { StoreApi } from './types';
import type { HeaderAlignmentCandidateV1 } from '../../types/headerAlignment';
import { captureSourceRangeFence } from '../data/immutableCsvSource';
import { isDualGrainCandidateMeaning, isDualGrainMeaningAlternatives, type DualGrainCandidateMeaning } from '../data/dualGrainCandidateMeaning';
import { assertSessionResourceActive, captureSessionScope, ownsRun, registerSessionResource, rootStore, type RunLease, type SessionScope } from '../session/sessionOwnership';

interface Continuation {
    reviewId: string;
    candidate: HeaderAlignmentCandidateV1;
    goal: string;
    check: () => void;
    lease: RunLease;
    taskOwner?: object;
    complete: () => void;
    stopped: (reason: string) => void;
    handoff?: { lease: RunLease; pending: string };
    revoked: boolean;
}
const continuations = new WeakMap<SessionScope, Continuation>();

/** Private header evidence narrows repair proposals, never grants meaning/validation/commit. */
export const installStructureRepairContinuation = (store: StoreApi, reviewId: string, candidate: HeaderAlignmentCandidateV1, goal: string, reviewCurrent: () => void, lease: RunLease, complete: () => void, stopped: (reason: string) => void = () => {}) => {
    const root = rootStore(store), scope = captureSessionScope(root), state = root.getState();
    const source = state.datasetBundle?.source.inspection;
    if (!source || !goal.trim()) throw new Error('repair_continuation_source_or_goal_required');
    const fence = captureSourceRangeFence(root, source.sourceId), sourceSignature = JSON.stringify(source);
    const intake = state.rawIntakeIr, intakeSignature = JSON.stringify(intake);
    const previous = continuations.get(scope);
    if (previous && !previous.revoked) throw new Error('repair_continuation_already_started');
    const entry: Continuation = { reviewId, candidate: structuredClone(candidate), goal, lease, complete, stopped, revoked: false, check: () => {
        assertSessionResourceActive(root, scope); fence(); reviewCurrent();
        const now = root.getState();
        if (entry.revoked || continuations.get(scope) !== entry || entry.taskOwner && !isCurrentPiTaskIdentity(root, entry.taskOwner) || now.rawIntakeIr !== intake
            || now.datasetBundle !== state.datasetBundle || now.csvData !== state.csvData || now.rawCsvData !== state.rawCsvData || now.canonicalCsvData !== state.canonicalCsvData
            || JSON.stringify(now.rawIntakeIr) !== intakeSignature || JSON.stringify(now.datasetBundle?.source.inspection) !== sourceSignature
            || now.confirmedAnalysisGoal !== goal) throw new Error('repair_continuation_stale');
    } };
    continuations.set(scope, entry);
    registerSessionResource(scope, () => { entry.revoked = true; continuations.delete(scope); });
    entry.check();
    return entry.check;
};

export const revokeStructureRepairContinuation = (store: StoreApi, reviewId: string, expectedLease?: RunLease) => {
    const root = rootStore(store), entry = continuations.get(captureSessionScope(root));
    if (!entry || entry.reviewId !== reviewId || expectedLease && entry.lease !== expectedLease) return;
    entry.revoked = true;
    if (entry.lease && ownsRun(root, entry.lease)) entry.lease.controller.abort(new Error('Semantic repair continuation cancelled.'));
};

const claimRun = (store: StoreApi, entry: Continuation, requireTask: boolean) => {
    entry.check();
    const lease = store.executionContext?.lease;
    if (!lease || lease.kind !== 'initial_analysis' || !ownsRun(store, lease) || lease.signal.aborted)
        throw new Error('repair_continuation_run_required');
    if (entry.lease !== lease) {
        if (!entry.taskOwner || captureOwnedPiTaskIdentity(store) !== entry.taskOwner)
            throw new Error('repair_continuation_wrong_task');
        entry.lease = lease;
    }
    if (requireTask) {
        const identity = captureOwnedPiTaskIdentity(store);
        if (entry.taskOwner && entry.taskOwner !== identity) throw new Error('repair_continuation_wrong_task');
        entry.taskOwner = identity;
    }
};
export const captureStructureRepairContinuation = (store: StoreApi) => {
    const entry = continuations.get(captureSessionScope(store));
    if (!entry) return undefined;
    if (entry.revoked) throw new Error('repair_continuation_revoked');
    claimRun(store, entry, false);
    return { check: entry.check, evidence: { reviewId: entry.reviewId, selectedHeader: structuredClone(entry.candidate), goal: entry.goal, commitAllowed: false } };
};
export const bindStructureRepairContinuationTask = (store: StoreApi) => {
    const entry = continuations.get(captureSessionScope(store));
    if (entry) claimRun(store, entry, true);
};
/** Capture the actual host-created question before the runtime releases its lease. */
export const sealStructureRepairHandoff = (store: StoreApi, pending: unknown) => {
    const entry = continuations.get(captureSessionScope(store));
    if (!entry) return;
    claimRun(store, entry, true);
    entry.handoff = { lease: store.executionContext!.lease, pending: JSON.stringify(pending) };
};
export const isStructureRepairHandoffCurrent = (store: StoreApi, lease: RunLease): boolean => {
    const entry = continuations.get(captureSessionScope(store));
    if (!entry || entry.revoked || lease.signal.aborted || entry.lease !== lease || entry.handoff?.lease !== lease) return false;
    entry.check();
    return !store.getState().activeExecution && JSON.stringify(store.getState().pendingClarification) === entry.handoff.pending;
};
/** A validated human refusal or failed commit ends this continuation, not the dataset. */
export const stopStructureRepairContinuation = (store: StoreApi, reason: string) => {
    const entry = continuations.get(captureSessionScope(store));
    if (!entry) return;
    if (entry.revoked || !entry.taskOwner || !isCurrentPiTaskIdentity(store, entry.taskOwner)
        || !store.executionContext || !ownsRun(store, store.executionContext.lease)) return;
    entry.revoked = true;
    entry.stopped(reason);
};
/** Called only after the existing exact-approval service reports committed + installed. */
export const completeStructureRepairContinuation = (store: StoreApi) => {
    const scope = captureSessionScope(store), entry = continuations.get(scope);
    if (!entry) return;
    if (entry.revoked || !entry.taskOwner || captureOwnedPiTaskIdentity(store) !== entry.taskOwner)
        throw new Error('repair_continuation_wrong_task');
    entry.revoked = true;
    continuations.delete(scope);
    entry.complete();
};

/** Only the existing long-metric dual projection can prove these repeated-header coordinates.
 * Every selected metric column occurs exactly once and carries its exact header-path coordinates.
 * Primary columns outside that range remain subject to the existing full-source compiler.
 */
export const captureStructureRepairProposalConstraint = (store: StoreApi, proposal: unknown): (() => void) | undefined => {
    const entry = continuations.get(captureSessionScope(store));
    if (!entry) return undefined;
    claimRun(store, entry, true);
    const proposals = isDualGrainMeaningAlternatives(proposal) ? proposal.interpretations.map(i => i.meaning)
        : isDualGrainCandidateMeaning(proposal) ? [proposal] : null;
    if (!proposals) throw new Error('repair_selected_header_requires_supported_dual_proposal');
    const candidate = entry.candidate;
    const verify = (p: DualGrainCandidateMeaning) => {
        const selected = candidate.mappings.filter(m => m.targetColumn >= candidate.mainStartColumn && m.targetColumn < candidate.mainEndColumn);
        const counts = new Map(selected.map(m => [m.targetColumn, 0]));
        for (const table of p.tables) for (const projection of table.projections) {
            const metrics = projection.filter(c => c.sourceRow === undefined && counts.has(c.sourceColumn));
            if (metrics.length > 1) throw new Error('repair_selected_header_projection_unsupported');
            for (const metric of metrics) {
                const mapping = selected.find(m => m.targetColumn === metric.sourceColumn)!;
                const expected = new Set(mapping.headerPath.map(ref => `${ref.rowIndex}:${ref.columnIndex}`));
                const headerRows = new Set(mapping.headerPath.map(ref => ref.rowIndex));
                const actual = projection.filter(c => c.sourceRow !== undefined && headerRows.has(c.sourceRow))
                    .map(c => `${c.sourceRow}:${c.sourceColumn}`);
                if (actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some(key => !expected.has(key)))
                    throw new Error('repair_selected_header_mismatch');
                counts.set(metric.sourceColumn, counts.get(metric.sourceColumn)! + 1);
            }
        }
        if ([...counts.values()].some(count => count !== 1)) throw new Error('repair_selected_header_coverage_mismatch');
    };
    proposals.forEach(verify);
    return entry.check;
};
