import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import { admitGuestRequest, GUEST_LOG_BYTES, type GuestOutcome, type GuestRequest } from './javascriptGuestProtocol';

// Private guest handles capture serializers and log quotas before generated code
// runs in a separate lexical environment. Console never calls into the host.
const BOOTSTRAP = `(() => {
    const parse = JSON.parse, stringify = JSON.stringify, evaluate = eval;
    const finite = Number.isFinite, ErrorType = Error, string = String;
    const create = Object.create;
    const charCode = Function.prototype.call.bind(String.prototype.charCodeAt);
    const slice = Function.prototype.call.bind(String.prototype.slice);
    const push = Function.prototype.call.bind(Array.prototype.push);
    const join = Function.prototype.call.bind(Array.prototype.join);
    const exec = Function.prototype.call.bind(RegExp.prototype.exec), nonAscii = /[^\\x00-\\x7f]/;
    const min = Math.min;
    const bounded = (text, limit) => {
        // The native ASCII scan avoids a per-character guest loop for large JSON.
        if (!exec(nonAscii, text)) return { text: slice(text, 0, limit), bytes: min(text.length,limit), truncated: text.length > limit };
        let bytes = 0, i = 0;
        for (; i < text.length; i++) {
            const c = charCode(text, i);
            let size = c < 128 ? 1 : c < 2048 ? 2 : 3;
            const pair = c >= 0xd800 && c <= 0xdbff && charCode(text, i+1) >= 0xdc00 && charCode(text, i+1) <= 0xdfff;
            if (pair) size = 4;
            if (bytes + size > limit) break;
            bytes += size; if (pair) i++;
        }
        return { text: slice(text, 0, i), bytes, truncated: i < text.length };
    };
    return (code, inputJson, outputLimit, injectedFailure) => {
        let stdout = '', stderr = '', outBytes = 0, errBytes = 0, logsTruncated = false;
        const log = (error, args) => {
            const parts = []; for (let i=0;i<args.length;i++) push(parts, string(args[i]));
            const b = bounded(join(parts, ' ') + '\\n', ${GUEST_LOG_BYTES} - (error ? errBytes : outBytes));
            if (error) { stderr += b.text; errBytes += b.bytes; } else { stdout += b.text; outBytes += b.bytes; }
            logsTruncated = logsTruncated || b.truncated;
        };
        globalThis.console = { log: (...args) => log(false,args), info: (...args) => log(false,args),
            warn: (...args) => log(true,args), error: (...args) => log(true,args) };
        const finish = (status, code, outputJson, error) => {
            const payload = create(null);
            payload.status=status; payload.code=code; payload.outputJson=outputJson; payload.error=error;
            payload.stdout=stdout; payload.stderr=stderr; payload.logsTruncated=logsTruncated;
            return stringify(payload);
        };
        const input = parse(inputJson);
        let result;
        try {
            if (injectedFailure) throw new ErrorType('Execution failed at the runtime boundary.');
            result = evaluate('(function(input) { "use strict";\\n' + code + '\\n})')(input);
        }
        catch (error) {
            const detail = create(null); detail.name='Error'; detail.message='Program failed';
            try { detail.name=bounded(string(error.name),80).text; detail.message=bounded(string(error.message),2048).text; } catch {}
            return finish('failed', 'guest_program_failed', null, detail);
        }
        let json;
        try {
            if (result && typeof result.then === 'function') throw new ErrorType();
            json = stringify(result, (_key, value) => {
                const type = typeof value;
                if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint'
                    || (type === 'number' && !finite(value))) throw new ErrorType();
                return value;
            });
        } catch { return finish('failed','guest_output_invalid',null,null); }
        if (typeof json !== 'string' || bounded(json, outputLimit).truncated) return finish('capacity','guest_output_capacity',null,null);
        return finish('completed','guest_completed',json,null);
    };
})()`;

export const executeQuickJsGuest = async (request: GuestRequest, load: () => Promise<QuickJSWASMModule>, onStarted?: () => void): Promise<GuestOutcome> => {
    const outcome = (status: GuestOutcome['status'], code: string): GuestOutcome => ({ generation: request.generation, status, code });
    try { admitGuestRequest(request); } catch { return outcome('capacity', 'guest_request_rejected'); }
    const module = await load();
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(request.limits.heapBytes);
    runtime.setMaxStackSize(request.limits.stackBytes);
    const deadline = performance.now() + request.limits.timeoutMs;
    let interrupted = false;
    runtime.setInterruptHandler(() => { interrupted = performance.now() >= deadline; return interrupted; });
    runtime.removeModuleLoader();
    const context = runtime.newContext();
    try {
        const bootstrap = context.evalCode(BOOTSTRAP);
        if (!('value' in bootstrap)) { bootstrap.error.dispose(); return outcome('capacity', 'guest_initialization_capacity'); }
        const fn = bootstrap.value;
        const code = context.newString(request.code), input = context.newString(request.inputJson);
        const limit = context.newNumber(request.limits.outputBytes);
        try {
            onStarted?.();
            const result = context.callFunction(fn, context.undefined, code, input, limit,
                request.evaluationFault ? context.true : context.false);
            if (!('value' in result)) {
                result.error.dispose();
                return outcome(interrupted ? 'timeout' : 'failed', interrupted ? 'guest_deadline' : 'guest_execution_rejected');
            }
            try {
                if (interrupted) return outcome('timeout', 'guest_deadline');
                if (runtime.hasPendingJob()) return outcome('failed', 'guest_async_unsupported');
                const payload = JSON.parse(context.getString(result.value));
                if (payload.status === 'completed') {
                    if (typeof payload.outputJson !== 'string' || new TextEncoder().encode(payload.outputJson).byteLength > request.limits.outputBytes) return outcome('capacity', 'guest_output_capacity');
                    JSON.parse(payload.outputJson);
                }
                return { ...outcome(payload.status, payload.code), ...(payload.outputJson !== null ? { outputJson: payload.outputJson } : {}),
                    stdout: payload.stdout, stderr: payload.stderr, logsTruncated: payload.logsTruncated, ...(payload.error ? { error: payload.error } : {}) };
            } finally { result.value.dispose(); }
        } finally { limit.dispose(); input.dispose(); code.dispose(); fn.dispose(); }
    } finally { context.dispose(); runtime.dispose(); }
};
