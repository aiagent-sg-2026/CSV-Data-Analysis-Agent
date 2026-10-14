import { describe, expect, it } from 'vitest';
import type { RuntimeOutcomeEnvelope, RuntimeTaskOutputVerdict } from '../types';
import type { StoreApi } from '../services/agent/types';
import { finalizeRuntimeOutcome } from '../services/agent/runtime/runtimeFinalize';
import { createAgentTurn, completeAgentTurn } from '../services/agent/runtime/runtimeState';
import { assessTaskOutputs } from '../services/agent/runtime/taskOutputContract';

const fixture = () => {
    let state = {sessionId:'terminal-session',chatHistory:[],runtimeRunHistory:[],runtimeEvents:[],agentToolLogs:[],isBusy:true,streamingMessage:'Unverified 999'} as unknown as ReturnType<StoreApi['getState']>;
    const store:StoreApi={getState:()=>state,setState:patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};}};
    const turn=completeAgentTurn(createAgentTurn('Explain the formula.'),'Unverified 999');
    const outputs=assessTaskOutputs({taskId:'terminal-task',taskRevision:1,runId:turn.runId,sessionId:state.sessionId,
        requiredOutputs:[{id:'reply',kind:'answer',required:true}],acceptedOutputs:[{requirementId:'reply',kind:'answer',references:[`reply:${turn.turnId}`]}],queryIds:[],computationIds:[],reasons:[]});
    const outcome:RuntimeOutcomeEnvelope={runId:turn.runId,turnId:turn.turnId,sessionId:state.sessionId,outcomeKind:'accepted',lifecycleState:'completed',stage:'finalizing',
        reason:'pi_follow_up_completed',retryable:false,eventType:'turn_completed',eventMessage:'Unverified 999',assistantMessage:'Unverified 999',taskOutputs:outputs};
    return {store,turn,outcome,outputs};
};

describe('host terminal output contract',()=>{
    it.each(['missing','wrong-kind','missing-contract'] as const)('rejects a fabricated completion even when the caller marks complete: %s',mode=>{
        const f=fixture();
        const outputs={...f.outputs,acceptedOutputs:mode==='wrong-kind'?[{requirementId:'reply',kind:'artifact',references:['job']}]:[],status:'complete'} as RuntimeTaskOutputVerdict;
        finalizeRuntimeOutcome({...f,outcome:{...f.outcome,taskOutputs:mode==='missing-contract'?undefined:outputs}});
        expect(f.store.getState().runtimeRunHistory.at(-1)?.outcomeKind).toBe('blocked');
        expect(f.store.getState().chatHistory.at(-1)?.text).not.toContain('Unverified 999');
        expect(f.store.getState().activeTurn?.status).toBe('waiting_for_clarification');
        expect(f.store.getState().isBusy).toBe(false);
    });
    it('keeps a failed terminal and accepted partial output stable under duplicate late finalization',()=>{
        const f=fixture(),partial=assessTaskOutputs({...f.outputs,reasons:['provider_unavailable']});
        finalizeRuntimeOutcome({...f,outcome:{...f.outcome,outcomeKind:'failed',lifecycleState:'failed',eventType:'turn_failed',assistantMessage:'Provider unavailable; accepted work retained.',taskOutputs:partial}});
        const record=structuredClone(f.store.getState().runtimeRunHistory);
        finalizeRuntimeOutcome(f);
        expect(f.store.getState().runtimeRunHistory).toEqual(record);
        expect(record[0].taskOutputs?.acceptedOutputs).toHaveLength(1);
        expect(record[0].taskOutputs?.status).toBe('partial');expect(f.store.getState().chatLifecycleState).toBe('failed');
    });
    it('cannot finalize over a replacement run or session',()=>{
        const f=fixture();f.store.setState({activeExecution:{runId:'new-run'} as never,streamingMessage:{text:'New stream',isStreaming:true,startedAt:new Date()},isBusy:true});
        finalizeRuntimeOutcome(f);expect(f.store.getState().runtimeRunHistory).toEqual([]);expect(f.store.getState().streamingMessage?.text).toBe('New stream');
        f.store.setState({activeExecution:null,sessionId:'replacement-session'});finalizeRuntimeOutcome(f);
        expect(f.store.getState().runtimeRunHistory).toEqual([]);expect(f.store.getState().isBusy).toBe(true);
    });
});
