import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeContext } from '@earendil-works/pi-ai';
import { createPiProviderStream, resolvePiModel } from '../services/agent/runtime/pi/piProvider';
import { resetDemoGatewaySessionForTests } from '../services/ai/demoGatewaySession';
import { resetDemoGatewayRequestLimiterForTests } from '../services/ai/browserProviderFetch';
import { getDefaultSettings } from '../services/storageService';

const settings = { ...getDefaultSettings(), provider: 'default' as const };
const context = normalizeContext({ systemPrompt: 'Test.', messages: [{ role: 'user', content: 'hello', timestamp: 1 }] });
const session = () => new Response(JSON.stringify({ token: 'dmo_test', model: 'demo-openai-mini', expires_in: 900 }), { status: 201 });

describe('real Pi Default gateway transport', () => {
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

    it('finishes the actual adapter stream result on abort before the handshake responds', async () => {
        let started!: () => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        let release!: (response: Response) => void;
        const handshake = new Promise<Response>(resolve => { release = resolve; });
        const upstream = vi.fn(() => { started(); return handshake; });
        vi.stubGlobal('fetch', upstream);
        const controller = new AbortController();
        const stream = await createPiProviderStream(settings)(resolvePiModel(settings), context, { signal: controller.signal });
        let stopReason: string | undefined;
        const result = stream.result().then(message => { stopReason = message.stopReason; });
        await entered;
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        const beforeHandshake = stopReason;
        release(session());
        await result;
        expect(beforeHandshake).toBe('aborted');
        expect(upstream).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('finishes the actual adapter stream result when a handshake never responds', async () => {
        let started!: () => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        vi.stubGlobal('fetch', vi.fn(() => { started(); return new Promise<Response>(() => undefined); }));
        const stream = await createPiProviderStream(settings)(resolvePiModel(settings), context, {});
        let stopReason: string | undefined;
        const result = stream.result().then(message => { stopReason = message.stopReason; });
        await entered;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(stopReason).toBe('error');
        await result;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves the final serialized gateway contract through the actual Pi adapter', async () => {
        let body: Record<string, unknown> | undefined;
        let authorization: string | null | undefined;
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (String(input).endsWith('/demo/session')) return session();
            const request = input as Request;
            body = await request.json();
            authorization = request.headers.get('authorization');
            const event = { type: 'response.completed', response: {
                id: 'resp_test', status: 'completed', output: [],
                usage: { input_tokens: 1, output_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
            } };
            return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
        }));
        const stream = await createPiProviderStream(settings)(resolvePiModel(settings), context, { maxTokens: 500 });
        expect((await stream.result()).stopReason).toBe('stop');
        expect(body).toHaveProperty('model', 'demo-openai-mini');
        expect(body).not.toHaveProperty('max_output_tokens');
        expect(body).not.toHaveProperty('top_p');
        expect(authorization).toBe('Bearer dmo_test');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('honors the Pi SDK deadline when the responses fetch ignores its abort signal', async () => {
        let started!: () => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        vi.stubGlobal('fetch', vi.fn((input: unknown) => {
            if (String(input).endsWith('/demo/session')) return Promise.resolve(session());
            started();
            return new Promise<Response>(() => undefined);
        }));
        const stream = await createPiProviderStream(settings)(resolvePiModel(settings), context, {});
        let stopReason: string | undefined;
        const result = stream.result().then(message => { stopReason = message.stopReason; });
        await entered;
        await vi.advanceTimersByTimeAsync(45_000);
        expect(stopReason).toBe('error');
        await result;
        expect(vi.getTimerCount()).toBe(0);
    });
});
