import { revokeDetachedCandidateDraft } from '../../../data/detachedCandidateDraft';
import type { ClarificationRequest } from '../../../../types';
import type { StoreApi } from '../../types';
import type { CandidateCommitReview } from '../../../data/candidateCommit';
import { ownsSessionScope, rootStore, type RunLease } from '../../../session/sessionOwnership';

type ReviewEntry = { lease: RunLease; review: CandidateCommitReview; pending: ClarificationRequest };
const reviews = new WeakMap<StoreApi['getState'], ReviewEntry>();

/** Read-only UI custody. The commit service's private capsule remains the approval authority. */
export const publishPiCandidateReview = (store: StoreApi, lease: RunLease, review: CandidateCommitReview, pending: ClarificationRequest) => {
    reviews.set(rootStore(store).getState, { lease, review, pending });
};
export const retirePiCandidateReview = (key: StoreApi['getState'], reviewId: string) => {
    revokeDetachedCandidateDraft(key,reviewId);
    if (reviews.get(key)?.review.reviewId === reviewId) reviews.delete(key);
};
export const inspectPiCandidateReview = (store: StoreApi, request?: ClarificationRequest | null) => {
    const state = store.getState(), entry = reviews.get(rootStore(store).getState);
    const pending = request ?? state.pendingClarification ?? state.activeTurn?.pendingClarificationRequest;
    const ref = pending?.resumeContext?.piCandidateApproval, taskRef = pending?.resumeContext?.piTaskContinuation;
    const expected = entry?.pending.resumeContext?.piTaskContinuation, task = state.activeAgentTask;
    const matches = Boolean(entry && ref && taskRef && expected && task
        && ownsSessionScope(store, entry.lease.scope) && task.sessionId === state.sessionId
        && task.status === 'awaiting_approval' && task.taskId === taskRef.taskId && task.revision === taskRef.revision
        && task.scope.digest === taskRef.scopeDigest && ref.reviewId === entry.review.reviewId && ref.reviewDigest === entry.review.reviewDigest
        && taskRef.taskId === expected.taskId && taskRef.revision === expected.revision && taskRef.scopeDigest === expected.scopeDigest
        && pending?.question === entry.pending.question && JSON.stringify(pending.options) === JSON.stringify(entry.pending.options));
    if (!matches) return { available: false, reason: 'Review is historical or unavailable. Start a fresh request or revalidate the interrupted candidate.' };
    const review = entry!.review;
    if (Date.now() >= review.expiresAt) return { review, available: false, reason: 'Review expired. Revalidate for a new exact approval.' };
    return { review, available: !state.isBusy && !state.activeExecution,
        reason: state.isBusy || state.activeExecution ? 'Another operation is active. Wait or stop it before review.' : 'Exact review is ready for a fresh host recheck.' };
};
