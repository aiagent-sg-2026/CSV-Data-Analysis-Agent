import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import { beginRun, beginSessionTransition, captureSessionScope, canCommitRun, scopeRunStore,
    scopeStore, ownsRun, ownsSessionScope, finishRun, awaitOwned, registerSessionResource } from '../services/session/sessionOwnership';
import { clearRuntimeTurnAbortController, registerRuntimeTurnAbortController, abortRuntimeTurn } from '../services/agent/runtime/runtimeAbort';

const makeStore = () => {
    let state = { sessionId: 's1', isBusy: false, initialAnalysisStatus: 'idle',
        finalSummary: 'original', addProgress: vi.fn() } as unknown as ReturnType<StoreApi['getState']>;
    return { getState: () => state, setState: patch => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    } } satisfies StoreApi;
};

describe('session and run ownership', () => {
    it('revokes the outgoing scope before synchronous resource retirement callbacks', () => {
        const store = makeStore(), scope = captureSessionScope(store), outgoing = scopeStore(store, scope);
        let revoked = false;
        registerSessionResource(scope, () => {
            revoked = !ownsSessionScope(store, scope);
            outgoing.setState({ finalSummary: { text: 'injected cleanup write', language: 'English' } });
        });
        beginSessionTransition(store);
        expect(revoked).toBe(true);
        expect(store.getState().finalSummary).toBe('original');
    });

    it('finishes replacement and retires remaining resources when one disposer throws', () => {
        const store = makeStore(), scope = captureSessionScope(store), lease = beginRun(store, 'follow_up', 'outgoing');
        const remaining = vi.fn(), warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        registerSessionResource(scope, () => { throw new Error('private cleanup payload'); });
        registerSessionResource(scope, remaining);
        try {
            expect(() => beginSessionTransition(store)).not.toThrow();
            expect(lease.signal.aborted).toBe(true);
            expect(ownsSessionScope(store, scope)).toBe(false);
            expect(remaining).toHaveBeenCalledTimes(1);
            expect(store.getState().activeExecution).toBeNull();
            const fresh = beginRun(store, 'follow_up', 'replacement');
            expect(canCommitRun(store, fresh)).toBe(true);
            beginSessionTransition(store);
            expect(remaining).toHaveBeenCalledTimes(1);
            expect(warning).toHaveBeenCalledWith('[Session] Resource retirement failed.');
        } finally { warning.mockRestore(); }
    });

    it('fences outgoing resource callbacks when the Store session id changes directly', () => {
        const store = makeStore(), scope = captureSessionScope(store), outgoing = scopeStore(store, scope);
        registerSessionResource(scope, () => outgoing.setState({ isBusy: false }));
        store.setState({ sessionId: 'replacement', isBusy: true });
        expect(captureSessionScope(store).sessionId).toBe('replacement');
        expect(store.getState().isBusy).toBe(true);
        expect(ownsSessionScope(store, scope)).toBe(false);
    });

    it('fences direct commits and synchronous store actions after replacement', () => {
        const store = makeStore();
        const lease = beginRun(store, 'initial_analysis', 'r1');
        const owned = scopeRunStore(store, lease);
        beginSessionTransition(store);
        store.setState({ sessionId: 's2', finalSummary: { text: 'new', language: 'English' } });
        owned.setState({ finalSummary: { text: 'stale', language: 'English' } });
        owned.getState().addProgress('stale progress');
        expect(store.getState().finalSummary).toEqual({ text: 'new', language: 'English' });
        expect(store.getState().addProgress).not.toHaveBeenCalled();
        expect(lease.signal.aborted).toBe(true);
    });

    it('changes epoch even when a transition retains the same session id', () => {
        const store = makeStore();
        const scope = captureSessionScope(store);
        beginSessionTransition(store);
        expect(captureSessionScope(store).sessionId).toBe(scope.sessionId);
        expect(ownsSessionScope(store, scope)).toBe(false);
    });

    it('does not let an old finalizer clear a newer run in the same session', () => {
        const store = makeStore();
        const old = beginRun(store, 'follow_up', 'old', 'old-turn');
        finishRun(store, old);
        const current = beginRun(store, 'follow_up', 'new', 'new-turn');
        finishRun(store, old);
        scopeRunStore(store, old).setState({ isBusy: false });
        expect(ownsRun(store, current)).toBe(true);
        expect(store.getState().activeExecution?.runId).toBe('new');
    });

    it('allows owned cancellation finalization but rejects ordinary cancelled commits', () => {
        const store = makeStore();
        const lease = beginRun(store, 'initial_analysis', 'r1');
        lease.controller.abort();
        expect(ownsRun(store, lease)).toBe(true);
        expect(canCommitRun(store, lease)).toBe(false);
        finishRun(store, lease);
        expect(store.getState().activeExecution).toBeNull();
    });

    it('does not revoke an active run when its authorized cleaning changes data', () => {
        const store = makeStore();
        const lease = beginRun(store, 'initial_analysis', 'r1');
        scopeRunStore(store, lease).setState({ csvData: { fileName: 'clean.csv', data: [{ A: 2 }] } });
        expect(canCommitRun(store, lease)).toBe(true);
    });

    it('stops waiting for a provider that ignores cancellation', async () => {
        const store = makeStore();
        const lease = beginRun(store, 'follow_up', 'r1');
        let resolve!: (value: string) => void;
        const provider = new Promise<string>(done => { resolve = done; });
        const waiting = awaitOwned(provider, store, lease);
        beginSessionTransition(store);
        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
        resolve('late reply');
        expect(store.getState().finalSummary).toBe('original');
    });

    it('keeps independent store instances isolated', () => {
        const first = makeStore();
        const second = makeStore();
        const lease = beginRun(second, 'follow_up', 'r2');
        beginSessionTransition(first);
        expect(canCommitRun(second, lease)).toBe(true);
    });

    it('guards async action scope arguments before entering captured Zustand actions', () => {
        const store = makeStore();
        const refresh = vi.fn();
        store.setState({ refreshDuckDbSession: refresh });
        const scope = captureSessionScope(store);
        scopeStore(store, scope).getState().refreshDuckDbSession();
        expect(refresh).toHaveBeenCalledWith(undefined, scope, undefined);
    });

    it('does not delete a replacement abort controller sharing a turn id', () => {
        const old = registerRuntimeTurnAbortController('same');
        const current = registerRuntimeTurnAbortController('same');
        clearRuntimeTurnAbortController('same', old);
        abortRuntimeTurn('same');
        expect(current.signal.aborted).toBe(true);
        expect(old.signal.aborted).toBe(false);
        clearRuntimeTurnAbortController('same', current);
    });
});
