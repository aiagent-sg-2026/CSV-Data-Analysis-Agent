import type { StoreApi } from '../../types';
import { assertRunActive, scopeRunStore } from '../../../session/sessionOwnership';
import type { InitialAnalysisPhase } from './initialAnalysisTypes';
import { preparePiTask, type PiCodingTask, type PiTaskContinuation } from './piCodingTask';

export interface ExecutorPreparationReference {
    mode: 'staging_only' | 'qualified'; entryPoint: 'initial_analysis' | 'follow_up';
    taskId: string; taskRevision: number; namespaceId: string; runId: string; sessionEpoch: number;
}
export interface InitialExecutorStage {
    stageIndex: number; toolName: string; phase: InitialAnalysisPhase;
    nextStageIndex: number; pendingStageIndex: number | null;
}
export interface PiExecutorPreparation {
    task: PiCodingTask;
    reference(): ExecutorPreparationReference;
    stage(stage: InitialExecutorStage, toolCallId: string): StoreApi;
}

/** Shared host preparation; neither the reference nor a checkpoint conveys execution/commit authority. */
export const preparePiExecutor = async (store: StoreApi, options: {
    entryPoint: ExecutorPreparationReference['entryPoint']; goal: string;
    continuation?: PiTaskContinuation; guest?: Parameters<typeof preparePiTask>[3];
    spillFactory?: import('../../../data/candidateSpill').CandidateSpillFactory;
    qualified?: boolean; recoveryBudget?: import('./piTaskBudget').TaskBudget;
}): Promise<PiExecutorPreparation> => {
    const lease = store.executionContext?.lease;
    if (!lease || lease.kind !== options.entryPoint) throw new Error('executor_entry_point_mismatch');
    assertRunActive(store, lease);
    const task = await preparePiTask(store, options.goal, options.continuation, options.guest, options.recoveryBudget,options.spillFactory);
    assertRunActive(store, lease);
    task.refreshInputs();
    const reference = (): ExecutorPreparationReference => {
        assertRunActive(store, lease);
        return {mode:options.qualified?'qualified':'staging_only',entryPoint:options.entryPoint,taskId:task.snapshot.taskId,taskRevision:task.snapshot.revision,
            namespaceId:store.codeExecution!.workspace.namespaceId,runId:lease.runId,sessionEpoch:lease.scope.epoch};
    };
    store.executorPreparation = reference();
    return {task,reference,stage(stage,toolCallId) {
        assertRunActive(store, lease);
        if (!toolCallId) throw new Error('task_execution_context_invalid');
        task.refreshInputs();
        const target = scopeRunStore(store,lease);
        target.executionContext = {lease,toolCallId,stepId:`stage-${stage.stageIndex}-${toolCallId}`};
        task.attach(target);
        target.executorPreparation = {...reference(),stage:{...stage}};
        return target;
    }};
};
