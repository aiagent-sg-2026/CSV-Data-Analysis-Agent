/**
 * Provider-call timeout utilities shared by browser AI workflows.
 *
 * These guards are provider infrastructure, not follow-up loop state. A
 * streaming caller should call signalActivity whenever a response chunk
 * arrives so only an idle connection reaches the timeout.
 */
export const PROVIDER_MODEL_CALL_TIMEOUT_MS = 60_000;

export class ProviderTimeoutError extends Error {
    readonly timeoutMs: number;
    readonly timeoutReason = 'model_call_timeout' as const;

    constructor(timeoutMs: number) {
        super(`Provider model call timed out after ${timeoutMs}ms`);
        this.name = 'ProviderTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

export const isProviderTimeoutError = (
    error: unknown,
): error is ProviderTimeoutError => error instanceof ProviderTimeoutError;

export const raceWithModelTimeout = <T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<T> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
            () => reject(new ProviderTimeoutError(timeoutMs)),
            timeoutMs,
        );
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutHandle);
    }) as Promise<T>;
};

export const raceWithActivityTimeout = <T>(
    task: Promise<T>,
    timeoutMs: number,
): { promise: Promise<T>; signalActivity: () => void } => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let rejectTimeout: (reason: Error) => void;

    const resetTimer = () => {
        clearTimeout(timeoutHandle);
        if (!settled) {
            timeoutHandle = setTimeout(
                () => rejectTimeout(new ProviderTimeoutError(timeoutMs)),
                timeoutMs,
            );
        }
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
        resetTimer();
    });
    const signalActivity = () => resetTimer();
    const promise = Promise.race([task, timeoutPromise]).finally(() => {
        settled = true;
        clearTimeout(timeoutHandle);
    }) as Promise<T>;

    return { promise, signalActivity };
};

/**
 * Pre-request gate that may wait on the user or the browser (for example the
 * cloud AI consent modal or an offline pause) before any network traffic.
 */
export type ProviderRequestPreflight = (abortSignal?: AbortSignal) => Promise<void>;

const providerRequestPreflights = new WeakMap<object, ProviderRequestPreflight>();

/**
 * Associates a pre-request gate with a provider model so activity-timed
 * callers can resolve it before arming their idle timer. The model's own
 * middleware must still enforce the same gate; this registration only moves
 * the user-facing wait outside the timeout window.
 */
export const registerProviderRequestPreflight = <T extends object>(
    model: T,
    preflight: ProviderRequestPreflight,
): T => {
    providerRequestPreflights.set(model, preflight);
    return model;
};

const toAbortError = (abortSignal: AbortSignal): unknown =>
    abortSignal.reason ?? new DOMException('The AI request was cancelled.', 'AbortError');

/**
 * Runs the model's registered pre-request gate, if any. A pending user
 * decision has no time limit, but a caller abort still ends the wait.
 */
export const runProviderRequestPreflight = async (
    model: unknown,
    abortSignal?: AbortSignal,
): Promise<void> => {
    if (typeof model !== 'object' || model === null) return;
    const preflight = providerRequestPreflights.get(model);
    if (!preflight) return;
    if (!abortSignal) {
        await preflight();
        return;
    }
    if (abortSignal.aborted) throw toAbortError(abortSignal);

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(toAbortError(abortSignal));
        abortSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        await Promise.race([preflight(abortSignal), aborted]);
    } finally {
        if (onAbort) abortSignal.removeEventListener('abort', onAbort);
    }
};
