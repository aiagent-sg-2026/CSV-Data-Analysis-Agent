// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
vi.mock('../services/sandbox/javascriptGuestClient',async()=>{
    const {newQuickJSWASMModuleFromVariant}=await import('quickjs-emscripten-core');
    const {default:variant}=await import('@jitl/quickjs-wasmfile-release-sync');
    const {executeQuickJsGuest}=await import('../services/sandbox/quickJsGuest');
    const {resolveGuestLimits}=await import('../services/sandbox/javascriptGuestProtocol');
    const wasm=newQuickJSWASMModuleFromVariant(variant);
    return {createJavaScriptGuest:()=>({run:(code:string,inputJson:string,options:Parameters<typeof resolveGuestLimits>[0]&{limits?:Parameters<typeof resolveGuestLimits>[0];onStarted?:()=>void})=>
        executeQuickJsGuest({generation:1,code,inputJson,limits:resolveGuestLimits(options?.limits)},()=>wasm,options?.onStarted),cancel(){},dispose(){}})};
});
import {qualifyCandidateStaging} from '../services/data/candidateStagingQualification';
describe('real Pi candidate tool loop',()=>{
    it('stages/reads/diffs both complete table and raw source outputs, fences rejection and abandonment, and shares initial preparation',async()=>{
        const result=await qualifyCandidateStaging(new AbortController().signal);
        expect(result.observations).toHaveLength(7);
        for(const observation of result.observations)expect(observation.passed,JSON.stringify(observation)).toBe(true);
        expect(result.passed).toBe(true);
    });
    it('does not fabricate passed checks after Stop before starting',async()=>{
        const controller=new AbortController();controller.abort();
        const result=await qualifyCandidateStaging(controller.signal);
        expect(result.passed).toBe(false);expect(result.observations).toEqual([]);
    });
});
