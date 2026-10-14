// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import {executeQuickJsGuest} from '../services/sandbox/quickJsGuest';
import {resolveGuestLimits} from '../services/sandbox/javascriptGuestProtocol';
import {qualifyEvidenceAdmission} from '../services/agent/execution/evidenceAdmissionQualification';
import {referencePearson,type RequestedComputationScope} from '../services/agent/execution/computationEvidence';

const scope:RequestedComputationScope={method:'pearson_correlation',x:'X',y:'Y',missingPolicy:'pairwise_complete',seed:'none'};
const guestFactory:NonNullable<Parameters<typeof qualifyEvidenceAdmission>[2]>=()=>({run:(code,inputJson,options)=>
    executeQuickJsGuest({generation:1,code,inputJson,limits:resolveGuestLimits(options.limits)},
        ()=>newQuickJSWASMModuleFromVariant(variant),options.onStarted),cancel(){},dispose(){}});
describe('independent computation evidence',()=>{
    it('cancels fixture preparation before starting Pi or a guest',async()=>{
        const controller=new AbortController(),reason=new Error('Stop during preparation'),run=vi.fn();
        await expect(qualifyEvidenceAdmission(controller.signal,undefined,()=>{
            controller.abort(reason);return {run,cancel(){},dispose(){}};
        })).rejects.toBe(reason);
        expect(run).not.toHaveBeenCalled();
    });
    it('does not mistake a host lineage ID containing 999 for provider numeric text',async()=>{
        let id=0;
        const uuid=vi.spyOn(crypto,'randomUUID').mockImplementation(()=>`99900000-0000-4000-8000-${(++id).toString(16).padStart(12,'0')}`);
        try{
            const result=await qualifyEvidenceAdmission(new AbortController().signal,undefined,guestFactory);
            expect(result.observations.filter(c=>!c.passed)).toEqual([]);
        }finally{uuid.mockRestore();}
    },30000);
    it('runs actual Pi, dispatcher, native query engine and pinned QuickJS attack cases',async()=>{
        const result=await qualifyEvidenceAdmission(new AbortController().signal,undefined,guestFactory);
        expect(result.observations.filter(c=>!c.passed)).toEqual([]);
        expect(result.observations).toHaveLength(27);
    },30000);
    it('checks symmetry, affine sign, nontrivial reference and missing pairs independently',()=>{
        const rows=[{X:1,Y:1},{X:2,Y:4},{X:3,Y:2},{X:null,Y:99}];
        const r=referencePearson(rows,scope);
        expect(r.n).toBe(3);expect(r.excluded).toBe(1);
        // Hand oracle: centered cross product 1, X sum of squares 2, Y sum of squares 14/3.
        expect(r.coefficient).toBeCloseTo(Math.sqrt(3/28),12);
        expect(referencePearson(rows,{...scope,x:'Y',y:'X'}).coefficient).toBeCloseTo(r.coefficient!,12);
        expect(referencePearson(rows.map(p=>({...p,X:p.X===null?null:-2*p.X+100})),scope).coefficient).toBeCloseTo(-r.coefficient!,12);
        expect(referencePearson([{X:1e300,Y:1e300},{X:2e300,Y:2e300},{X:3e300,Y:3e300}],scope).coefficient).toBeCloseTo(1,12);
    });
    it.each([[],[{X:1,Y:2}],[{X:1,Y:2},{X:1,Y:3}]].map(rows=>[rows]))('represents an undefined coefficient explicitly',rows=>{
        expect(referencePearson(rows,scope).coefficient).toBeNull();
    });
    it.each(['1','NaN',true,Number.POSITIVE_INFINITY])('refuses untyped or nonfinite numerical input %s',X=>{
        expect(()=>referencePearson([{X,Y:1},{X:2,Y:2}],scope)).toThrow('typed_numeric_input_required');
    });
});
