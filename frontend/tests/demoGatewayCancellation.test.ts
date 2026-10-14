import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDefaultGateway, resetDemoGatewayRequestLimiterForTests } from '../services/ai/browserProviderFetch';
import { getDemoGatewaySession, resetDemoGatewaySessionForTests } from '../services/ai/demoGatewaySession';
import { createConcurrencyLimiter, releaseWhenBodyDone } from '../services/ai/demoGatewayConcurrency';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};
const sessionResponse = (token = 'dmo_test') =>
    new Response(JSON.stringify({ token, model: 'demo-openai-mini', expires_in: 900 }), { status: 201 });
const post = (signal?: AbortSignal) => fetchDefaultGateway('https://example.invalid/demo/v1/responses', {
    method: 'POST', body: JSON.stringify({ input: 'test', max_output_tokens: 100 }), signal,
});
const observe = <T>(promise: Promise<T>) => {
    const outcome: { value?: T; error?: unknown } = {};
    const done = promise.then(value => { outcome.value = value; }, error => { outcome.error = error; });
    return { outcome, done };
};
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('gateway cancellation boundaries', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubEnv('VITE_DEFAULT_GATEWAY_PROJECT_ID', 'test-project');
        resetDemoGatewaySessionForTests();
        resetDemoGatewayRequestLimiterForTests();
    });
    afterEach(() => {
        resetDemoGatewaySessionForTests();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('cancels one session waiter without cancelling another valid waiter', async () => {
        const handshake = deferred<Response>();
        let sharedSignal: AbortSignal | undefined;
        const upstream = vi.fn((_input: unknown, init?: RequestInit) => {
            sharedSignal = init?.signal ?? undefined;
            return handshake.promise;
        });
        vi.stubGlobal('fetch', upstream);
        const controller = new AbortController();
        const cancelled = observe(getDemoGatewaySession(controller.signal));
        const valid = getDemoGatewaySession();
        await flush();
        controller.abort();
        await flush();
        const beforeHandshake = cancelled.outcome.error;
        const sharedAborted = sharedSignal?.aborted;
        handshake.resolve(sessionResponse());
        expect((await valid).token).toBe('dmo_test');
        await cancelled.done;
        expect(beforeHandshake).toMatchObject({ name: 'AbortError' });
        expect(sharedAborted).toBe(false);
        expect(upstream).toHaveBeenCalledOnce();
    });

    it('bounds a never-resolving handshake and allows a new acquisition', async () => {
        const handshake = deferred<Response>();
        const upstream = vi.fn().mockReturnValueOnce(handshake.promise).mockResolvedValue(sessionResponse('dmo_new'));
        vi.stubGlobal('fetch', upstream);
        const pending = observe(getDemoGatewaySession());
        await vi.advanceTimersByTimeAsync(15_000);
        const beforeLateResponse = pending.outcome.error;
        handshake.resolve(sessionResponse('dmo_stale'));
        await pending.done;
        expect(beforeLateResponse).toMatchObject({ name: 'TimeoutError' });
        expect((await getDemoGatewaySession()).token).toBe('dmo_new');
    });

    it('releases a request waiting for the first handshake on Stop', async () => {
        const handshake = deferred<Response>();
        vi.stubGlobal('fetch', vi.fn((input: unknown) => String(input).endsWith('/demo/session')
            ? handshake.promise : Promise.resolve(new Response('{}'))));
        const controller = new AbortController();
        const pending = observe(post(controller.signal));
        await flush();
        controller.abort();
        await flush();
        const beforeLateResponse = pending.outcome.error;
        handshake.resolve(sessionResponse());
        await pending.done;
        expect(beforeLateResponse).toMatchObject({ name: 'AbortError' });
    });

    it('removes cancelled queued waiters without consuming a later slot', async () => {
        const limiter = createConcurrencyLimiter(1);
        const release = await limiter.acquire();
        const controller = new AbortController();
        const cancelled = observe(limiter.acquire(controller.signal));
        const next = observe(limiter.acquire());
        controller.abort();
        await flush();
        const cancelledBeforeRelease = cancelled.outcome.error;
        release();
        await flush();
        const nextBeforeCancelledRelease = next.outcome.value;
        cancelled.outcome.value?.();
        await next.done;
        next.outcome.value?.();
        expect(cancelledBeforeRelease).toMatchObject({ name: 'AbortError' });
        expect(nextBeforeCancelledRelease).toBeTypeOf('function');
    });

    it('releases and errors an unread response body on caller cancellation', async () => {
        const controller = new AbortController();
        const release = vi.fn();
        const cancel = vi.fn();
        const response = releaseWhenBodyDone(new Response(new ReadableStream({ cancel })), release, 10_000, controller.signal);
        controller.abort();
        await flush();
        const releaseCount = release.mock.calls.length;
        const reading = observe(response.text());
        await flush();
        const error = reading.outcome.error;
        await response.body?.cancel().catch(() => undefined);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(releaseCount).toBe(1);
        expect(error).toMatchObject({ name: 'AbortError' });
        expect(release).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('rejects already-cancelled callers without opening a session or sending a request', async () => {
        const upstream = vi.fn();
        vi.stubGlobal('fetch', upstream);
        const controller = new AbortController();
        controller.abort();
        await expect(getDemoGatewaySession(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        await expect(post(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(upstream).not.toHaveBeenCalled();
    });

    it('fences late abandoned handshakes from the cache and a newer shared refresh', async () => {
        const old = deferred<Response>();
        const replacement = deferred<Response>();
        const upstream = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
        vi.stubGlobal('fetch', upstream);
        const controller = new AbortController();
        const abandoned = observe(getDemoGatewaySession(controller.signal));
        await flush();
        controller.abort();
        await abandoned.done;
        const valid = getDemoGatewaySession();
        await flush();
        old.resolve(sessionResponse('dmo_stale'));
        await flush();
        const joined = getDemoGatewaySession();
        replacement.resolve(sessionResponse('dmo_new'));
        expect((await valid).token).toBe('dmo_new');
        expect((await joined).token).toBe('dmo_new');
        expect((await getDemoGatewaySession()).token).toBe('dmo_new');
        expect(upstream).toHaveBeenCalledTimes(2);
    });

    it.each([201, 403])('bounds session JSON/error-body reads after headers (status %i)', async status => {
        let handshakeSignal: AbortSignal | null | undefined;
        vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
            handshakeSignal = init?.signal;
            return Promise.resolve(new Response(new ReadableStream(), { status }));
        }));
        const pending = observe(getDemoGatewaySession());
        await vi.advanceTimersByTimeAsync(15_000);
        await pending.done;
        expect(pending.outcome.error).toMatchObject({ name: 'TimeoutError' });
        expect(handshakeSignal?.aborted).toBe(true);
    });

    it('cancels a hanging refresh after a 401 and frees the slot for a new request', async () => {
        const refreshStarted = deferred<void>();
        const refresh = deferred<Response>();
        let sessions = 0;
        let responses = 0;
        vi.stubGlobal('fetch', vi.fn((input: unknown) => {
            if (String(input).endsWith('/demo/session')) {
                sessions += 1;
                if (sessions === 2) { refreshStarted.resolve(); return refresh.promise; }
                return Promise.resolve(sessionResponse(`dmo_${sessions}`));
            }
            responses += 1;
            return Promise.resolve(responses === 1 ? new Response('{}', { status: 401 }) : new Response('{}'));
        }));
        const controller = new AbortController();
        const pending = observe(post(controller.signal));
        await refreshStarted.promise;
        controller.abort();
        await pending.done;
        expect(pending.outcome.error).toMatchObject({ name: 'AbortError' });
        expect(await (await post()).text()).toBe('{}');
        refresh.resolve(sessionResponse('dmo_stale'));
        await flush();
        expect((await getDemoGatewaySession()).token).toBe('dmo_3');
    });

    it('bounds queued requests and never sends a request whose slot wait expired', async () => {
        const sent: Request[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (String(input).endsWith('/demo/session')) return sessionResponse();
            sent.push(input as Request);
            return new Response(new ReadableStream());
        }));
        const first = await post();
        const second = await post();
        const queued = observe(post());
        await vi.advanceTimersByTimeAsync(45_000);
        await queued.done;
        expect(queued.outcome.error).toMatchObject({ name: 'TimeoutError' });
        expect(sent).toHaveLength(2);
        await first.body?.cancel();
        const next = await post();
        expect(sent).toHaveLength(3);
        await second.body?.cancel();
        await next.body?.cancel();
    });

    it('cancels a retry delay without sending the retry or retaining a slot', async () => {
        const upstream = vi.fn(async (input: unknown) => String(input).endsWith('/demo/session')
            ? sessionResponse() : new Response(JSON.stringify({ error: { code: 'DEMO_SESSION_CONCURRENCY_LIMIT' } }), { status: 429 }));
        vi.stubGlobal('fetch', upstream);
        const controller = new AbortController();
        const pending = observe(post(controller.signal));
        await flush();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        controller.abort();
        await pending.done;
        await vi.advanceTimersByTimeAsync(2000);
        expect(pending.outcome.error).toMatchObject({ name: 'AbortError' });
        expect(upstream).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds an unresponsive responses fetch, cancels its late body and releases its slot', async () => {
        const responseStarted = deferred<void>();
        const late = deferred<Response>();
        let calls = 0;
        vi.stubGlobal('fetch', vi.fn((input: unknown) => {
            if (String(input).endsWith('/demo/session')) return Promise.resolve(sessionResponse());
            calls += 1;
            if (calls === 1) { responseStarted.resolve(); return late.promise; }
            return Promise.resolve(new Response('{}'));
        }));
        const pending = observe(post());
        await responseStarted.promise;
        await vi.advanceTimersByTimeAsync(45_000);
        await pending.done;
        expect(pending.outcome.error).toMatchObject({ name: 'TimeoutError' });
        expect(await (await post()).text()).toBe('{}');
        const cancelled = vi.fn();
        late.resolve(new Response(new ReadableStream({ cancel: cancelled })));
        await flush();
        expect(cancelled).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a stalled 429 error-body read and releases the slot', async () => {
        let responses = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (String(input).endsWith('/demo/session')) return sessionResponse();
            responses += 1;
            return responses === 1 ? new Response(new ReadableStream(), { status: 429 }) : new Response('{}');
        }));
        const controller = new AbortController();
        const pending = observe(post(controller.signal));
        await flush();
        expect(responses).toBe(1);
        controller.abort();
        await pending.done;
        expect(pending.outcome.error).toMatchObject({ name: 'AbortError' });
        expect(await (await post()).text()).toBe('{}');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('releases streaming slots on Stop so a queued request can start', async () => {
        let responses = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (String(input).endsWith('/demo/session')) return sessionResponse();
            responses += 1;
            return new Response(new ReadableStream());
        }));
        const controller = new AbortController();
        const first = await post(controller.signal);
        const second = await post();
        const queued = observe(post());
        await flush();
        expect(responses).toBe(2);
        controller.abort();
        await queued.done;
        expect(responses).toBe(3);
        await expect(first.text()).rejects.toMatchObject({ name: 'AbortError' });
        await second.body?.cancel();
        await queued.outcome.value?.body?.cancel();
        expect(vi.getTimerCount()).toBe(0);
    });
});
