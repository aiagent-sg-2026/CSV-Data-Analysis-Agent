// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createJavaScriptGuest } from '../services/sandbox/javascriptGuestClient';
import { beginRun, beginSessionTransition, cancelOwnedRun, scopeRunStore } from '../services/session/sessionOwnership';
import type { AppStore } from '../store/useAppStore';
const store = () => {
    let state = { sessionId: 'guest-test', csvData: { data: [{ amount: 7 }] } } as unknown as AppStore;
    return { getState: () => state, setState: (patch: Partial<AppStore>) => { state = { ...state, ...patch }; } };
};
const worker = () => ({ onmessage: null as Worker['onmessage'], onerror: null as Worker['onerror'], postMessage: vi.fn(), terminate: vi.fn() });
describe('owned guest worker lifecycle', () => {
    it('cannot mask the captured run cancellation with an independent caller signal', async () => {
        const app = store(), fake = worker();
        const lease = beginRun(app, 'follow_up', 'real-run');
        const guest = createJavaScriptGuest(scopeRunStore(app, lease), () => fake as unknown as Worker);
        const result = guest.run('while(true){}', '{}', { signal: new AbortController().signal });
        cancelOwnedRun(app);
        expect((await result).status).toBe('cancelled');
        expect(fake.terminate).toHaveBeenCalledOnce();
        guest.dispose();
    });
    it('serializes separate handles for the same Store and does not let idle dispose cancel another handle', async () => {
        const app = store(), fake = worker();
        const first = createJavaScriptGuest(app, () => fake as unknown as Worker);
        const secondFactory = vi.fn(() => worker() as unknown as Worker);
        const second = createJavaScriptGuest(app, secondFactory);
        const pending = first.run('while(true){}', '{}');
        expect((await second.run('return 1;', '{}')).code).toBe('guest_busy');
        expect(secondFactory).not.toHaveBeenCalled();
        second.dispose(); expect(first.running).toBe(true);
        first.cancel(); expect((await pending).status).toBe('cancelled'); first.dispose();
    });
    it('cancels exactly its generation and ignores late messages while a later job runs', async () => {
        const first = worker(), second = worker();
        const guest = createJavaScriptGuest(store(), vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second));
        const old = guest.run('return 1;', '{}');
        const stale = first.onmessage!;
        const oldGeneration = first.postMessage.mock.calls[0][0].generation;
        guest.cancel();
        expect((await old).status).toBe('cancelled');
        const current = guest.run('return 2;', '{}');
        stale.call({} as Worker, { data: { generation: oldGeneration, status: 'completed', code: 'guest_completed', outputJson: '999' } } as MessageEvent);
        expect(guest.running).toBe(true);
        expect(second.terminate).not.toHaveBeenCalled();
        second.onmessage!.call({} as Worker, { data: { generation: second.postMessage.mock.calls[0][0].generation, status: 'completed', code: 'guest_completed', outputJson: '2' } } as MessageEvent);
        expect((await current).outputJson).toBe('2');
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(second.terminate).toHaveBeenCalledOnce();
        guest.dispose();
    });
    it('retires a session worker without changing accepted rows and denies the old handle', async () => {
        const app = store(), fake = worker(), guest = createJavaScriptGuest(app, () => fake as unknown as Worker);
        const before = app.getState().csvData;
        const result = guest.run('while(true){}', '{}');
        beginSessionTransition(app);
        expect((await result).status).toBe('cancelled');
        expect(fake.terminate).toHaveBeenCalledOnce();
        expect(app.getState().csvData).toBe(before);
        expect((await guest.run('return 1;', '{}')).status).toBe('cancelled');
    });
    it('hard-terminates a silent worker and permits the next job', async () => {
        vi.useFakeTimers();
        const fake = worker(), guest = createJavaScriptGuest(store(), () => fake as unknown as Worker);
        const result = guest.run('while(true){}', '{}', { limits: { timeoutMs: 25 } });
        await vi.advanceTimersByTimeAsync(25);
        expect((await result).status).toBe('timeout');
        expect(guest.running).toBe(false);
        expect(fake.terminate).toHaveBeenCalledOnce();
        guest.dispose(); vi.useRealTimers();
    });
    it('aborts through the run signal and refuses oversized results', async () => {
        const fake = worker(), guest = createJavaScriptGuest(store(), () => fake as unknown as Worker);
        const controller = new AbortController();
        const result = guest.run('return 1;', '{}', { signal: controller.signal });
        controller.abort(); expect((await result).status).toBe('cancelled');
        const next = guest.run('return 1;', '{}', { limits: { outputBytes: 2 } });
        fake.onmessage!.call({} as Worker, { data: { generation: fake.postMessage.mock.calls[1][0].generation, status: 'completed', code: 'guest_completed', outputJson: '999' } } as MessageEvent);
        expect((await next).code).toBe('guest_invalid_response'); guest.dispose();
    });
});
