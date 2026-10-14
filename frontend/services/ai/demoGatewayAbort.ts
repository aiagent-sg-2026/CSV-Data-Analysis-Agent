export const throwIfGatewayAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Gateway request cancelled.', 'AbortError');
};

/** Stop waiting even when a fetch implementation ignores the supplied signal. */
export const awaitGatewayOperation = <T>(
    operation: Promise<T>,
    signal?: AbortSignal,
    discardLateResult?: (value: T) => void,
): Promise<T> => new Promise((resolve, reject) => {
    let cancelled = false;
    const abort = () => {
        cancelled = true;
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason ?? new DOMException('Gateway request cancelled.', 'AbortError'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    operation.then(value => {
        signal?.removeEventListener('abort', abort);
        if (cancelled) discardLateResult?.(value);
        else resolve(value);
    }, error => {
        signal?.removeEventListener('abort', abort);
        reject(error);
    });
});

export const discardGatewayResponse = (response: Response): void => {
    void response.body?.cancel().catch(() => undefined);
};

/** The caller deadline covers queueing, handshake, request headers and retry waits. */
export const createGatewayDeadline = (parent: AbortSignal | undefined, timeoutMs: number, message: string) => {
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason);
    if (parent?.aborted) abort();
    else parent?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException(message, 'TimeoutError')), timeoutMs);
    const clearDeadline = () => clearTimeout(timer);
    return {
        signal: controller.signal,
        clearDeadline,
        dispose: () => {
            clearDeadline();
            parent?.removeEventListener('abort', abort);
        },
    };
};

export const waitForGatewayRetry = async (ms: number, signal: AbortSignal): Promise<void> => {
    throwIfGatewayAborted(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await awaitGatewayOperation(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal);
    } finally {
        clearTimeout(timer);
    }
};
