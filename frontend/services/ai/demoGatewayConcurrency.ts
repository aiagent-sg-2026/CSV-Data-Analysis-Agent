import { throwIfGatewayAborted, waitForGatewayRetry } from './demoGatewayAbort';

/**
 * Each demo session allows 2 concurrent requests. Queue requests client-side
 * so bursts wait instead of failing with DEMO_SESSION_CONCURRENCY_LIMIT.
 */
export const DEMO_SESSION_MAX_CONCURRENT_REQUESTS = 2;

/** Per-browser protection, not a shared-IP guarantee across tabs or devices. */
export const DEMO_IP_MAX_REQUESTS_PER_MINUTE = 28;
export const DEMO_IP_WINDOW_MS = 60_000;

export const createRateWindowLimiter = (
    maxRequests: number,
    windowMs: number,
    now: () => number = Date.now,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) =>
        waitForGatewayRetry(ms, signal ?? new AbortController().signal),
) => {
    const sentAt: number[] = [];
    return {
        waitForTurn: async (signal?: AbortSignal): Promise<void> => {
            for (;;) {
                throwIfGatewayAborted(signal);
                const current = now();
                while (sentAt.length && current - sentAt[0] >= windowMs) sentAt.shift();
                if (sentAt.length < maxRequests) {
                    sentAt.push(current);
                    return;
                }
                await sleep(sentAt[0] + windowMs - current + 25, signal);
            }
        },
    };
};

export interface ConcurrencyLimiter {
    /** Resolves with a one-shot release function once a slot is free. */
    acquire: (signal?: AbortSignal) => Promise<() => void>;
}

export const createConcurrencyLimiter = (max: number): ConcurrencyLimiter => {
    let active = 0;
    const waiting: Array<() => void> = [];

    const grant = (): (() => void) => {
        active += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            active -= 1;
            waiting.shift()?.();
        };
    };

    return {
        acquire: (signal?: AbortSignal) => new Promise((resolve, reject) => {
            throwIfGatewayAborted(signal);
            if (active < max) {
                resolve(grant());
                return;
            }
            const enter = () => {
                signal?.removeEventListener('abort', abort);
                resolve(grant());
            };
            const abort = () => {
                const index = waiting.indexOf(enter);
                if (index >= 0) waiting.splice(index, 1);
                signal?.removeEventListener('abort', abort);
                reject(signal?.reason ?? new DOMException('Gateway slot wait cancelled.', 'AbortError'));
            };
            waiting.push(enter);
            signal?.addEventListener('abort', abort, { once: true });
        }),
    };
};

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// Safety net: a caller that never reads or cancels a body must not hold a slot forever.
const MAX_SLOT_HOLD_MS = 10 * 60 * 1000;

/** Holds the slot until the response body is fully read, errored or cancelled. */
export const releaseWhenBodyDone = (
    response: Response,
    releaseSlot: () => void,
    maxHoldMs = MAX_SLOT_HOLD_MS,
    signal?: AbortSignal,
): Response => {
    if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
        releaseSlot();
        return response;
    }
    let finished = false;
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const reader = response.body.getReader();
    const release = () => {
        if (finished) return;
        finished = true;
        clearTimeout(holdTimer);
        signal?.removeEventListener('abort', abort);
        releaseSlot();
    };
    const terminate = (reason: unknown) => {
        if (finished) return;
        release();
        streamController.error(reason);
        void reader.cancel(reason).catch(() => undefined);
    };
    const abort = () => terminate(signal?.reason ?? new DOMException('Gateway stream cancelled.', 'AbortError'));
    const holdTimer = setTimeout(() => terminate(new DOMException('Gateway response body timed out.', 'TimeoutError')), maxHoldMs);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
        },
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (finished) return;
                if (done) {
                    controller.close();
                    release();
                } else {
                    controller.enqueue(value);
                }
            } catch (error) {
                if (finished) return;
                release();
                controller.error(error);
            }
        },
        cancel(reason) {
            release();
            return reader.cancel(reason);
        },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};
