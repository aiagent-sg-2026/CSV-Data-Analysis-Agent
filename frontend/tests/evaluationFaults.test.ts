// @vitest-environment node
import {describe,expect,it} from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import {installEvaluationFaults,consumeEvaluationFault,modelExecutionReceipt} from '../services/sandbox/evaluationFaults';
import type {CodeExecutionReceipt} from '../services/agent/execution/codeExecutionContract';
import {executeQuickJsGuest} from '../services/sandbox/quickJsGuest';
import {resolveGuestLimits} from '../services/sandbox/javascriptGuestProtocol';
import {beginSessionTransition,beginRun,finishRun,scopeRunStore} from '../services/session/sessionOwnership';
import type {StoreApi} from '../services/agent/types';
const store=()=>{let state={sessionId:'fault-test'};return {getState:()=>state,setState:patch=>{state={...state,...patch};}} as StoreApi;};
const policy=()=>({scheduleSha256:'a'.repeat(64),executions:[1]});
describe('evaluator-only execution fault scope',()=>{
    it('consumes only the first execution per independent session and ignores mutable policy changes',()=>{
        const app=store(),other=store(),p=policy(),port=installEvaluationFaults(app,p);p.executions[0]=2;
        const original=beginRun(app,'follow_up','before-approval','turn-1');
        expect(consumeEvaluationFault(scopeRunStore(app,original))).toEqual({kind:'program_failure',execution:1,scheduleSha256:'a'.repeat(64)});
        finishRun(app,original);const fresh=beginRun(app,'follow_up','after-approval','turn-2');
        expect(consumeEvaluationFault(scopeRunStore(app,fresh))).toBeUndefined();finishRun(app,fresh);
        expect(consumeEvaluationFault(other)).toBeUndefined();
        expect(()=>installEvaluationFaults(app,policy())).toThrow('evaluation_fault_policy_invalid');port.dispose();
        const next=installEvaluationFaults(app,policy());expect(consumeEvaluationFault(app)).toBeDefined();next.dispose();
    });
    it('retires the hook on a session transition and rejects an arbitrary failure schedule',()=>{
        const app=store(),port=installEvaluationFaults(app,policy());beginSessionTransition(app);
        expect(consumeEvaluationFault(app)).toBeUndefined();port.dispose();
        expect(()=>installEvaluationFaults(app,{...policy(),executions:[2]})).toThrow('evaluation_fault_policy_invalid');
    });
    it('produces an actual QuickJS failure with unchanged code/input and permits an independent revision',async()=>{
        const app=store(),port=installEvaluationFaults(app,policy()),code='return input.amount;',inputJson='{"amount":-7}';
        const request={generation:1,code,inputJson,limits:resolveGuestLimits(),evaluationFault:consumeEvaluationFault(app)};
        let started=0;
        const failed=await executeQuickJsGuest(request,()=>newQuickJSWASMModuleFromVariant(variant),()=>{started++;});
        expect(failed).toMatchObject({status:'failed',code:'guest_program_failed',error:{message:'Execution failed at the runtime boundary.'}});
        expect(failed.outputJson).toBeUndefined();expect(started).toBe(1);expect(request.code).toBe(code);expect(request.inputJson).toBe(inputJson);
        const revised=await executeQuickJsGuest({...request,generation:2,code:code+'\n// Independent revision',evaluationFault:consumeEvaluationFault(app)},()=>newQuickJSWASMModuleFromVariant(variant));
        expect(revised).toMatchObject({status:'completed',outputJson:'-7'});port.dispose();
    });
    it('omits the schedule from code run/inspect model projections without changing host receipts',()=>{
        const receipt={jobId:'host-failed-job',status:'failed',environmentDigest:'b'.repeat(64),environment:{evaluationFault:{kind:'program_failure',execution:1,scheduleSha256:'a'.repeat(64)}},
            error:{name:'Error',message:'Execution failed at the runtime boundary.'}} as unknown as CodeExecutionReceipt;
        expect(JSON.stringify(modelExecutionReceipt(receipt))).not.toContain('scheduleSha256');
        expect(JSON.stringify(modelExecutionReceipt([receipt]))).not.toContain('evaluationFault');
        expect(modelExecutionReceipt(receipt)).toMatchObject({jobId:'host-failed-job',status:'failed',environmentDigest:'b'.repeat(64)});
        expect(receipt.environment).toHaveProperty('evaluationFault.scheduleSha256','a'.repeat(64));
    });
});
