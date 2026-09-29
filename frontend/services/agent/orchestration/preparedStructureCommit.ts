import type { StoreApi } from '../types';
import { applyPreparationPlanToCanonicalDataset } from './canonicalPreparation';
import { resolveReportStructureArtifactsWithProposal } from './reportStructureOrchestrator';

export const resolveAndCommitPreparedStructure = async (
    store: StoreApi,
    resolveStructure: typeof resolveReportStructureArtifactsWithProposal,
    abortSignal?: AbortSignal,
) => {
    const state = store.getState();
    const artifacts = await resolveStructure({
        rawCsvData: state.rawCsvData,
        csvData: state.csvData,
        rawIntakeIr: state.rawIntakeIr,
        cleaningRun: state.cleaningRun,
        dataPreparationPlan: state.dataPreparationPlan,
        columnProfiles: state.columnProfiles,
        humanBoundary: state.reportStructureResolution?.source === 'human_confirmed'
            ? state.reportStructureResolution.humanBoundary
            : null,
        settings: state.settings,
        telemetryTarget: {
            sessionId: state.sessionId,
            currentDatasetId: state.currentDatasetId,
        },
    });
    if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
            ? abortSignal.reason
            : new DOMException('Initial analysis was cancelled.', 'AbortError');
    }
    const canonicalCsvData = applyPreparationPlanToCanonicalDataset(
        artifacts.canonicalCsvData,
        state.dataPreparationPlan,
    );
    store.setState({
        reportStructureResolution: artifacts.reportStructureResolution,
        canonicalCsvData,
        canonicalBuildMeta: artifacts.canonicalBuildMeta,
        canonicalizationStatus: artifacts.canonicalizationStatus,
        pipelineOutcome: artifacts.pipelineOutcome,
    });
    return { ...artifacts, canonicalCsvData };
};
