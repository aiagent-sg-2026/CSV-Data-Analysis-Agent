import type { AppStore } from '../../store/useAppStore';
import type { StoreApi } from '../agent/types';
import { normalizeAbortError } from '../agent/runtime/runtimeAbort';
import { createChatMessage } from '../../utils/messageState';

export interface SessionScope { sessionId: string; epoch: number }
export interface RunLease {
    scope: SessionScope;
    runId: string;
    turnId?: string;
    kind: 'initial_analysis' | 'follow_up' | 'report';
    controller: AbortController;
    signal: AbortSignal;
    closed: boolean;
}
export interface ExecutionContext { lease: RunLease; stepId?: string; toolCallId?: string }
export interface ActiveExecution { runId: string; turnId?: string; kind: RunLease['kind']; phase: string }
type Coordinator = { store: StoreApi; scope: SessionScope; active: RunLease | null; transition: number };
const coordinators = new WeakMap<StoreApi['getState'], Coordinator>();
const roots = new WeakMap<StoreApi, StoreApi>();
const resources = new WeakMap<SessionScope, Set<() => void>>();
/** Resources belong to the captured epoch; retirement never looks up replacement paths. */
export const registerSessionResource = (scope: SessionScope, dispose: () => void): (() => void) => {
    const callbacks = resources.get(scope) ?? new Set<() => void>();
    callbacks.add(dispose); resources.set(scope, callbacks);
    return () => { callbacks.delete(dispose); };
};
const retireResources = (scope: SessionScope): void => {
    const callbacks = resources.get(scope);
    resources.delete(scope);
    callbacks?.forEach(dispose => {
        try { dispose(); }
        catch { console.warn('[Session] Resource retirement failed.'); }
    });
};
export const rootStore = (store: StoreApi): StoreApi => roots.get(store) ?? store;

const coordinator = (input: StoreApi): Coordinator => {
    const store = rootStore(input);
    let current = coordinators.get(store.getState);
    if (!current) {
        current = { store, scope: { sessionId: store.getState().sessionId, epoch: 0 }, active: null, transition: 0 };
        coordinators.set(store.getState, current);
    }
    if (current.scope.sessionId !== store.getState().sessionId) {
        current.active?.controller.abort(normalizeAbortError('The session was replaced.'));
        current.active = null;
        const outgoing = current.scope;
        current.scope = { sessionId: store.getState().sessionId, epoch: current.scope.epoch + 1 };
        retireResources(outgoing);
    }
    return current;
};
export const captureSessionScope = (store: StoreApi): SessionScope => coordinator(store).scope;
export const ownsSessionScope = (store: StoreApi, scope: SessionScope): boolean => coordinator(store).scope === scope;
export const ownsRun = (store: StoreApi, lease: RunLease): boolean => {
    const current = coordinator(store);
    return current.scope === lease.scope && current.active === lease && !lease.closed;
};
export const canCommitRun = (store: StoreApi, lease: RunLease): boolean => ownsRun(store, lease) && !lease.signal.aborted;
export const assertRunActive = (store: StoreApi, lease: RunLease): void => {
    if (!canCommitRun(store, lease)) throw normalizeAbortError('This run no longer owns the session.');
};
/** Shared publication guard for resources outside Zustand; the coordinator remains authoritative. */
export const assertSessionResourceActive = (store: StoreApi, scope: SessionScope): void => {
    if (!ownsSessionScope(store, scope) || store.isActive?.() === false
        || (store.executionContext && !canCommitRun(store, store.executionContext.lease))) throw new Error('scope_revoked');
};
export const beginRun = (store: StoreApi, kind: RunLease['kind'], runId: string, turnId?: string): RunLease => {
    const current = coordinator(store);
    if (current.active && !current.active.closed) throw new Error('An agent run is already active.');
    const controller = new AbortController();
    const lease: RunLease = { scope: current.scope, kind, runId, turnId, controller, signal: controller.signal, closed: false };
    current.active = lease;
    current.store.setState({ activeExecution: { runId, turnId, kind, phase: 'preparing' } });
    return lease;
};
export const finishRun = (store: StoreApi, lease: RunLease, publication?: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>)): void => {
    if (!ownsRun(store, lease)) return;
    lease.closed = true;
    coordinator(store).active = null;
    rootStore(store).setState(state => ({ ...(typeof publication === 'function' ? publication(state) : publication), activeExecution: null }));
};
export const cancelOwnedRun = (store: StoreApi, message = 'The request was cancelled.'): void => {
    coordinator(store).active?.controller.abort(normalizeAbortError(message));
};
export const beginSessionTransition = (store: StoreApi): number => {
    const current = coordinator(store);
    cancelOwnedRun(store, 'Cancelled because the session is switching.');
    current.active = null;
    const outgoing = current.scope;
    // Cleanup is untrusted resource code; revoke publication before invoking it.
    current.scope = { sessionId: current.scope.sessionId, epoch: current.scope.epoch + 1 };
    current.transition += 1;
    retireResources(outgoing);
    current.store.setState({ csvSourceScan: null, structureRepairReview: null, activeExecution: null, activeAgentTask: null, taskInspection: null, streamingMessage: null,
        activeTurn: null, isBusy: true, isGeneratingReport: false, aiTaskStatus: null,
        initialAnalysisStatus: current.store.getState().initialAnalysisStatus === 'running' ? 'paused' : current.store.getState().initialAnalysisStatus });
    return current.transition;
};
export const ownsTransition = (store: StoreApi, token: number): boolean => coordinator(store).transition === token;

