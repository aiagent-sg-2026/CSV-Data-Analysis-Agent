import type { DatasetScopeBinding } from '../../../../types';
import type { AgentTaskContract } from './piTaskContract';
import { CANDIDATE_OUTPUT_FIELDS } from '../../../data/candidateContract';
import {canRepairComputationScope} from './piScopeRepair';
import { COMPUTATION_OUTPUT_CONTRACTS } from '../../execution/computationEvidence';

export type TaskDataPreparation = 'canonical_fact_table';
export interface TaskRepairCommit { commitId: string; datasetVersion: string }
export interface TypedTaskPlan {
    kind: 'repair_then_computation' | 'repair' | 'computation' | 'general';
    phase: 'resolve_scope' | 'infer_meaning' | 'repair_program' | 'stage_candidate' | 'validate_candidate'
        | 'exact_approval' | 'compute_program' | 'validate_computation' | 'answer';
    taskId: string;
    taskRevision: number;
    inputBindings: DatasetScopeBinding[];
    omittedInputBindings: number;
    nextTools: string[];
    remainingTransformations: number;
    scopeRepair?:{remainingProposals:number;changes:'classifier_filter_only'};
    transformationReserve:{repair:number;computation:number;availableForDiagnostics:number};
    programContract?: {
        form: 'synchronous_function_body'; parameter: 'input'; topLevelReturnRequired: true;
        functionWrapperAllowed: false; moduleExportsAllowed: false;
        workspaceRevisionRule: string;
        repairInput?:{kind:'table'|'source';name:string;tableId?:string};
        repairOutputFields?: typeof CANDIDATE_OUTPUT_FIELDS;
        repairOutputRule?: string;
        computationOutputFields?: Readonly<Record<string,string>>;
    };
    repairCommit?: TaskRepairCommit;
    candidateId?: string;
    jobId?: string;
}

