export const JAVASCRIPT_GUEST_PIN = 'quickjs-emscripten-core/0.32.0 + @jitl/quickjs-wasmfile-release-sync/0.32.0';
export const GUEST_CEILINGS = Object.freeze({
    codeBytes: 256 * 1024, inputBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024 * 1024,
    heapBytes: 128 * 1024 * 1024, stackBytes: 1024 * 1024, timeoutMs: 30_000,
});
export type GuestLimits = { [K in keyof typeof GUEST_CEILINGS]: number };
export type GuestRequest = { generation: number; code: string; inputJson: string; limits: GuestLimits;
    evaluationFault?: import('./evaluationFaults').EvaluationFault };
export type GuestOutcome = {
    generation: number;
    status: 'completed' | 'failed' | 'capacity' | 'timeout' | 'cancelled' | 'unavailable';
    code: string;
    outputJson?: string;
    stdout?: string;
    stderr?: string;
    logsTruncated?: boolean;
    error?: { name: string; message: string };
};
export const GUEST_LOG_BYTES = 16 * 1024;
export const resolveGuestLimits = (values: Partial<GuestLimits> = {}): GuestLimits => {
    const limits = { ...GUEST_CEILINGS, ...values };
    for (const key of Object.keys(GUEST_CEILINGS) as (keyof GuestLimits)[]) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > GUEST_CEILINGS[key]) {
            throw new Error('guest_invalid_limits');
        }
    }
    return limits;
};
export const admitGuestRequest = (request: GuestRequest): void => {
    resolveGuestLimits(request.limits);
    if (!Number.isSafeInteger(request.generation) || request.generation < 1
        || typeof request.code !== 'string' || typeof request.inputJson !== 'string') throw new Error('guest_invalid_request');
    const encoder = new TextEncoder();
    if (encoder.encode(request.code).byteLength > request.limits.codeBytes) throw new Error('guest_code_capacity');
    if (encoder.encode(request.inputJson).byteLength > request.limits.inputBytes) throw new Error('guest_input_capacity');
    const fault = request.evaluationFault;
    if (fault !== undefined && (!fault || Object.keys(fault).sort().join(',') !== 'execution,kind,scheduleSha256'
        || fault.kind !== 'program_failure' || fault.execution !== 1 || !/^[a-f0-9]{64}$/.test(fault.scheduleSha256))) throw new Error('guest_invalid_request');
    JSON.parse(request.inputJson);
};
