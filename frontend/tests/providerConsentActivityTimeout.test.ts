import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { CloudAiConsentRequest, Settings } from '../types';

const {
    getCloudAiConsentMock,
    saveCloudAiConsentMock,
    providerModelRef,
} = vi.hoisted(() => ({
    getCloudAiConsentMock: vi.fn(),
    saveCloudAiConsentMock: vi.fn(),
    providerModelRef: { current: null as unknown },
}));

vi.mock('../services/storageService', () => ({
    getCloudAiConsent: getCloudAiConsentMock,
    saveCloudAiConsent: saveCloudAiConsentMock,
}));
vi.mock('../services/observability/localDiagnostics', () => ({
    recordLocalDiagnosticBestEffort: vi.fn(),
}));
// Only the provider's HTTP layer is replaced. wrapLanguageModel, the consent
// middleware, streamText, and the activity timer are the real implementations.
vi.mock('@ai-sdk/openai', () => ({
    createOpenAI: () => Object.assign(
        () => providerModelRef.current,
        { responses: () => providerModelRef.current },
    ),
}));

const {
    CloudAiConsentDeclinedError,
    __resetCloudAiConsentRuntimeForTests,
    configureCloudAiConsentRuntime,
    grantCloudAiConsent,
} = await import('../services/privacy/cloudAiConsent');
const { createProviderModel } = await import('../services/ai/providerConfig');
const { streamGenerateText, DEFAULT_ACTIVITY_TIMEOUT_MS } = await import('../services/ai/streamGenerateText');
const { ProviderTimeoutError } = await import('../services/ai/providerActivityGuards');
const { classifyChatIntent } = await import('../services/agent/runtime/intentClassifier');

const settings = {
    provider: 'default',
    geminiApiKey: '',
    openAIApiKey: '',
    simpleModel: 'irrelevant',
    complexModel: 'irrelevant',
    language: 'English',
} as unknown as Settings;

const finishPart: LanguageModelV3StreamPart = {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
};

/** Provider model whose stream parts are pushed manually by the test. */
const createControlledProviderModel = () => {
    let streamController!: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
    const doStream = vi.fn(async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
                streamController = controller;
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'text-start', id: 't1' });
            },
        }),
    }));
    providerModelRef.current = new MockLanguageModelV3({ doStream });
    return {
        doStream,
        pushText: (delta: string) => streamController.enqueue({ type: 'text-delta', id: 't1', delta }),
        finish: () => {
            streamController.enqueue({ type: 'text-end', id: 't1' });
            streamController.enqueue(finishPart);
            streamController.close();
        },
    };
};

/** Consent runtime whose modal decision stays pending until the test resolves it. */
const installPendingConsentRuntime = () => {
    let pendingRequest: CloudAiConsentRequest | null = null;
    let resolveDecision: ((granted: boolean) => void) | null = null;
    const requestConsent = vi.fn((request: CloudAiConsentRequest) => {
        pendingRequest = request;
        return new Promise<boolean>(resolve => {
            resolveDecision = resolve;
        });
    });
    configureCloudAiConsentRuntime(() => ({ datasetId: 'dataset-a', requestConsent }));
    return {
        requestConsent,
        // Mirrors uiSlice.resolveCloudAiConsent: persist the grant, then resolve.
        grant: async () => {
            await grantCloudAiConsent(pendingRequest!);
            resolveDecision!(true);
        },
        decline: () => resolveDecision!(false),
    };
};

const observe = <T>(promise: Promise<T>) => {
    const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
    promise.then(
        value => Object.assign(state, { settled: true, value }),
        error => Object.assign(state, { settled: true, error }),
    );
    return state;
};

const CONSENT_READING_TIME_MS = 45_000;

