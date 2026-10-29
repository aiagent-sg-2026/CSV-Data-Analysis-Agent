import {
    DEMO_SESSION_MAX_CONCURRENT_REQUESTS,
    DEMO_IP_MAX_REQUESTS_PER_MINUTE,
    DEMO_IP_WINDOW_MS,
    createRateWindowLimiter,
    createConcurrencyLimiter,
    releaseWhenBodyDone,
} from './demoGatewayConcurrency';
import { recordDemoGatewayRequest } from './demoGatewayRequestLog';
import { endsWithAssistantMessage, sanitizeDemoGatewayInput } from './demoGatewayInputSanitizer';
import {
    getDemoGatewaySession,
    invalidateDemoGatewaySession,
    readGatewayErrorBody,
} from './demoGatewaySession';
import { awaitGatewayOperation, createGatewayDeadline, discardGatewayResponse, throwIfGatewayAborted, waitForGatewayRetry } from './demoGatewayAbort';

/**
 * Normalizes browser provider requests across Chromium and WebKit.
 *
 * Some provider SDKs add a User-Agent header. Chromium silently removes this
 * forbidden browser header, while WebKit may include it in the CORS preflight.
 * Removing it at the shared provider boundary keeps both engines equivalent.
 */
export const fetchWithoutForbiddenUserAgent: typeof fetch = (
    input,
    init,
) => {
    const inheritedHeaders = input instanceof Request
        ? input.headers
        : undefined;
    const headers = new Headers(init?.headers ?? inheritedHeaders);
    headers.delete('user-agent');
    return globalThis.fetch(input, {
        ...init,
        headers,
    });
};

const sendWithSession = async (request: Request, body: Record<string, unknown>) => {
    const session = await getDemoGatewaySession(request.signal);
    throwIfGatewayAborted(request.signal);
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${session.token}`);
    // Count sends, not time spent waiting for a concurrency slot or session handshake.
    await rateWindowLimiter.waitForTurn(request.signal);
    throwIfGatewayAborted(request.signal);
    const response = await awaitGatewayOperation(fetchWithoutForbiddenUserAgent(new Request(request, {
        headers,
        // The wire model is the alias the session was issued for.
        body: JSON.stringify({ ...body, model: session.model }),
    })), request.signal, discardGatewayResponse);
    return { response, token: session.token };
};

const SESSION_LIMIT_MESSAGE = 'demo session request limit reached';
const CONCURRENCY_RETRY_DELAYS_MS = [400, 1200];
export const DEMO_GATEWAY_REQUEST_TIMEOUT_MS = 45_000;

let rateWindowLimiter = createRateWindowLimiter(DEMO_IP_MAX_REQUESTS_PER_MINUTE, DEMO_IP_WINDOW_MS);
let requestLimiter = createConcurrencyLimiter(DEMO_SESSION_MAX_CONCURRENT_REQUESTS);

export const resetDemoGatewayRequestLimiterForTests = (): void => {
    rateWindowLimiter = createRateWindowLimiter(DEMO_IP_MAX_REQUESTS_PER_MINUTE, DEMO_IP_WINDOW_MS);
    requestLimiter = createConcurrencyLimiter(DEMO_SESSION_MAX_CONCURRENT_REQUESTS);
};

type Rejection = 'refresh_session' | 'wait_for_slot' | 'wait_for_ip_window' | null;

const ipRetryDelayMs = (response: Response): number => {
    const value = response.headers.get('retry-after');
    const seconds = value === null ? NaN : Number(value);
    const delay = Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000 : value ? Date.parse(value) - Date.now() : NaN;
    return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 60_000)) : 20_000;
};

/** Classifies gateway rejections the client can recover from by itself. */
const classifyRejection = async (response: Response, signal: AbortSignal): Promise<Rejection> => {
    if (response.status === 401) return 'refresh_session';
    if (response.status !== 429) return null;
    const { code, message } = await readGatewayErrorBody(response, signal);
    if (code === 'DEMO_SESSION_REQUEST_LIMIT' || message?.toLowerCase().includes(SESSION_LIMIT_MESSAGE)) {
        return 'refresh_session';
    }
    if (code === 'DEMO_IP_RATE_LIMIT' || message?.toLowerCase().includes('demo ip rate limit')) return 'wait_for_ip_window';
    return code === 'DEMO_SESSION_CONCURRENCY_LIMIT' ? 'wait_for_slot' : null;
};

/**
 * Enforce the demo gateway's request contract at the final browser boundary:
 * confirmed-schema input items, no max_output_tokens/top_p, a short-lived dmo_
 * bearer token, the session's model alias, at most 2 requests in flight, and
 * one session refresh (plus short waits for a free slot) on recoverable 4xx.
 */
export const fetchDefaultGateway: typeof fetch = async (input, init) => {
    const original = new Request(input, init);
    if (original.method.toUpperCase() !== 'POST') {
        return fetchWithoutForbiddenUserAgent(original);
    }
    const deadline = createGatewayDeadline(original.signal, DEMO_GATEWAY_REQUEST_TIMEOUT_MS, 'Demo gateway request timed out.');
    const request = new Request(original, { signal: deadline.signal });
    try {
        throwIfGatewayAborted(request.signal);
        let payload: unknown;
        try {
            payload = JSON.parse(await awaitGatewayOperation(request.clone().text(), request.signal));
        } catch {
            throwIfGatewayAborted(request.signal);
            throw new Error('The demo gateway requires a JSON request body.');
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('The demo gateway requires a JSON object request body.');
        }

        const body = sanitizeDemoGatewayInput(payload as Record<string, unknown>);
        delete body.max_output_tokens;
        if (endsWithAssistantMessage(body.input)) {
            console.warn('[DemoGateway] Request history ends with an assistant message; the upstream model may reject it.');
        }

        recordDemoGatewayRequest(body);
        let refreshed = false;
        let slotWaits = 0;
        let ipWaits = 0;
        for (;;) {
            const release = await requestLimiter.acquire(request.signal);
            let transferred = false;
            let outcome: { response: Response; token: string } | undefined;
            let rejection: Rejection;
            try {
                throwIfGatewayAborted(request.signal);
                outcome = await sendWithSession(request.clone(), body);
                rejection = await classifyRejection(outcome.response, request.signal);
                throwIfGatewayAborted(request.signal);
                const canRetry = (rejection === 'refresh_session' && !refreshed)
                    || (rejection === 'wait_for_slot' && slotWaits < CONCURRENCY_RETRY_DELAYS_MS.length)
                    || (rejection === 'wait_for_ip_window' && ipWaits < 2);
                if (!canRetry) {
                    deadline.clearDeadline();
                    const response = releaseWhenBodyDone(outcome.response, () => { release(); deadline.dispose(); }, undefined, request.signal);
                    transferred = true;
                    return response;
                }
            } finally {
                if (!transferred) {
                    if (outcome) discardGatewayResponse(outcome.response);
                    release();
                }
            }
            if (rejection === 'refresh_session') {
                refreshed = true;
                invalidateDemoGatewaySession(outcome.token);
            } else if (rejection === 'wait_for_ip_window') {
                ipWaits += 1;
                await waitForGatewayRetry(ipRetryDelayMs(outcome.response), request.signal);
            } else {
                await waitForGatewayRetry(CONCURRENCY_RETRY_DELAYS_MS[slotWaits], request.signal);
                slotWaits += 1;
            }
        }
    } catch (error) {
        deadline.dispose();
        throw error;
    }
};