/** A projection of host receipts, never a model-authored plan or a new execution authority. */
export const projectTypedTaskPlan = (task: AgentTaskContract, progress: {
    meaningConfigured: boolean; sourceSpill?: boolean; scopeRepairRemaining?:number; repairInput?:{kind:'table'|'source';name:string;tableId?:string}; candidateId?: string; candidateValidated: boolean;
    successfulJobId?: string; repairCommit?: TaskRepairCommit; computationAccepted: boolean; computationNeedsRevision?: boolean;
}): TypedTaskPlan => {
    const repair = task.scope.answer.dataPreparation === 'canonical_fact_table' || Boolean(progress.sourceSpill);
    const computation = Boolean(task.scope.answer.computation);
    const artifactExecution = task.requiredOutputs?.some(output=>output.required&&output.kind==='artifact');
    const kind = repair ? computation ? 'repair_then_computation' : 'repair' : computation ? 'computation' : 'general';
    let phase: TypedTaskPlan['phase'], nextTools: string[];
    if (task.scope.answer.unresolved.length) { phase = 'resolve_scope'; nextTools = canRepairComputationScope(task.scope.answer)&&(progress.scopeRepairRemaining??2)>0?['task.scope.repair','conversation.request_clarification']:['conversation.request_clarification']; }
    else if (repair && !progress.repairCommit) {
        if (!progress.meaningConfigured) { phase = 'infer_meaning'; nextTools = ['data.query', 'candidate.infer_meaning']; }
        else if (!progress.successfulJobId) { phase = 'repair_program'; nextTools = ['workspace.write', 'code.run']; }
        else if (!progress.candidateId) { phase = 'stage_candidate'; nextTools = ['candidate.stage']; }
        else if (!progress.candidateValidated) { phase = 'validate_candidate'; nextTools = ['candidate.validate', 'workspace.replace']; }
        else { phase = 'exact_approval'; nextTools = ['candidate.request_approval']; }
    } else if (computation && !progress.computationAccepted || artifactExecution && !progress.successfulJobId) {
        if (progress.successfulJobId&&!progress.computationNeedsRevision) { phase = 'validate_computation'; nextTools = ['computation.validate']; }
        else { phase = 'compute_program'; nextTools = ['workspace.write', 'code.run']; }
    } else { phase = 'answer'; nextTools = !computation&&task.scope.answer.requiresEvidence ? ['data.query'] : []; }
    const bindings=task.scope.answer.computation?.tableId
        ? task.inputBindings.filter(binding=>binding.tableId===task.scope.answer.computation!.tableId) : task.inputBindings.slice(0,3);
    const remainingTransformations=task.budget.limits.transformationAttempts-task.budget.used.transformationAttempts;
    const repairExecutions=repair&&!progress.repairCommit&&!progress.successfulJobId?1:0;
    const computationExecutions=computation&&!progress.computationAccepted
        &&(repair&&!progress.repairCommit||!progress.successfulJobId||progress.computationNeedsRevision)?1:0;
    return { kind, phase, taskId: task.taskId, taskRevision: task.revision,
        inputBindings: structuredClone(bindings), omittedInputBindings:task.inputBindings.length-bindings.length, nextTools,
        remainingTransformations,
        ...(canRepairComputationScope(task.scope.answer)?{scopeRepair:{remainingProposals:progress.scopeRepairRemaining??2,changes:'classifier_filter_only' as const}}:{}),
        transformationReserve:{repair:repairExecutions,computation:computationExecutions,availableForDiagnostics:Math.max(0,remainingTransformations-repairExecutions-computationExecutions)},
        ...(['repair_program','stage_candidate','validate_candidate','compute_program','validate_computation'].includes(phase)?{
            programContract:{form:'synchronous_function_body' as const,parameter:'input' as const,topLevelReturnRequired:true as const,
                functionWrapperAllowed:false as const,moduleExportsAllowed:false as const,
                workspaceRevisionRule:'Use expectedRevision 0 for a new path; for an existing path copy its actual current revision. A write returns the new immutable SHA-256.',
                ...(computation&&(!repair||progress.repairCommit)?{computationOutputFields:COMPUTATION_OUTPUT_CONTRACTS[task.scope.answer.computation!.method]}:{}),
                ...(repair&&!progress.repairCommit?{...(progress.repairInput?{repairInput:structuredClone(progress.repairInput)}:{}),...(progress.sourceSpill ? {repairOutputRule:'Use code_run mode source_records with the compiled sourceId/SHA/width and no sources/tables. Return exactly {state,rows:[{sourceRow,cells}]} from input.records, preserving all physical cells; only empty trailing cells may be padded/dropped. The host projects declared types separately. Stage then independently validate the spill; exact human approval is still required.'} : {repairOutputFields:CANDIDATE_OUTPUT_FIELDS,
                    repairOutputRule:'Return only these exact fields. detailRanges, grain, groupBy, conversions and assumptions configure candidate_infer_meaning; they are not candidate output fields. Use repairInput.name unchanged in code_run tables/sources, input.<name> and every lineage origin; changing this alias invalidates the fixed meaning contract. Read all rows from the declared input binding and transform those rows; never embed inspected row literals in the program. lineage is a FLAT array with one {row,column,origins} entry for EVERY output cell, including unchanged IDs, dates and units. origins is a nonempty array of {kind,name,row,column}: kind is table/source, name is the exact code_run input alias, row is its zero-based input row, and column is the table column name or raw-source column index. Apply the declared conversions in output rows. Reserve a later execution for the post-approval computation when requested. When transformationReserve.availableForDiagnostics is zero, the next repair execution must return the complete candidate envelope; inspect inputs with read-only workspace tools instead of spending an execution on a probe. A generic runtime failure does not prove that the declared input alias changed.'})}:{})}
        }:{}),
        ...(progress.repairCommit ? { repairCommit: { ...progress.repairCommit } } : {}),
        ...(progress.candidateId ? { candidateId: progress.candidateId } : {}),
        ...(progress.successfulJobId ? { jobId: progress.successfulJobId } : {}) };
};

const producers: Record<string, string[]> = {
    code_run: ['workspace_write', 'workspace_replace', 'workspace_append', 'candidate_infer_meaning'],
    candidate_stage: ['code_run'],
    candidate_validate: ['candidate_stage'],
    candidate_request_approval: ['candidate_stage', 'candidate_validate'],
    computation_validate: ['code_run'],
};

/** Sequential SDK execution does not let an assistant know a future receipt in the same message. */
export const taskDependencyBlock = (name: string, batchNames: string[]): string | undefined => {
    if(batchNames.includes('task_scope_repair')&&batchNames.some(item=>/^(?:code_|candidate_|computation_|workspace_(?:write|replace|append))/.test(item)))
        return 'task_dependency_requires_receipt: Repair scope in a separate assistant turn, then read its host taskPlan before authoring/executing programs.';
    const producer = producers[name]?.find(candidate => batchNames.includes(candidate));
    return producer ? `task_dependency_requires_receipt: ${producer} and ${name} must be in separate assistant turns. Wait for the successful producer receipt, then copy its exact references. No placeholder or future hash is valid.` : undefined;
};
