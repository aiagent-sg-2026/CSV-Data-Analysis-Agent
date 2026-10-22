import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError, wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { Settings } from '../types';

// Only fallback model resolution is replaced; streamText, the AI SDK retry
// loop, streamGenerateText and withTransientRetry are the real implementations.
vi.mock('../services/ai/providerConfig', () => ({
    createFallbackProviderModel: () => null,
}));

const { streamGenerateText } = await import('../services/ai/streamGenerateText');
const { withTransientRetry } = await import('../services/ai/transientRetry');
const { runWithOverflowCompaction } = await import('../services/ai/overflowRetry');
const { ProviderTimeoutError } = await import('../services/ai/providerActivityGuards');
const { CloudAiConsentDeclinedError } = await import('../services/privacy/cloudAiConsent');

const settings = { provider: 'openai', language: 'English' } as unknown as Settings;

const finishPart: LanguageModelV3StreamPart = {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
};

const successStream = (text: string) => ({
    stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: text });
            controller.enqueue({ type: 'text-end', id: 't1' });
            controller.enqueue(finishPart);
            controller.close();
        },
    }),
});

const apiCallError = (statusCode: number, message: string, responseBody = JSON.stringify({ error: { message } })) =>
    new APICallError({
        message,
        url: 'https://provider.test/v1/responses',
        requestBodyValues: {},
        statusCode,
        responseBody,
        // A zero Retry-After keeps the AI SDK's own retry delay at 0 ms.
        responseHeaders: { 'retry-after-ms': '0' },
    });

const messages = [{ role: 'user' as const, content: 'hi' }];

/** Retry options with no backoff so tests do not wait on real timers. */
const retryOptions = { settings, primaryModelId: 'primary', label: 'test', baseDelayMs: 0, maxDelayMs: 0 };

