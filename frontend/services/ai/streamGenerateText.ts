/**
 * streamGenerateText — drop-in replacement for `generateText` that uses
 * `streamText` + activity-aware idle timeout under the hood.
 *
 * Why: `generateText` is non-streaming — the entire response must complete
 * before any data is returned.  Thinking models (Gemma 4, etc.) can spend
 * 30-60+ seconds in a reasoning phase that produces `reasoning-delta` SSE
 * chunks but zero `text-delta` chunks.  A fixed-deadline timeout treats
 * this healthy thinking as silence and kills the request.
 *
 * This helper drains `fullStream` (which includes reasoning-delta) and
 * calls `signalActivity()` on every chunk, resetting the idle timer.
 * The timeout only fires when the connection goes truly idle for
 * `activityTimeoutMs` consecutive milliseconds.
 *
 * Usage:
 *   // Before:
 *   const result = await generateText({ model, messages, output, abortSignal });
 *
 *   // After:
 *   const result = await streamGenerateText({ model, messages, output, abortSignal });
 *
 * Returns `{ text, finishReason, output }` — same shape consumers expect
 * from `generateText`.
 */

import { streamText } from 'ai';
import type { LanguageModel } from 'ai';
import {
    isProviderTimeoutError,
    raceWithActivityTimeout,
    runProviderRequestPreflight,
} from './providerActivityGuards';
import { CloudAiConsentDeclinedError } from '../privacy/cloudAiConsent';

/** Default idle timeout: 30 seconds between SSE chunks. */
export const DEFAULT_ACTIVITY_TIMEOUT_MS = 30_000;

// Matched by name rather than `NoOutputGeneratedError.isInstance` because many
// tests replace the 'ai' module with a factory that only provides streamText.
const NO_OUTPUT_GENERATED_ERROR_NAME = 'AI_NoOutputGeneratedError';

const errorName = (error: unknown): unknown =>
    typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;

/**
 * When the provider request itself fails (for example HTTP 400/413/429/5xx),
 * AI SDK 6 records no step and rejects `text`/`finishReason` with a new
 * NoOutputGeneratedError that carries no cause; the real error only reaches
 * `onError`. Return that captured error instead so status- and message-based
 * classifiers (transient retry, overflow compaction, gateway messages) see it.
 * Caller aborts and abort-shaped errors keep the SDK's own rejection.
 */
const resolveStreamFailure = (
    reason: unknown,
    streamedError: unknown,
    abortSignal: AbortSignal | undefined,
): unknown => {
    if (abortSignal?.aborted) return reason;
    if (!(streamedError instanceof Error)) return reason;
    if (errorName(reason) !== NO_OUTPUT_GENERATED_ERROR_NAME) return reason;
    const streamedName = errorName(streamedError);
    if (streamedName === 'AbortError' || streamedName === 'ResponseAborted') return reason;
    return streamedError;
};

/**
 * Activity-aware wrapper around `streamText`.
 *
 * Accepts the same options as `streamText` plus an optional
 * `activityTimeoutMs` (default 30 s).  Every SSE chunk — including
 * reasoning/thinking tokens — resets the idle timer.
 */
export const streamGenerateText = async (
    options: Parameters<typeof streamText>[0] & { activityTimeoutMs?: number },
): Promise<{ text: string; finishReason: string; output: unknown }> => {
    const { activityTimeoutMs = DEFAULT_ACTIVITY_TIMEOUT_MS, ...streamOptions } = options;
    const callerOnError = streamOptions.onError;
    // Resolve consent and offline waits before the idle timer is armed. These
    // waits depend on the user or the browser, not on provider activity, and
    // no request is sent until they resolve.
    try {
        await runProviderRequestPreflight(streamOptions.model, streamOptions.abortSignal);
    } catch (error) {
        // Mirror the streamText onError contract for callers that observe it.
        await callerOnError?.({ error });
        throw error;
    }
    let streamedError: unknown;
    const stream = streamText({
        ...streamOptions,
        onError: async event => {
            streamedError = event.error;
            if (callerOnError) {
                await callerOnError(event);
                return;
            }
            if (!(event.error instanceof CloudAiConsentDeclinedError)) {
                console.error(event.error);
            }
        },
    });

    const { promise, signalActivity } = raceWithActivityTimeout(
        (async () => {
            // Attach rejection handlers immediately. Some AI SDK providers reject
            // text, finishReason, and output together. Waiting until fullStream
            // finishes before observing these promises leaves sibling rejections
            // unhandled when the stream or text promise fails first.
            const settle = <T>(value: PromiseLike<T>) => Promise.resolve(value).then(
                result => ({ status: 'fulfilled' as const, value: result }),
                reason => ({ status: 'rejected' as const, reason }),
            );
            const textResultPromise = settle(stream.text);
            const finishReasonResultPromise = settle(stream.finishReason);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const outputResultPromise = settle(Promise.resolve((stream as any).output));

            // Drain fullStream so every SSE event (including reasoning-delta)
            // resets the idle timer.
            for await (const part of stream.fullStream) {
                signalActivity();
                void part;
            }

            const [textResult, finishReasonResult, outputResult] = await Promise.all([
                textResultPromise,
                finishReasonResultPromise,
                outputResultPromise,
            ]);
            if (streamedError instanceof CloudAiConsentDeclinedError) {
                throw streamedError;
            }
            if (textResult.status === 'rejected') {
                throw resolveStreamFailure(textResult.reason, streamedError, streamOptions.abortSignal);
            }
            if (finishReasonResult.status === 'rejected') {
                throw resolveStreamFailure(finishReasonResult.reason, streamedError, streamOptions.abortSignal);
            }
            // An error event after the response started (an upstream failure
            // or rate limit reported inside the stream) settles `text` as ''
            // with finishReason 'error'. Returning that as a normal answer
            // would hide the failure from retry logic and callers.
            if (
                finishReasonResult.value === 'error'
                && !textResult.value.trim()
                && streamedError instanceof Error
                && !streamOptions.abortSignal?.aborted
            ) {
                throw streamedError;
            }

            // stream.output only resolves when Output.object({ schema }) was
            // passed. A rejected output sibling is non-fatal for text callers.
            const output = outputResult.status === 'fulfilled'
                ? outputResult.value
                : undefined;

            return {
                text: textResult.value,
                finishReason: finishReasonResult.value as string,
                output,
            };
        })(),
        activityTimeoutMs,
    );

    return promise;
};

export { isProviderTimeoutError };
