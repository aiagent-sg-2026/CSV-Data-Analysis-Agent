// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
const captureHook=vi.hoisted(()=>({wait:undefined as (()=>Promise<void>)|undefined}));
vi.mock('../services/data/immutableCsvSource',async importActual=>{
    const actual=await importActual<typeof import('../services/data/immutableCsvSource')>();
    return {...actual,captureCsvSource:async(...args:Parameters<typeof actual.captureCsvSource>)=>{await captureHook.wait?.();return actual.captureCsvSource(...args);}};
});
vi.mock('../services/sandbox/javascriptGuestClient',async()=>{
    const {newQuickJSWASMModuleFromVariant}=await import('quickjs-emscripten-core');
    const {default:variant}=await import('@jitl/quickjs-wasmfile-release-sync');
    const {executeQuickJsGuest}=await import('../services/sandbox/quickJsGuest');
    const {resolveGuestLimits}=await import('../services/sandbox/javascriptGuestProtocol');
    const wasm=newQuickJSWASMModuleFromVariant(variant);
    return {createJavaScriptGuest:()=>({run:(code:string,inputJson:string,options:{limits?:Parameters<typeof resolveGuestLimits>[0];onStarted?:()=>void})=>executeQuickJsGuest({generation:1,code,inputJson,limits:resolveGuestLimits(options?.limits)},()=>wasm,options?.onStarted),cancel(){},dispose(){}})};
});
import {qualifyInferredMeaning} from '../services/data/inferredMeaningQualification';
describe('actual Pi automatic meaning tool loop',()=>{
    it('infers without semantic confirmation and rejects wrong output, invented unit, tail ambiguity and late reference installation',async()=>{
        const result=await qualifyInferredMeaning(new AbortController().signal);
        expect(result.observations).toHaveLength(6);
        expect(result.observations.filter(o=>!o.passed)).toEqual([]);expect(result.passed).toBe(true);
    });
    it('does not fabricate qualification observations on Stop',async()=>{
        const controller=new AbortController();controller.abort();const result=await qualifyInferredMeaning(controller.signal);
        expect(result.passed).toBe(false);expect(result.observations).toEqual([]);
    });
    it('does not start the source case after Stop during source preparation',async()=>{
        let release!:()=>void,entered!:()=>void;
        const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
        const controller=new AbortController();captureHook.wait=async()=>{entered();await gate;};
        try{
            const running=qualifyInferredMeaning(controller.signal);await ready;controller.abort();release();
            const result=await running;expect(result.passed).toBe(false);expect(result.observations.map(o=>o.id)).toEqual(['table']);
        }finally{release();captureHook.wait=undefined;}
    });
});
