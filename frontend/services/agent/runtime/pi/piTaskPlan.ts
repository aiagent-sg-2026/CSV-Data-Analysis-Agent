import type { DatasetScopeBinding } from '../../../../types';
import type { AgentTaskContract } from './piTaskContract';
import { CANDIDATE_OUTPUT_FIELDS } from '../../../data/candidateContract';

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
    programContract?: {
        form: 'synchronous_function_body'; parameter: 'input'; topLevelReturnRequired: true;
        functionWrapperAllowed: false; moduleExportsAllowed: false;
        workspaceRevisionRule: string;
        repairOutputFields?: typeof CANDIDATE_OUTPUT_FIELDS;
        repairOutputRule?: string;
    };
    repairCommit?: TaskRepairCommit;
    candidateId?: string;
    jobId?: string;
}

/** A projection of host receipts, never a model-authored plan or a new execution authority. */
export const projectTypedTaskPlan = (task: AgentTaskContract, progress: {
    meaningConfigured: boolean; candidateId?: string; candidateValidated: boolean;
    successfulJobId?: string; repairCommit?: TaskRepairCommit; computationAccepted: boolean;
}): TypedTaskPlan => {
    const repair = task.scope.answer.dataPreparation === 'canonical_fact_table';
    const computation = Boolean(task.scope.answer.computation);
    const artifactExecution = task.requiredOutputs?.some(output=>output.required&&output.kind==='artifact');
    const kind = repair ? computation ? 'repair_then_computation' : 'repair' : computation ? 'computation' : 'general';
    let phase: TypedTaskPlan['phase'], nextTools: string[];
    if (task.scope.answer.unresolved.length) { phase = 'resolve_scope'; nextTools = ['conversation.request_clarification']; }
    else if (repair && !progress.repairCommit) {
        if (!progress.meaningConfigured) { phase = 'infer_meaning'; nextTools = ['data.query', 'candidate.infer_meaning']; }
        else if (!progress.successfulJobId) { phase = 'repair_program'; nextTools = ['workspace.write', 'code.run']; }
        else if (!progress.candidateId) { phase = 'stage_candidate'; nextTools = ['candidate.stage']; }
        else if (!progress.candidateValidated) { phase = 'validate_candidate'; nextTools = ['candidate.validate', 'workspace.replace']; }
        else { phase = 'exact_approval'; nextTools = ['candidate.request_approval']; }
    } else if (computation && !progress.computationAccepted || artifactExecution && !progress.successfulJobId) {
        if (progress.successfulJobId) { phase = 'validate_computation'; nextTools = ['computation.validate']; }
        else { phase = 'compute_program'; nextTools = ['workspace.write', 'code.run']; }
    } else { phase = 'answer'; nextTools = !computation&&task.scope.answer.requiresEvidence ? ['data.query'] : []; }
    const bindings=task.scope.answer.computation?.tableId
        ? task.inputBindings.filter(binding=>binding.tableId===task.scope.answer.computation!.tableId) : task.inputBindings.slice(0,3);
    return { kind, phase, taskId: task.taskId, taskRevision: task.revision,
        inputBindings: structuredClone(bindings), omittedInputBindings:task.inputBindings.length-bindings.length, nextTools,
        remainingTransformations: task.budget.limits.transformationAttempts-task.budget.used.transformationAttempts,
        ...(['repair_program','stage_candidate','validate_candidate','compute_program','validate_computation'].includes(phase)?{
            programContract:{form:'synchronous_function_body' as const,parameter:'input' as const,topLevelReturnRequired:true as const,
                functionWrapperAllowed:false as const,moduleExportsAllowed:false as const,
                workspaceRevisionRule:'Use expectedRevision 0 for a new path; for an existing path copy its actual current revision. A write returns the new immutable SHA-256.',
                ...(repair&&!progress.repairCommit?{repairOutputFields:CANDIDATE_OUTPUT_FIELDS,
                    repairOutputRule:'Return only these exact fields. detailRanges, grain, groupBy, conversions and assumptions configure candidate_infer_meaning; they are not candidate output fields. Apply conversions in rows and provide every cell origin. Reserve a later execution for the post-approval computation when requested.'}:{})}
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
    const producer = producers[name]?.find(candidate => batchNames.includes(candidate));
    return producer ? `task_dependency_requires_receipt: ${producer} and ${name} must be in separate assistant turns. Wait for the successful producer receipt, then copy its exact references. No placeholder or future hash is valid.` : undefined;
};
