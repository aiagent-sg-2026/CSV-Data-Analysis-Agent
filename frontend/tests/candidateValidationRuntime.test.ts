// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
vi.mock('../services/sandbox/javascriptGuestClient',async()=>{
    const {newQuickJSWASMModuleFromVariant}=await import('quickjs-emscripten-core');
    const {default:variant}=await import('@jitl/quickjs-wasmfile-release-sync');
    const {executeQuickJsGuest}=await import('../services/sandbox/quickJsGuest');
    const {resolveGuestLimits}=await import('../services/sandbox/javascriptGuestProtocol');
    const wasm=newQuickJSWASMModuleFromVariant(variant);
    return {createJavaScriptGuest:()=>({run:(code:string,inputJson:string,options:Parameters<typeof resolveGuestLimits>[0]&{limits?:Parameters<typeof resolveGuestLimits>[0];onStarted?:()=>void})=>executeQuickJsGuest({generation:1,code,inputJson,limits:resolveGuestLimits(options?.limits)},()=>wasm,options?.onStarted),cancel(){},dispose(){}})};
});
import {qualifyCandidateValidation} from '../services/data/candidateValidationQualification';
describe('actual Pi independent validation loop',()=>{
    it('accepts host reference-equivalent output and rejects equal-total group/grain/unit/join faults, ambiguity, forged receipts and candidate factual fallback',async()=>{
        const result=await qualifyCandidateValidation(new AbortController().signal);expect(result.observations).toHaveLength(10);
        for(const o of result.observations)expect(o.passed,JSON.stringify(o)).toBe(true);expect(result.passed).toBe(true);
    });
    it('returns incomplete instead of fabricating checks after cancellation',async()=>{const c=new AbortController();c.abort();const result=await qualifyCandidateValidation(c.signal);expect(result.passed).toBe(false);expect(result.observations).toEqual([]);});
    it('keeps valid receipt references containing 999 while refusing the actual provider claim',async()=>{
        let id=0;const uuid=vi.spyOn(crypto,'randomUUID').mockImplementation(()=>`99900000-0000-4000-8000-${(++id).toString(16).padStart(12,'0')}`);
        try{const result=await qualifyCandidateValidation(new AbortController().signal);expect(result.observations.filter(o=>!o.passed)).toEqual([]);expect(result.passed).toBe(true);}
        finally{uuid.mockRestore();}
    });
});