export const captureOutgoingSessionSnapshot = (store: StoreApi): AppStore => {
    const state = store.getState();
    const wasRunning = Boolean(state.activeExecution || state.initialAnalysisStatus === 'running');
    return { ...state, isBusy: false, isGeneratingReport: false, activeExecution: null, activeTurn: null,
        streamingMessage: null, aiTaskStatus: null, chatLifecycleState: 'idle',
        initialAnalysisStatus: state.initialAnalysisStatus === 'running' ? 'paused' : state.initialAnalysisStatus,
        chatHistory: wasRunning ? [...(state.chatHistory ?? []), createChatMessage({ sender: 'ai', type: 'ai_message',
            text: 'The task was cancelled because the session switched. Completed results were preserved.', timestamp: new Date() })] : state.chatHistory,
    };
};

/** Guard direct commits and synchronous actions. Async store actions also fence their captured set/get. */
export const scopeStore = (input: StoreApi, scope: SessionScope, lease?: RunLease): StoreApi => {
    const store = rootStore(input);
    const valid = () => lease ? canCommitRun(store, lease) : ownsSessionScope(store, scope);
    let snapshot = store.getState();
    const guarded: StoreApi = {
        isActive: valid,
        executionContext: lease ? { lease } : undefined,
        getState: () => {
            if (valid()) snapshot = store.getState();
            return new Proxy(snapshot, { get(target, key, receiver) {
                const value: unknown = Reflect.get(target, key, receiver);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                    if (!valid()) return undefined;
                    if (key === 'ensureDatasetSemanticSnapshot') {
                        args[1] = { ...(args[1] as object ?? {}), sessionScope: scope, runLease: lease };
                    } else if (key === 'refreshDuckDbSession') { args[1] = scope; args[2] = lease; }
                    return value(...args);
                };
            } }) as AppStore;
        },
        setState: partial => { if (valid()) store.setState(partial); },
    };
    roots.set(guarded, store);
    return guarded;
};
export const scopeRunStore = (store: StoreApi, lease: RunLease): StoreApi => scopeStore(store, lease.scope, lease);

/** Stop waiting even when an SDK does not propagate cancellation to its transport. */
export const awaitOwned = async <T>(promise: Promise<T>, store: StoreApi, lease: RunLease): Promise<T> => {
    assertRunActive(store, lease);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(normalizeAbortError(lease.signal.reason));
        lease.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const result = await Promise.race([promise, cancelled]);
        assertRunActive(store, lease);
        return result;
    } finally { lease.signal.removeEventListener('abort', onAbort); }
};

export const scopeCurrentExecution = (store: StoreApi): StoreApi => {
    const current = coordinator(store);
    return scopeStore(store, current.scope, current.active ?? undefined);
};
