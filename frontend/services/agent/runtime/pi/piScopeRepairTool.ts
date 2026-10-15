import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {StoreApi} from '../../types';
import {assertRunActive,scopeRunStore} from '../../../session/sessionOwnership';
import {resolveComputationScopeRepair,type ScopeRepairContext} from './piScopeRepair';
import type {ResolvedAnswerScope} from './queryEvidence';

/** Intrinsic task metadata tool, like read_skill. It cannot mutate a dataset or issue execution grants. */
export const createPiScopeRepairTool=(store:StoreApi,context:ScopeRepairContext,onResolved:(scope:ResolvedAnswerScope)=>void):AgentTool=>{
    const fixed=structuredClone(context);
    return ({
    name:'task_scope_repair',label:'task.scope.repair',executionMode:'sequential',replay:'never',
    description:'Repair an unresolved computation filter classification before writing/running code. Preserve the fixed method, value/weight/unit columns, repair output and all known time/entity constraints. Use entire_input only for an explicit unrestricted full-population quote in the original user goal. This tool cannot add, remove or rewrite actual business predicates. For a real or ambiguous filter, request clarification. This changes task scope metadata only; it supplies no answer, approval or extra budget. At most two proposals per logical task. If ambiguous, request clarification. Read the returned host taskPlan before the next action.',
    parameters:Type.Object({population:Type.Literal('entire_input'),goalQuote:Type.String({minLength:1,maxLength:500})},{additionalProperties:false}),
    execute:async(toolCallId,args)=>{
        const lease=store.executionContext?.lease,task=store.piTask;
        if(!lease||!task||task.snapshot.goal!==fixed.message)throw new Error('scope_repair_unavailable');
        assertRunActive(store,lease);
        const owned=scopeRunStore(store,lease);task.attach(owned);
        owned.executionContext={...store.executionContext!,toolCallId,stepId:`step-${lease.turnId}-${toolCallId}`};
        await task.beforeTool('task.scope.repair',args,toolCallId);
        let result:import('../../../../types').ToolExecutionResult;
        try{
            const scope=await task.repairScope(()=>resolveComputationScopeRepair(fixed,args,owned));
            assertRunActive(store,lease);onResolved(scope);
            result={status:'success',toolName:'task.scope.repair',message:'Host accepted the repaired typed scope. No analytical evidence or dataset change was produced.',shouldStop:false,payload:{resolvedScope:scope,answerEvidence:false}};
        }catch(error){
            result={status:'blocked',toolName:'task.scope.repair',message:error instanceof Error?error.message:'scope_repair_rejected',shouldStop:false};
        }
        assertRunActive(store,lease);task.afterTool('task.scope.repair',result,owned.executionContext);
        return {details:undefined,content:[{type:'text',text:JSON.stringify({...result,taskPlan:task.plan})}]};
    },
});
};
