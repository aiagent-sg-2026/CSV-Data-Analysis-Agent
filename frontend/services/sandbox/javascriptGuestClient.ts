import type { StoreApi } from '../agent/types';
import { assertSessionResourceActive, captureSessionScope, registerSessionResource, rootStore } from '../session/sessionOwnership';
import { admitGuestRequest, resolveGuestLimits, type GuestLimits, type GuestOutcome, type GuestRequest } from './javascriptGuestProtocol';

let nextGeneration = 0;
const executing = new WeakMap<StoreApi['getState'], number>();
type WorkerFactory = () => Worker;
export const createJavaScriptGuest = (store: StoreApi, factory: WorkerFactory = () =>
    new Worker(new URL('../workers/javascriptGuestWorker.ts', import.meta.url), { type: 'module' })) => {
    const scope = captureSessionScope(store);
    const owner = rootStore(store).getState;
    let active: { generation: number; cancel: () => void } | undefined;
    let disposed = false;
    const dispose = () => { disposed = true; active?.cancel(); };
    const unregister = registerSessionResource(scope, dispose);
    return {
        get running() { return Boolean(active); },
        cancel() { active?.cancel(); },
        dispose() { dispose(); unregister(); },
        run(code: string, inputJson: string, options: { limits?: Partial<GuestLimits>; signal?: AbortSignal; onStarted?: () => void;
            evaluationFault?: GuestRequest['evaluationFault'] } = {}): Promise<GuestOutcome> {
            const generation = ++nextGeneration;
            const rejected = (status: GuestOutcome['status'], code: string) => Promise.resolve({ generation, status, code });
            try { assertSessionResourceActive(store, scope); } catch { return rejected('cancelled', 'guest_scope_revoked'); }
            const leaseSignal = store.executionContext?.lease.signal;
            const signal = options.signal && leaseSignal ? AbortSignal.any([options.signal, leaseSignal]) : options.signal ?? leaseSignal;
            if (disposed || signal?.aborted) return rejected('cancelled', 'guest_cancelled');
            if (active || executing.has(owner)) return rejected('failed', 'guest_busy');
            let request: GuestRequest;
            try {
                request = { generation, code, inputJson, limits: resolveGuestLimits(options.limits),
                    ...(options.evaluationFault ? { evaluationFault: structuredClone(options.evaluationFault) } : {}) };
                admitGuestRequest(request);
            } catch { return rejected('capacity', 'guest_request_rejected'); }
            let worker: Worker;
            try { worker = factory(); } catch { return rejected('unavailable', 'guest_worker_unavailable'); }
            return new Promise(resolve => {
                let finished = false;
                const finish = (result: GuestOutcome) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', cancel);
                    worker.onmessage = null; worker.onerror = null; worker.terminate();
                    if (active?.generation === generation) active = undefined;
                    if (executing.get(owner) === generation) executing.delete(owner);
                    resolve(result);
                };
                const cancel = () => finish({ generation, status: 'cancelled', code: 'guest_cancelled' });
                const timer = setTimeout(() => finish({ generation, status: 'timeout', code: 'guest_worker_deadline' }), request.limits.timeoutMs);
                active = { generation, cancel };
                executing.set(owner, generation);
                signal?.addEventListener('abort', cancel, { once: true });
                worker.onerror = () => finish({ generation, status: 'unavailable', code: 'guest_worker_failed' });
                worker.onmessage = event => {
                    if (event.data?.generation !== generation) return;
                    try { assertSessionResourceActive(store, scope); } catch { cancel(); return; }
                    if (event.data.event === 'executing') {
                        try { options.onStarted?.(); } catch { cancel(); }
                        return;
                    }
                    const result = event.data as GuestOutcome;
                    if (!['completed', 'failed', 'capacity', 'timeout', 'cancelled', 'unavailable'].includes(result.status)
                        || typeof result.code !== 'string' || result.code.length > 80) {
                        finish({ generation, status: 'failed', code: 'guest_invalid_response' }); return;
                    }
                    if (result.status === 'completed') {
                        try {
                            if (typeof result.outputJson !== 'string' || new TextEncoder().encode(result.outputJson).byteLength > request.limits.outputBytes) throw new Error();
                            JSON.parse(result.outputJson);
                        } catch { finish({ generation, status: 'failed', code: 'guest_invalid_response' }); return; }
                    }
                    finish(result);
                };
                try {
                    assertSessionResourceActive(store, scope);
                    if (signal?.aborted || disposed) { cancel(); return; }
                    worker.postMessage(request);
                } catch { cancel(); }
            });
        },
    };
};
