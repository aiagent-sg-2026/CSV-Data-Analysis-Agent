// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {createEvaluationStream} from '../services/agent/runtime/pi/piEvaluationRuntime';
const model={id:'mock',provider:'openai',api:'openai-responses'} as never;
const context={messages:[],tools:[]} as never;
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
describe('metered production Pi evaluation stream',()=>{
    it('waits for host reservation and refuses assistant output when the budget/transport rejects',async()=>{
        const result=await (await createEvaluationStream(async()=>{throw new Error('Bearer must-not-leak');})(model,context)).result();
        expect(result.stopReason).toBe('error');expect(result.errorMessage).toBe('evaluation_transport_refused');
        expect(JSON.stringify(result)).not.toContain('must-not-leak');
    });
    it('preserves actual tool-call content after metering and forwards no credential options',async()=>{
        let captured:unknown;
        const stream=createEvaluationStream(async request=>{captured=request;return {content:[{type:'text',text:'untrusted provider text'}],usage};});
        const result=await (await stream(model,context,{apiKey:'never-transport-options'})).result();
        expect(result.content).toEqual([{type:'text',text:'untrusted provider text'}]);
        expect(JSON.stringify(captured)).not.toContain('never-transport-options');
    });
});