describe('streamGenerateText provider HTTP errors', () => {
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('surfaces the APICallError instead of a cause-less NoOutputGeneratedError', async () => {
        const providerError = apiCallError(503, 'Service Unavailable');
        const model = new MockLanguageModelV3({ doStream: async () => { throw providerError; } });

        await expect(streamGenerateText({ model, messages, maxRetries: 0 })).rejects.toBe(providerError);
    });

    it.each([
        [503, 'Service Unavailable'],
        [429, 'Rate limit reached for requests'],
    ])('lets withTransientRetry retry a %i once and succeed', async (statusCode, message) => {
        const doStream = vi.fn()
            .mockRejectedValueOnce(apiCallError(statusCode, message))
            .mockResolvedValueOnce(successStream('recovered'));
        const model = new MockLanguageModelV3({ doStream });
        const onRetry = vi.fn();

        const result = await withTransientRetry(
            () => streamGenerateText({ model, messages, maxRetries: 0 }),
            { ...retryOptions, onRetry },
        );

        expect(result.text).toBe('recovered');
        expect(doStream).toHaveBeenCalledTimes(2);
        expect(onRetry).toHaveBeenCalledOnce();
        expect(onRetry.mock.calls[0][0]).toMatchObject({ strategy: 'same_model', error: { statusCode } });
    });

    it.each([
        [400, 'max_output_tokens must be at most 500'],
        [413, 'Request body exceeds 205000 bytes'],
    ])('does not retry a %i and surfaces its status and message', async (statusCode, message) => {
        const doStream = vi.fn().mockRejectedValue(apiCallError(statusCode, message));
        const model = new MockLanguageModelV3({ doStream });

        const error = await withTransientRetry(
            () => streamGenerateText({ model, messages }),
            retryOptions,
        ).catch((caught: unknown) => caught);

        expect(APICallError.isInstance(error)).toBe(true);
        expect(error).toMatchObject({ statusCode, message });
        // 4xx is not retryable for the AI SDK either, so exactly one request is sent.
        expect(doStream).toHaveBeenCalledTimes(1);
    });

    it('does not retry a demo gateway 429 that the fetch boundary already handled', async () => {
        const body = JSON.stringify({ error: { message: 'Demo session request limit reached', code: 'DEMO_SESSION_REQUEST_LIMIT' } });
        const doStream = vi.fn().mockRejectedValue(apiCallError(429, 'Demo session request limit reached', body));
        const model = new MockLanguageModelV3({ doStream });

        const error = await withTransientRetry(
            () => streamGenerateText({ model, messages, maxRetries: 0 }),
            retryOptions,
        ).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ statusCode: 429 });
        expect(doStream).toHaveBeenCalledTimes(1);
    });

    it('does not add a same-model round after the AI SDK exhausted its own retries', async () => {
        const doStream = vi.fn().mockRejectedValue(apiCallError(503, 'Service Unavailable'));
        const model = new MockLanguageModelV3({ doStream });

        const error = await withTransientRetry(
            () => streamGenerateText({ model, messages }),
            retryOptions,
        ).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ name: 'AI_RetryError', reason: 'maxRetriesExceeded' });
        expect((error as { lastError: unknown }).lastError).toMatchObject({ statusCode: 503 });
        // AI SDK default maxRetries is 2: three requests, not six.
        expect(doStream).toHaveBeenCalledTimes(3);
    });

    it('lets runWithOverflowCompaction see a context overflow and retry with compaction', async () => {
        const doStream = vi.fn()
            .mockRejectedValueOnce(apiCallError(400, "This model's maximum context length is 128000 tokens."))
            .mockResolvedValueOnce(successStream('compacted'));
        const model = new MockLanguageModelV3({ doStream });
        const modes: string[] = [];

        const result = await runWithOverflowCompaction({
            provider: 'openai',
            execute: mode => {
                modes.push(mode);
                return streamGenerateText({ model, messages });
            },
        });

        expect(result.text).toBe('compacted');
        expect(modes).toEqual(['normal', 'overflow_retry']);
    });

    it('still surfaces a caller abort as the abort reason, not as a provider error', async () => {
        const controller = new AbortController();
        const abortReason = new DOMException('Cancelled by user', 'AbortError');
        const doStream = vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => new Promise<never>((_, reject) => {
            abortSignal?.addEventListener('abort', () => reject(apiCallError(503, 'Service Unavailable')), { once: true });
        }));
        const model = new MockLanguageModelV3({ doStream: doStream as never });

        const call = withTransientRetry(
            () => streamGenerateText({ model, messages, abortSignal: controller.signal }),
            { ...retryOptions, abortSignal: controller.signal },
        ).catch((caught: unknown) => caught);
        await vi.waitFor(() => expect(doStream).toHaveBeenCalledOnce());
        controller.abort(abortReason);

        const error = await call;
        expect(error).toBe(abortReason);
        expect(APICallError.isInstance(error)).toBe(false);
        expect(doStream).toHaveBeenCalledOnce();
    });

    it('still rethrows a consent decline as CloudAiConsentDeclinedError', async () => {
        const doStream = vi.fn(async () => successStream('never'));
        const model = wrapLanguageModel({
            model: new MockLanguageModelV3({ doStream }),
            middleware: {
                specificationVersion: 'v3',
                wrapStream: async () => { throw new CloudAiConsentDeclinedError(); },
            },
        });

        await expect(withTransientRetry(
            () => streamGenerateText({ model, messages }),
            retryOptions,
        )).rejects.toBeInstanceOf(CloudAiConsentDeclinedError);
        expect(doStream).not.toHaveBeenCalled();
    });

    it('still times out an idle stream with ProviderTimeoutError', async () => {
        vi.useFakeTimers();
        const model = new MockLanguageModelV3({
            doStream: async () => ({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                    start(controller) {
                        controller.enqueue({ type: 'stream-start', warnings: [] });
                    },
                }),
            }),
        });

        const call = streamGenerateText({ model, messages, activityTimeoutMs: 1_000 })
            .catch((caught: unknown) => caught);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(await call).toBeInstanceOf(ProviderTimeoutError);
    });

    it('returns a successful stream unchanged', async () => {
        const model = new MockLanguageModelV3({ doStream: async () => successStream('hello') });

        await expect(streamGenerateText({ model, messages })).resolves.toMatchObject({
            text: 'hello',
            finishReason: 'stop',
        });
    });
});
