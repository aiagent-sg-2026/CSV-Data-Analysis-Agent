import {
    DEFAULT_GATEWAY_MODEL,
    DEFAULT_GATEWAY_SESSION_URL,
    resolveDefaultGatewayProjectId,
} from '../../config/defaultGatewayConfig';
import { awaitGatewayOperation, discardGatewayResponse, throwIfGatewayAborted } from './demoGatewayAbort';

/** Refresh this long before expiry so an in-flight stream never outlives its token. */
export const DEMO_SESSION_REFRESH_MARGIN_MS = 60_000;
export const DEMO_SESSION_ACQUISITION_TIMEOUT_MS = 15_000;

export interface DemoGatewaySession {
    token: string;
    /** Wire model alias chosen by the gateway for this project. */
    model: string;
    expiresAtMs: number;
}

/** Carries the gateway's `error.code` so callers and diagnostics can surface it. */
export class DemoGatewayError extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(message: string, status: number, code?: string) {
        super(code ? `${message} (${code})` : message);
        this.name = 'DemoGatewayError';
        this.status = status;
        this.code = code;
    }
}

// The token lives in memory only: a page reload simply opens a new session.
let currentSession: DemoGatewaySession | null = null;
interface SessionRefresh {
    controller: AbortController;
    promise: Promise<DemoGatewaySession>;
    waiters: number;
}
let inFlightRefresh: SessionRefresh | null = null;

const isFresh = (session: DemoGatewaySession): boolean =>
    session.expiresAtMs - DEMO_SESSION_REFRESH_MARGIN_MS > Date.now();

export const readGatewayErrorBody = async (
    response: Response,
    signal?: AbortSignal,
): Promise<{ code?: string; message?: string }> => {
    try {
        throwIfGatewayAborted(signal);
        const body = await awaitGatewayOperation(response.clone().json(), signal) as { error?: { code?: unknown; message?: unknown } | string };
        if (typeof body.error === 'string') return { message: body.error };
        return {
            code: typeof body.error?.code === 'string' ? body.error.code : undefined,
            message: typeof body.error?.message === 'string' ? body.error.message : undefined,
        };
    } catch {
        throwIfGatewayAborted(signal);
        return {};
    }
};

const openSession = async (signal: AbortSignal): Promise<DemoGatewaySession> => {
    throwIfGatewayAborted(signal);
    const projectId = resolveDefaultGatewayProjectId();
    if (!projectId) {
        throw new DemoGatewayError('The default gateway project is not configured for this build.', 0, 'DEMO_PROJECT_NOT_CONFIGURED');
    }

    const response = await awaitGatewayOperation(globalThis.fetch(DEFAULT_GATEWAY_SESSION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
        signal,
    }), signal, discardGatewayResponse);
    if (!response.ok) {
        const { code, message } = await readGatewayErrorBody(response, signal);
        discardGatewayResponse(response);
        throw new DemoGatewayError(message ?? `Demo session request failed with status ${response.status}.`, response.status, code);
    }

    const body = await awaitGatewayOperation(response.json(), signal) as { token?: unknown; model?: unknown; expires_in?: unknown };
    throwIfGatewayAborted(signal);
    if (typeof body.token !== 'string' || !body.token) {
        throw new DemoGatewayError('The demo gateway returned no session token.', response.status, 'DEMO_SESSION_INVALID');
    }
    // Relative TTL avoids trusting the visitor's clock against a server timestamp.
    const ttlSeconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 900;
    return {
        token: body.token,
        model: typeof body.model === 'string' && body.model ? body.model : DEFAULT_GATEWAY_MODEL,
        expiresAtMs: Date.now() + ttlSeconds * 1000,
    };
};

/** Waiters cancel independently; the shared handshake stops when its last waiter leaves. */
export const getDemoGatewaySession = async (signal?: AbortSignal): Promise<DemoGatewaySession> => {
    throwIfGatewayAborted(signal);
    if (currentSession && isFresh(currentSession)) return currentSession;
    if (!inFlightRefresh) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException('Demo session acquisition timed out.', 'TimeoutError')),
            DEMO_SESSION_ACQUISITION_TIMEOUT_MS);
        const refresh: SessionRefresh = { controller, waiters: 0, promise: Promise.resolve().then(() => openSession(controller.signal)) };
        refresh.promise = refresh.promise
            .then(session => {
                if (inFlightRefresh === refresh && !controller.signal.aborted) currentSession = session;
                return session;
            })
            .finally(() => {
                clearTimeout(timer);
                if (inFlightRefresh === refresh) inFlightRefresh = null;
            });
        inFlightRefresh = refresh;
    }
    const refresh = inFlightRefresh;
    refresh.waiters += 1;
    try {
        return await awaitGatewayOperation(refresh.promise, signal);
    } finally {
        refresh.waiters -= 1;
        if (!refresh.waiters && inFlightRefresh === refresh) {
            inFlightRefresh = null;
            refresh.controller.abort(new DOMException('No callers are waiting for this demo session.', 'AbortError'));
        }
    }
};

/** Drops the cached session when the gateway rejected it (expired or request cap reached). */
export const invalidateDemoGatewaySession = (rejectedToken?: string): void => {
    // A concurrent caller may already have replaced the rejected token.
    if (rejectedToken && currentSession && currentSession.token !== rejectedToken) return;
    currentSession = null;
};

export const resetDemoGatewaySessionForTests = (): void => {
    currentSession = null;
    const refresh = inFlightRefresh;
    inFlightRefresh = null;
    refresh?.controller.abort();
};