describe('provider activity timeout around the cloud AI consent wait', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        getCloudAiConsentMock.mockResolvedValue(null);
        saveCloudAiConsentMock.mockResolvedValue(undefined);
        __resetCloudAiConsentRuntimeForTests();
    });

    afterEach(() => {
        __resetCloudAiConsentRuntimeForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not time out while consent is pending and succeeds after consent is granted', async () => {
        const provider = createControlledProviderModel();
        const consent = installPendingConsentRuntime();
        const { model } = createProviderModel(settings);

        const call = observe(streamGenerateText({ model, messages: [{ role: 'user', content: 'hi' }] }));
        await vi.advanceTimersByTimeAsync(CONSENT_READING_TIME_MS);

        expect(CONSENT_READING_TIME_MS).toBeGreaterThan(DEFAULT_ACTIVITY_TIMEOUT_MS);
        expect(consent.requestConsent).toHaveBeenCalledOnce();
        expect(call.settled).toBe(false);
        // No provider request may be sent while the decision is pending.
        expect(provider.doStream).not.toHaveBeenCalled();

        await consent.grant();
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.doStream).toHaveBeenCalledOnce();
        provider.pushText('Hello');
        provider.finish();
        await vi.advanceTimersByTimeAsync(0);

        expect(call.error).toBeUndefined();
        expect(call.value).toMatchObject({ text: 'Hello', finishReason: 'stop' });
        // The middleware's repeat consent check reused the grant.
        expect(consent.requestConsent).toHaveBeenCalledOnce();
    });

    it('still times out a stalled stream at the idle limit after consent, and chunks reset it', async () => {
        const provider = createControlledProviderModel();
        const consent = installPendingConsentRuntime();
        const { model } = createProviderModel(settings);

        const call = observe(streamGenerateText({ model, messages: [{ role: 'user', content: 'hi' }] }));
        await vi.advanceTimersByTimeAsync(CONSENT_READING_TIME_MS);
        await consent.grant();
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.doStream).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_TIMEOUT_MS - 5_000);
        provider.pushText('partial');
        await vi.advanceTimersByTimeAsync(DEFAULT_ACTIVITY_TIMEOUT_MS - 5_000);
        expect(call.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(call.error).toBeInstanceOf(ProviderTimeoutError);
        expect((call.error as InstanceType<typeof ProviderTimeoutError>).timeoutMs)
            .toBe(DEFAULT_ACTIVITY_TIMEOUT_MS);
    });

    it('rejects with the consent decline error and sends no request when the user declines', async () => {
        const provider = createControlledProviderModel();
        const consent = installPendingConsentRuntime();
        const { model } = createProviderModel(settings);

        const call = observe(streamGenerateText({ model, messages: [{ role: 'user', content: 'hi' }] }));
        await vi.advanceTimersByTimeAsync(CONSENT_READING_TIME_MS);
        expect(call.settled).toBe(false);

        consent.decline();
        await vi.advanceTimersByTimeAsync(0);

        expect(call.error).toBeInstanceOf(CloudAiConsentDeclinedError);
        expect(provider.doStream).not.toHaveBeenCalled();
    });

    it('lets a caller abort end the consent wait without sending a request', async () => {
        const provider = createControlledProviderModel();
        installPendingConsentRuntime();
        const { model } = createProviderModel(settings);
        const controller = new AbortController();

        const call = observe(streamGenerateText({
            model,
            messages: [{ role: 'user', content: 'hi' }],
            abortSignal: controller.signal,
        }));
        await vi.advanceTimersByTimeAsync(CONSENT_READING_TIME_MS);
        controller.abort(new Error('user cancelled'));
        await vi.advanceTimersByTimeAsync(0);

        expect((call.error as Error).message).toBe('user cancelled');
        expect(provider.doStream).not.toHaveBeenCalled();
    });

    it('still enforces consent in the model middleware for callers without a preflight', async () => {
        const { streamText } = await import('ai');
        const provider = createControlledProviderModel();
        const consent = installPendingConsentRuntime();
        const { model } = createProviderModel(settings);

        const stream = streamText({ model, messages: [{ role: 'user', content: 'hi' }] });
        const text = observe(Promise.resolve(stream.text));
        await vi.advanceTimersByTimeAsync(CONSENT_READING_TIME_MS);
        expect(consent.requestConsent).toHaveBeenCalledOnce();
        expect(provider.doStream).not.toHaveBeenCalled();

        await consent.grant();
        await vi.advanceTimersByTimeAsync(0);
        provider.pushText('ok');
        provider.finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.doStream).toHaveBeenCalledOnce();
        expect(text.value).toBe('ok');
    });

    it('keeps intent classification alive while consent is pending', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const provider = createControlledProviderModel();
        const consent = installPendingConsentRuntime();

        const call = observe(classifyChatIntent('Analyze this dataset from several angles.', settings, true));
        await vi.advanceTimersByTimeAsync(CONSENT_READING_TIME_MS);
        expect(call.settled).toBe(false);
        expect(provider.doStream).not.toHaveBeenCalled();

        await consent.grant();
        await vi.advanceTimersByTimeAsync(0);
        provider.pushText('batch_analysis');
        provider.finish();
        await vi.advanceTimersByTimeAsync(0);

        expect(call.error).toBeUndefined();
        expect(call.value).toMatchObject({ findings: { intent: 'batch_analysis' } });
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('timed out'));
    });
});
