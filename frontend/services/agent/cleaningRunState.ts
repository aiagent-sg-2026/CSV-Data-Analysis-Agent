import type { CleaningRun, CleaningRunStep } from '../../types';
import { WORKSPACE_DATASET_CLEAN_CSV } from './workspaceFileUtils';
import { createId } from '../../utils/createId';

export const createCleaningRun = (): CleaningRun => {
    const now = new Date();
    return {
        runId: createId('cleaning-run'),
        status: 'idle',
        currentStep: 0,
        steps: [],
        lastModelResponse: null,
        startedAt: now,
        updatedAt: now,
        targetPath: WORKSPACE_DATASET_CLEAN_CSV,
        lastError: null,
        shouldAutoResume: false,
        loopCount: 0,
        inspectionStatus: null,
        residualUnknownRowCount: null,
        residualSummaryLikeRowCount: null,
        lastFailedStage: null,
        latestRowInspection: null,
        iterationArtifacts: [],
        recoveryState: {
            activeStrategyId: null,
            attemptedStrategies: [],
            lastReasonCode: null,
            recoveredBy: null,
            analysisMode: 'normal',
        },
        userFacingMessage: null,
        actionTakenMessage: null,
        dataSafetyMessage: null,
        nextStateMessage: null,
        technicalDetail: null,
    };
};

export const appendCleaningRunStep = (
    run: CleaningRun | null,
    stepInput: Omit<CleaningRunStep, 'stepId' | 'timestamp'>,
): CleaningRun => {
    const baseRun = run ?? createCleaningRun();
    const step: CleaningRunStep = {
        ...stepInput,
        stepId: createId('step'),
        timestamp: new Date(),
    };
    return {
        ...baseRun,
        steps: [...baseRun.steps, step],
        currentStep: baseRun.steps.length + 1,
        updatedAt: new Date(),
    };
};

export const updateCleaningRun = (
    run: CleaningRun | null,
    updates: Partial<CleaningRun>,
): CleaningRun => {
    const baseRun = run ?? createCleaningRun();
    return {
        ...baseRun,
        ...updates,
        updatedAt: new Date(),
    };
};

/**
 * A failed run describes the previous attempt, not the data. The post-import
 * pipeline also marks the run failed when the initial analysis stops (for
 * example at the structure check), and `resolvePipelineOutcome` treats a failed
 * run as `cleaning_failed` before it looks at the structure. A new attempt
 * (Retry, or a confirmed structure) must therefore start from a cleared run,
 * otherwise the old failure is replayed and the attempt never starts.
 */
export const retireFailedCleaningRun = (run: CleaningRun | null | undefined): CleaningRun | null | undefined => (
    run?.status === 'failed'
        ? updateCleaningRun(run, {
            status: 'idle',
            lastError: null,
            lastFailedStage: null,
            shouldAutoResume: false,
            userFacingMessage: null,
            technicalDetail: null,
        })
        : run
);

export const shouldResumeCleaningRun =(run: CleaningRun | null) =>
    Boolean(run && (run.status === 'running' || run.shouldAutoResume));
