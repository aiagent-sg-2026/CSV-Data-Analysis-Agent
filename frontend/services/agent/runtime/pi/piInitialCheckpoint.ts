import type { ExecutorPreparationReference } from './piExecutorPreparation';
import type { AppState, AiIntakeStructureBoundary, ResearchPlan } from '../../../../types';
import { buildDatasetFingerprint, getCsvDatasetVersion } from '../../../../utils/datasetId';
import { buildCardSemanticFingerprint } from '../../cardSemanticFingerprint';
import type { InitialAnalysisRunOutcome } from './initialAnalysisTypes';
import {restoreTaskBudget} from './piTaskBudget';

// Keep the storage key so existing checkpoints remain readable. The payload is versioned separately.
export const INITIAL_CHECKPOINT_PREFIX = 'pi-initial-analysis-v1:';
export const initialCheckpointKey = (sessionId: string): string => `${INITIAL_CHECKPOINT_PREFIX}${sessionId}`;
export const hasPiInitialCheckpoint = (sessionId: string): boolean => {
    try { return localStorage.getItem(initialCheckpointKey(sessionId)) !== null; } catch { return false; }
};

interface CheckpointBase {
    coding?: {version:1;budget:import('./piTaskBudget').TaskBudget;commit?:import('../../../../types/datasetCommit').DatasetCommitReference};
    executorPreparation?: ExecutorPreparationReference;
    sessionId: string;
    datasetVersion: string;
    researchGoal: string;
    nextStageIndex: number;
    pendingStageIndex: number | null;
    committedTransformationIds: string[];
    cardFingerprints: string[];
    warnings: InitialAnalysisRunOutcome['warnings'];
    researchPlan?: ResearchPlan | null;
}
export interface InitialStageReceipt {
    execution?: ExecutorPreparationReference & {stepId:string;toolCallId:string};
    stageIndex: number;
    toolName: string;
    inputVersion: string;
    outputVersion: string;
    decision: 'pass' | 'warn' | 'fail';
    transformationIds: string[];
    cardIds: string[];
}
export interface CheckpointSource {
    datasetId: string | null;
    fileName: string;
    fingerprint: string;
    byteSize: number | null;
}
export interface PiInitialCheckpointV2 extends CheckpointBase {
    schemaVersion: 2;
    source: CheckpointSource;
    sourceBoundary: AiIntakeStructureBoundary | null;
    initialDatasetVersion: string;
    preparedDatasetVersion: string;
    lineageSignature: string;
    stageReceipts: InitialStageReceipt[];
    // Legacy stable stages have no receipts. Their validated boundary is retained on upgrade.
    receiptStartIndex: number;
}
export type PiInitialCheckpoint = (CheckpointBase & { schemaVersion: 1 }) | PiInitialCheckpointV2;

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const preparationReference = (value: unknown): boolean => object(value) && ['staging_only','qualified'].includes(String(value.mode))
    && ['initial_analysis','follow_up'].includes(String(value.entryPoint))
    && ['taskId','namespaceId','runId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 240)
    && Number.isSafeInteger(value.taskRevision) && Number(value.taskRevision) > 0
    && Number.isSafeInteger(value.sessionEpoch) && Number(value.sessionEpoch) >= 0;
export const readPiInitialCheckpoint = (sessionId: string, stageCount = 9): PiInitialCheckpoint | null => {
    try {
        const raw = localStorage.getItem(initialCheckpointKey(sessionId));
        if (!raw) return null;
        const value: unknown = JSON.parse(raw);
        if (!object(value) || ![1, 2].includes(Number(value.schemaVersion)) || value.sessionId !== sessionId
            || typeof value.datasetVersion !== 'string' || typeof value.researchGoal !== 'string'
            || !Number.isInteger(value.nextStageIndex) || Number(value.nextStageIndex) < 0 || Number(value.nextStageIndex) > stageCount
            || (value.pendingStageIndex !== null && (!Number.isInteger(value.pendingStageIndex)
                || value.pendingStageIndex !== value.nextStageIndex))
            || !strings(value.committedTransformationIds) || !strings(value.cardFingerprints)
            || !Array.isArray(value.warnings) || value.warnings.some(warning => !object(warning)
                || typeof warning.code !== 'string' || typeof warning.message !== 'string')) return null;
        if (value.executorPreparation !== undefined && !preparationReference(value.executorPreparation)) return null;
        if(value.coding!==undefined){
            if(!object(value.coding)||value.coding.version!==1||!object(value.coding.budget))return null;
            try{restoreTaskBudget(value.coding.budget);}catch{return null;}
            const ref=value.coding.commit;
            if(ref!==undefined&&(!object(ref)||typeof ref.sessionId!=='string'||typeof ref.commitId!=='string'||!Number.isSafeInteger(ref.revision)||Number(ref.revision)<1))return null;
        }
        if (value.schemaVersion === 2) {
            if (!object(value.source) || typeof value.source.fileName !== 'string' || typeof value.source.fingerprint !== 'string'
                || !(value.source.datasetId === null || typeof value.source.datasetId === 'string')
                || !(value.source.byteSize === null || (typeof value.source.byteSize === 'number' && value.source.byteSize >= 0))
                || typeof value.initialDatasetVersion !== 'string' || typeof value.preparedDatasetVersion !== 'string'
                || typeof value.lineageSignature !== 'string' || !Number.isInteger(value.receiptStartIndex)
                || Number(value.receiptStartIndex) < 0 || Number(value.receiptStartIndex) > Number(value.nextStageIndex)
                || !Array.isArray(value.stageReceipts) || value.stageReceipts.some(receipt => !object(receipt)
                    || !Number.isInteger(receipt.stageIndex) || typeof receipt.toolName !== 'string'
                    || typeof receipt.inputVersion !== 'string' || typeof receipt.outputVersion !== 'string'
                    || !['pass', 'warn', 'fail'].includes(String(receipt.decision))
                    || !strings(receipt.transformationIds) || !strings(receipt.cardIds)
                    || (receipt.execution !== undefined && (!preparationReference(receipt.execution) || !object(receipt.execution)
                        || typeof receipt.execution.stepId !== 'string' || typeof receipt.execution.toolCallId !== 'string')))) return null;
            if (value.sourceBoundary !== null && (!object(value.sourceBoundary)
                || !Number.isInteger(value.sourceBoundary.headerRowIndex) || !Number.isInteger(value.sourceBoundary.bodyStartIndex)
                || !Number.isInteger(value.sourceBoundary.summaryStartIndex))) return null;
        }
        return value as unknown as PiInitialCheckpoint;
    } catch { return null; }
};
export const writePiInitialCheckpoint = (checkpoint: PiInitialCheckpoint): void => {
    try { localStorage.setItem(initialCheckpointKey(checkpoint.sessionId), JSON.stringify(checkpoint)); }
    catch { /* Recovery is unavailable when browser storage is full. */ }
};
export const discardPiInitialCheckpoint = (sessionId: string): void => {
    try { localStorage.removeItem(initialCheckpointKey(sessionId)); } catch { /* Storage can be unavailable. */ }
};
export const captureCheckpointSource = (state: AppState): CheckpointSource | null => {
    const source = state.datasetBundle?.source;
    if (source) return { datasetId: state.currentDatasetId ?? null, fileName: source.fileName,
        fingerprint: source.fingerprint, byteSize: source.byteSize };
    const data = state.rawCsvData ?? state.csvData;
    return data ? { datasetId: state.currentDatasetId ?? null, fileName: data.fileName,
        fingerprint: buildDatasetFingerprint(data.fileName, data.data), byteSize: null } : null;
};
export const captureCheckpointSourceBoundary = (state: AppState): AiIntakeStructureBoundary | null => {
    const boundary = state.rawIntakeIr?.provisionalTable;
    return boundary ? {
        headerRowIndex: boundary.headerRowIndex, headerLayerIndexes: boundary.headerLayerRowIndexes,
        bodyStartIndex: boundary.bodyStartIndex, summaryStartIndex: boundary.summaryStartIndex,
        parameterRowIndexes: boundary.parameterRowIndexes, repeatedHeaderRowIndexes: boundary.repeatedHeaderRowIndexes,
        syntheticHeaders: state.rawIntakeIr?.diagnostics.aiStructureBoundary?.syntheticHeaders,
        confidence: 1, reasoning: 'Persisted source intake boundary for deterministic recovery.',
    } : null;
};

const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!object(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
};
// Metadata only: detect changed operations, table bindings, boundary/normalization rules, and saved artifacts.
export const checkpointLineageSignature = (state: AppState): string => buildDatasetFingerprint('pi-checkpoint-lineage', [{ contract: JSON.stringify(stableValue({
    bundleId: state.datasetBundle?.bundleId ?? null,
    primaryTableId: state.datasetBundle?.primaryTableId ?? null,
    relationshipSetId: state.datasetBundle?.relationshipSetId ?? null,
    tables: state.datasetBundle?.tables ?? [], relationships: state.datasetBundle?.relationships ?? [],
    programs: state.datasetBundle?.transformationPrograms ?? [],
    operations: state.dataPreparationPlan?.operations ?? [],
    structure: state.reportStructureResolution ? {
        decision: state.reportStructureResolution.decision,
        rawIntakeBoundary: state.reportStructureResolution.rawIntakeBoundary,
        runtimeBoundary: state.reportStructureResolution.runtimeBoundary,
        humanBoundary: state.reportStructureResolution.humanBoundary,
        normalizationPlan: state.reportStructureResolution.normalizationPlan,
        resolvedRawRowRoles: state.reportStructureResolution.resolvedRawRowRoles,
    } : null,
    canonicalBuildMeta: state.canonicalBuildMeta ?? null,
    cards: (state.analysisCards ?? []).map(card => ({ id: card.id, plan: card.plan, provenance: card.provenance ?? null })),
})) }]);

export const validateCheckpointState = (checkpoint: PiInitialCheckpoint, state: AppState,
    stages: ReadonlyArray<{ name: string }>, optionalStages: ReadonlySet<string>, requireRows = true): string | null => {
    if (checkpoint.researchGoal !== state.confirmedAnalysisGoal) return 'research_goal_mismatch';
    if (checkpoint.pendingStageIndex !== null) return 'stage_side_effects_uncertain';
    const transformations = new Set([...(state.dataPreparationPlan?.operations ?? []).map(operation => operation.id),
        ...(state.datasetBundle?.transformationPrograms??[]).map(p=>p.programId),
        ...(state.datasetBundle?.acceptedCommit?[state.datasetBundle.acceptedCommit.commitId]:[])]);
    const fingerprints = new Set((state.analysisCards ?? []).map(card =>
        buildCardSemanticFingerprint(card.plan, card.provenance?.datasetVersion)).filter(Boolean));
    if (!checkpoint.committedTransformationIds.every(id => transformations.has(id))) return 'committed_transformations_missing';
    if (!checkpoint.cardFingerprints.every(value => fingerprints.has(value))) return 'committed_cards_missing';
    const material = state.canonicalCsvData ?? state.csvData;
    if (requireRows && (!material || getCsvDatasetVersion(material) !== checkpoint.datasetVersion)) return 'material_version_mismatch';
    if (checkpoint.schemaVersion === 1) return requireRows ? null : 'legacy_checkpoint_requires_prepared_rows';
    const source = captureCheckpointSource(state);
    if (JSON.stringify(stableValue(source)) !== JSON.stringify(stableValue(checkpoint.source))) return 'source_identity_mismatch';
    if (checkpointLineageSignature(state) !== checkpoint.lineageSignature) return 'saved_lineage_mismatch';
    if (requireRows && (!state.csvData || getCsvDatasetVersion(state.csvData) !== checkpoint.preparedDatasetVersion)) return 'prepared_version_mismatch';
    let cursor = checkpoint.receiptStartIndex;
    let version: string | null = cursor === 0 ? checkpoint.initialDatasetVersion : null;
    const cardIds = new Set((state.analysisCards ?? []).map(card => card.id));
    for (const receipt of checkpoint.stageReceipts) {
        while (cursor < receipt.stageIndex && optionalStages.has(stages[cursor]?.name)) cursor += 1;
        if (cursor !== receipt.stageIndex || stages[cursor]?.name !== receipt.toolName
            || receipt.decision === 'fail' || (version !== null && receipt.inputVersion !== version)
            || !receipt.transformationIds.every(id => transformations.has(id))
            || !receipt.cardIds.every(id => cardIds.has(id))) return 'stage_receipt_mismatch';
        cursor += 1;
        version = receipt.outputVersion;
    }
    while (cursor < checkpoint.nextStageIndex && optionalStages.has(stages[cursor]?.name)) cursor += 1;
    if (cursor !== checkpoint.nextStageIndex || (version !== null && version !== checkpoint.datasetVersion)) return 'stage_receipt_mismatch';
    return null;
};
