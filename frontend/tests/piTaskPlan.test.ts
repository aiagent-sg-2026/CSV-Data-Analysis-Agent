import {describe,it,expect} from 'vitest';
import {projectTypedTaskPlan,taskDependencyBlock} from '../services/agent/runtime/pi/piTaskPlan';
import type {AgentTaskContract} from '../services/agent/runtime/pi/piTaskContract';

const task={taskId:'owned',revision:3,budget:{limits:{transformationAttempts:3},used:{transformationAttempts:1}},inputBindings:[{tableId:'facts',datasetVersion:'v2',relationshipSetId:'rels'}],
    scope:{answer:{dataPreparation:'canonical_fact_table',computation:{method:'lower_weighted_median'},unresolved:[]}}} as AgentTaskContract;
const base={meaningConfigured:false,candidateValidated:false,computationAccepted:false};
describe('host typed planning dependencies',()=>{
    it('keeps repair and statistical execution distinct across the exact commit boundary',()=>{
        expect(projectTypedTaskPlan(task,base)).toMatchObject({kind:'repair_then_computation',phase:'infer_meaning'});
        expect(projectTypedTaskPlan(task,{...base,meaningConfigured:true})).toMatchObject({phase:'repair_program',transformationReserve:{repair:1,computation:1,availableForDiagnostics:0}});
        expect(projectTypedTaskPlan(task,{...base,meaningConfigured:true})).toMatchObject({remainingTransformations:2,programContract:{functionWrapperAllowed:false,repairOutputFields:{table:['name','role','schema','rowCount','rows','lineage']}}});
        expect(projectTypedTaskPlan(task,{...base,meaningConfigured:true,successfulJobId:'repair-job'})).toMatchObject({phase:'stage_candidate',jobId:'repair-job'});
        expect(projectTypedTaskPlan(task,{...base,meaningConfigured:true,successfulJobId:'repair-job',candidateId:'candidate'})).toMatchObject({phase:'validate_candidate'});
        expect(projectTypedTaskPlan(task,{...base,meaningConfigured:true,successfulJobId:'repair-job',candidateId:'candidate',candidateValidated:true})).toMatchObject({phase:'exact_approval'});
        const repairCommit={commitId:'exact',datasetVersion:'v3'};
        expect(projectTypedTaskPlan(task,{...base,repairCommit})).toMatchObject({phase:'compute_program',repairCommit,transformationReserve:{repair:0,computation:1,availableForDiagnostics:1}});
        expect(projectTypedTaskPlan(task,{...base,repairCommit,successfulJobId:'fresh-stat-job'})).toMatchObject({phase:'validate_computation'});
        expect(projectTypedTaskPlan(task,{...base,repairCommit,successfulJobId:'fresh-stat-job',computationNeedsRevision:true})).toMatchObject({phase:'compute_program',nextTools:['workspace.write','code.run'],programContract:{computationOutputFields:{scopedRows:expect.stringContaining('Never a row array')}}});
        expect(projectTypedTaskPlan(task,{...base,repairCommit,computationAccepted:true})).toMatchObject({phase:'answer'});
    });
    it('retains the host-compiled repair input alias across program revisions',()=>{
        const repairInput={kind:'table' as const,name:'input',tableId:'facts'};
        const plan=projectTypedTaskPlan(task,{...base,meaningConfigured:true,repairInput});
        expect(plan.programContract).toMatchObject({repairInput,repairOutputRule:expect.stringContaining('alias invalidates')});
        plan.programContract!.repairInput!.name='forged';expect(repairInput.name).toBe('input');
        expect(projectTypedTaskPlan(task,{...base,repairInput,repairCommit:{commitId:'exact',datasetVersion:'v3'}}).programContract).not.toHaveProperty('repairInput');
    });
    it('projects exact weighted-mean output after the repair commit without changing budgets',()=>{
        const meanTask={...task,scope:{...task.scope,answer:{...task.scope.answer,computation:{method:'weighted_mean' as const,value:'Amount',weight:'Quantity',missingPolicy:'pairwise_complete' as const,weightPolicy:'nonnegative_integer_frequency' as const,seed:'none' as const}}}};
        expect(projectTypedTaskPlan(meanTask,{...base,repairCommit:{commitId:'exact',datasetVersion:'v3'}})).toMatchObject({phase:'compute_program',remainingTransformations:2,programContract:{computationOutputFields:{numerator:expect.stringContaining('STRING'),denominator:expect.stringContaining('Never reduce')}}});
    });
    it('does not impose dataset mutation on a read-only computation',()=>{
        const readonly={...task,scope:{...task.scope,answer:{...task.scope.answer,dataPreparation:undefined}}};
        const plan=projectTypedTaskPlan(readonly,base);
        expect(plan).toMatchObject({kind:'computation',phase:'compute_program'});
        plan.inputBindings[0].datasetVersion='forged';expect(task.inputBindings[0].datasetVersion).toBe('v2');
    });
    it.each([
        ['workspace_write','task_scope_repair'],['code_run','task_scope_repair'],['candidate_infer_meaning','task_scope_repair'],
        ['code_run','workspace_write'],['code_run','candidate_infer_meaning'],['candidate_stage','code_run'],
        ['candidate_validate','candidate_stage'],['candidate_request_approval','candidate_validate'],['computation_validate','code_run'],
    ])('refuses a future producer receipt: %s after %s',(consumer,producer)=>{
        expect(taskDependencyBlock(consumer,[consumer,producer])).toContain('task_dependency_requires_receipt');
        expect(taskDependencyBlock(consumer,[consumer])).toBeUndefined();
    });
    it('allows independent reads and stops unresolved scope before execution',()=>{
        expect(taskDependencyBlock('workspace_read',['workspace_read','workspace_list'])).toBeUndefined();
        expect(projectTypedTaskPlan({...task,scope:{...task.scope,answer:{...task.scope.answer,unresolved:['Unknown date convention']}}},base)).toMatchObject({phase:'resolve_scope'});
        expect(JSON.stringify(projectTypedTaskPlan(task,base)).length).toBeLessThan(1500);
    });
    it('bounds maximum-length multi-table bindings independently of the observation preview',()=>{
        const many={...task,taskId:'t'.repeat(160),inputBindings:Array.from({length:20},(_,i)=>({tableId:String(i).padEnd(160,'t'),datasetVersion:'v'.repeat(160),relationshipSetId:'r'.repeat(160)}))};
        const plan=projectTypedTaskPlan(many,{...base,meaningConfigured:true});
        expect(plan.inputBindings).toHaveLength(3);expect(plan.omittedInputBindings).toBe(17);
        expect(JSON.stringify(plan).length).toBeLessThan(4500);
    });
});
