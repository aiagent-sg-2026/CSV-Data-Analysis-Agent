// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import { beginRun, scopeRunStore, beginSessionTransition } from '../services/session/sessionOwnership';
import { detachEnvelopeCandidateDraft, detachCandidateDraft, readDetachedCandidateDraft } from '../services/data/detachedCandidateDraft';
const roots: StoreApi[] = [];
afterEach(() => { roots.splice(0).forEach(beginSessionTransition); vi.useRealTimers(); });
const setup = () => {
    let state = { sessionId: crypto.randomUUID(), activeAgentTask: { status: 'awaiting_approval' }, pendingClarification: { resumeContext: { piCandidateApproval: { reviewId: 'review' } } } } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: p => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; } };
    roots.push(root);
    const lease = beginRun(root, 'follow_up', 'run', 'turn'), store = scopeRunStore(root, lease);
    store.executionContext = { lease, toolCallId: 'test', stepId: 'test' } as never;
    const envelope = { candidate: { candidateId: 'dual', tables: [{ name: 'entities', rowCount: 0, rows: [], lineage: [] }], protectedSource: { sha256: 'source' } }, receipt: { receiptDigest: 'dualDigest' }, check: vi.fn() };
    detachEnvelopeCandidateDraft(store, envelope as never);
    const spill = { candidate: { candidateId: 'spill', tables: [{ name: 'records', rowCount: 0, rows: [], lineage: [] }], protectedSource: { sha256: 'source' }, spill: { manifest: { chunks: 0 }, meaning: { columns: [] } } }, receipt: { receiptDigest: 'spillDigest' }, check: vi.fn() };
    detachCandidateDraft(store, 'review', 'reviewDigest', Date.now() + 600000, spill as never);
    return { root, envelope, spill };
};
it.each(['valid', 'expired', 'stale'] as const)('same-session dual draft -> legacy spill preview retains independent custody with %s envelope', async mode => {
    vi.useFakeTimers();
    const { root, envelope, spill } = setup();
    if (mode === 'expired') vi.advanceTimersByTime(300001);
    if (mode === 'stale') envelope.check.mockImplementation(() => { throw new Error('stale_envelope'); });
    await expect(readDetachedCandidateDraft(root, 'spill', 'records', 'spillDigest')).resolves.toMatchObject({ label: 'draft_uncommitted', answerEvidence: false });
    expect(envelope.check).toHaveBeenCalledTimes(1); // Installation only; unrelated reads never enter it.
    expect(spill.check).toHaveBeenCalled();
    await expect(readDetachedCandidateDraft(root, 'forged', 'records', 'spillDigest')).rejects.toThrow('candidate_draft_unavailable');
    await expect(readDetachedCandidateDraft(root, 'dual', 'records', 'spillDigest')).rejects.toThrow();
    root.setState({ pendingClarification: null });
    await expect(readDetachedCandidateDraft(root, 'spill', 'records', 'spillDigest')).rejects.toThrow('candidate_draft_unavailable');
});
it('revokes a matching stale envelope permanently without revoking the independent spill', async () => {
    const { root, envelope } = setup();
    envelope.check.mockImplementationOnce(() => { throw new Error('stale_envelope'); });
    await expect(readDetachedCandidateDraft(root, 'dual', 'entities', 'dualDigest')).rejects.toThrow('stale_envelope');
    await expect(readDetachedCandidateDraft(root, 'dual', 'entities', 'dualDigest')).rejects.toThrow('candidate_draft_unavailable');
    await expect(readDetachedCandidateDraft(root, 'spill', 'records', 'spillDigest')).resolves.toMatchObject({ label: 'draft_uncommitted' });
});
