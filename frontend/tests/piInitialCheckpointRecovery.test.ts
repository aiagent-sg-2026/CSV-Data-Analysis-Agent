import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../types';
import { buildCsvDataFromRawRows, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { buildDatasetFingerprint, getCsvDatasetVersion } from '../utils/datasetId';
import { createSingleTableDatasetBundle, commitVerifiedPrimaryTableTransformation } from '../services/data/datasetBundle';
import { createInitialAnalysisStageToolManifests } from '../services/agent/tools/manifests/initialAnalysisStageManifests';
import { resolveReportStructureArtifacts } from '../services/agent/reportStructureState';
import { normalizeRestoredAppState } from '../utils/messageState';
import { normalizeDataPreparationPlan } from '../services/agent/execution/dataOperationRunner';
import { toSerializable } from '../utils/serializable';
import { beginRun, beginSessionTransition, finishRun } from '../services/session/sessionOwnership';
import { captureCheckpointSource, captureCheckpointSourceBoundary, checkpointLineageSignature, initialCheckpointKey,
    readPiInitialCheckpoint, validateCheckpointState, writePiInitialCheckpoint, type PiInitialCheckpointV2 } from '../services/agent/runtime/pi/piInitialCheckpoint';

const recover = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ status: 'completed' })));
vi.mock('../services/agent/runtime/pi/piInitialAnalysisRuntimeService', () => ({ recoverPiInitialAnalysisIfNeeded: recover }));
import { rebuildCheckpointDataset, reattachPiInitialCheckpointSource } from '../services/agent/runtime/pi/piInitialCheckpointRecovery';

const rawRows = [['Town', 'Amount'], ['A', '10'], ['B', '20']];
const text = 'Town,Amount\nA,10\nB,20';
const stages = createInitialAnalysisStageToolManifests();
const optional = new Set(['dataset.suggestCleaningPlan', 'dataset.applyTransform']);
const fileFor = (content = text) => {
    const file = new File([content], 'synthetic-recovery.csv', { type: 'text/csv', lastModified: 1 });
    Object.defineProperty(file, 'text', { configurable: true, value: async () => content });
    Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: async () => new TextEncoder().encode(content).buffer });
    return file;
};
const fixture = () => {
    const file = fileFor();
    const raw = buildCsvDataFromRawRows(file.name, rawRows);
    const operation = { id: 'cast-amount', type: 'cast_column' as const, column: 'Amount', targetType: 'number' as const, reason: 'Numeric measure' };
    const prepared = { ...raw, data: [{ Town: 'A', Amount: 10 }, { Town: 'B', Amount: 20 }] };
    const original = createSingleTableDatasetBundle({ datasetId: 'dataset-source', sourceFingerprint: buildDatasetFingerprint(file.name, raw.data), file, data: raw });
    const bundle = commitVerifiedPrimaryTableTransformation({ bundle: original, data: prepared, operations: [operation], runId: 'cleaning-1' })!;
    const loaded = { sessionId: 'checkpoint-session', currentDatasetId: 'dataset-source', csvData: prepared, rawCsvData: raw,
        rawIntakeIr: buildReportIntakeIr(file.name, rawRows), canonicalCsvData: null, datasetBundle: bundle,
        dataPreparationPlan: { operations: [operation] }, analysisCards: [], confirmedAnalysisGoal: 'Find patterns.',
        currentView: 'file_upload', initialAnalysisStatus: 'paused', settings: { provider: 'openai', complexModel: 'mock' },
        addProgress: vi.fn(), refreshDuckDbSession: vi.fn(async () => ({ status: 'ready' })) } as unknown as AppState;
    const initialVersion = getCsvDatasetVersion(raw), version = getCsvDatasetVersion(prepared);
    const checkpoint: PiInitialCheckpointV2 = { schemaVersion: 2, sessionId: loaded.sessionId, source: captureCheckpointSource(loaded)!,
        sourceBoundary: captureCheckpointSourceBoundary(loaded), initialDatasetVersion: initialVersion, datasetVersion: version,
        preparedDatasetVersion: version, lineageSignature: checkpointLineageSignature(loaded), researchGoal: loaded.confirmedAnalysisGoal!,
        nextStageIndex: 4, pendingStageIndex: null, committedTransformationIds: [operation.id], cardFingerprints: [], warnings: [],
        receiptStartIndex: 0, stageReceipts: stages.slice(0, 4).map((stage, stageIndex) => ({ stageIndex, toolName: stage.name,
            inputVersion: initialVersion, outputVersion: stageIndex === 3 ? version : initialVersion, decision: 'pass',
            transformationIds: stageIndex === 3 ? [operation.id] : [], cardIds: [] })) };
    let state = { ...loaded, csvData: null, rawCsvData: null, rawIntakeIr: null, activeExecution: null as { runId: string } | null };
    const store = { getState: () => state, setState: (patch: unknown) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch as object) };
    } };
    writePiInitialCheckpoint(checkpoint);
    return { file, loaded, checkpoint, store, prepared };
};

describe('Pi checkpoint source reattachment', () => {
    beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto); localStorage.clear(); vi.clearAllMocks(); });

    it('keeps stable metadata recoverable without rows and reconstructs committed data before continuing', async () => {
        const { file, checkpoint, store, prepared } = fixture();
        expect(validateCheckpointState(checkpoint, store.getState(), stages, optional, false)).toBeNull();
        expect(store.getState().csvData).toBeNull();
        await reattachPiInitialCheckpointSource(file, store as never);
        expect(store.getState().csvData?.data).toEqual(prepared.data);
        expect(store.getState().rawCsvData?.data[0].Amount).toBe('10');
        expect(store.getState().currentView).toBe('analysis_dashboard');
        expect(recover).toHaveBeenCalledOnce();
        const resumedStore = recover.mock.calls[0][0] as any;
        expect(resumedStore.executionContext).toBeUndefined();
        expect(store.getState().activeExecution).toBeNull();
        expect(readPiInitialCheckpoint(checkpoint.sessionId)?.nextStageIndex).toBe(4);
    });

    it('rejects a different same-name, same-size source without replacing saved content or starting Pi', async () => {
        const { store, checkpoint } = fixture();
        const saved = store.getState().datasetBundle;
        await reattachPiInitialCheckpointSource(fileFor(text.replace('10', '99')), store as never);
        expect(store.getState().initialAnalysisRecovery?.reason).toBe('source_fingerprint_mismatch');
        expect(store.getState().csvData).toBeNull();
        expect(store.getState().datasetBundle).toBe(saved);
        expect(store.getState().isBusy).toBe(false);
        expect(readPiInitialCheckpoint(checkpoint.sessionId)).not.toBeNull();
        expect(recover).not.toHaveBeenCalled();
        // A corrected selection remains possible in the same session.
        await reattachPiInitialCheckpointSource(fileFor(), store as never);
        expect(recover).toHaveBeenCalledOnce();
    });

    it('rejects changed operations even when their IDs are unchanged', async () => {
        const { file, store } = fixture();
        store.setState({ dataPreparationPlan: { operations: [{ id: 'cast-amount', type: 'delete_rows', reason: 'Changed program' }] } });
        await reattachPiInitialCheckpointSource(file, store as never);
        expect(store.getState().initialAnalysisRecovery?.reason).toBe('saved_lineage_mismatch');
        expect(recover).not.toHaveBeenCalled();
    });

    it('reconstructs a canonical analysis view separately from the prepared table', async () => {
        const { file, loaded, prepared, checkpoint } = fixture();
        const structure = resolveReportStructureArtifacts({ rawCsvData: loaded.rawCsvData, csvData: prepared,
            rawIntakeIr: loaded.rawIntakeIr, cleaningRun: null, dataPreparationPlan: loaded.dataPreparationPlan,
            humanBoundary: { headerRowIndex: 0, headerLayerRowIndexes: [], bodyStartIndex: 1, summaryStartIndex: 3,
                parameterRowIndexes: [], repeatedHeaderRowIndexes: [] } });
        expect(structure.canonicalCsvData).not.toBeNull();
        const canonicalState = { ...loaded, ...structure };
        const materialVersion = getCsvDatasetVersion(structure.canonicalCsvData!);
        expect(materialVersion).not.toBe(checkpoint.preparedDatasetVersion);
        const canonicalCheckpoint = { ...checkpoint, datasetVersion: materialVersion,
            initialDatasetVersion: materialVersion, lineageSignature: checkpointLineageSignature(canonicalState),
            stageReceipts: checkpoint.stageReceipts.map(receipt => ({ ...receipt, inputVersion: materialVersion, outputVersion: materialVersion })) };
        const metadata = { ...canonicalState, csvData: null, canonicalCsvData: null, rawCsvData: null, rawIntakeIr: null };
        const rebound = await rebuildCheckpointDataset(file, metadata, canonicalCheckpoint);
        expect(getCsvDatasetVersion(rebound.csvData)).toBe(checkpoint.preparedDatasetVersion);
        expect(getCsvDatasetVersion(rebound.canonicalCsvData!)).toBe(materialVersion);
    });

    it('accepts the same saved contract after normal hydration and plan normalization', () => {
        const { loaded, checkpoint } = fixture();
        const saved = toSerializable(loaded);
        const hydrated = { ...normalizeRestoredAppState(saved), dataPreparationPlan: normalizeDataPreparationPlan(saved.dataPreparationPlan) };
        expect(validateCheckpointState(checkpoint, hydrated, stages, optional)).toBeNull();
    });

    it('preserves the checkpoint and metadata when the query engine cannot rebind', async () => {
        const { file, store, checkpoint } = fixture();
        store.setState({ refreshDuckDbSession: vi.fn(async () => ({ status: 'error' })) });
        await reattachPiInitialCheckpointSource(file, store as never);
        expect(store.getState().initialAnalysisRecovery?.reason).toBe('query_engine_rebind_failed');
        expect(store.getState().csvData).toBeNull();
        expect(store.getState().isBusy).toBe(false);
        expect(readPiInitialCheckpoint(checkpoint.sessionId)).not.toBeNull();
        expect(recover).not.toHaveBeenCalled();
    });

    it('rejects uncertain stages and missing or invalid stage receipts', () => {
        const { checkpoint, loaded } = fixture();
        expect(validateCheckpointState({ ...checkpoint, pendingStageIndex: 4 }, loaded, stages, optional)).toBe('stage_side_effects_uncertain');
        expect(validateCheckpointState({ ...checkpoint, stageReceipts: checkpoint.stageReceipts.slice(1) }, loaded, stages, optional)).toBe('stage_receipt_mismatch');
        expect(validateCheckpointState({ ...checkpoint, stageReceipts: checkpoint.stageReceipts.map((receipt, index) => index === 3
            ? { ...receipt, inputVersion: 'wrong-version' } : receipt) }, loaded, stages, optional)).toBe('stage_receipt_mismatch');
    });

    it('fences a delayed file read after a session switch and leaves a newer lease intact', async () => {
        const { file, store } = fixture();
        let entered!: () => void, release!: (text: string) => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        Object.defineProperty(file, 'text', { configurable: true, value: () => { entered(); return new Promise<string>(resolve => { release = resolve; }); } });
        const pending = reattachPiInitialCheckpointSource(file, store as never);
        await started;
        beginSessionTransition(store as never);
        store.setState({ sessionId: 'new-session', isBusy: true, initialAnalysisRecovery: null, csvData: null });
        const newer = beginRun(store as never, 'follow_up', 'new-run');
        await pending;
        release(text);
        await Promise.resolve();
        expect(store.getState().csvData).toBeNull();
        expect(store.getState().activeExecution?.runId).toBe('new-run');
        expect(store.getState().isBusy).toBe(true);
        expect(recover).not.toHaveBeenCalled();
        finishRun(store as never, newer);
    });

    it('rejects an incompatible replay atomically', async () => {
        const { file, loaded, checkpoint } = fixture();
        const broken = { ...loaded, datasetBundle: { ...loaded.datasetBundle!, transformationPrograms: loaded.datasetBundle!.transformationPrograms.map(program => ({ ...program, inputVersion: 'wrong-input' })) } };
        await expect(rebuildCheckpointDataset(file, broken, { ...checkpoint, lineageSignature: checkpointLineageSignature(broken) })).rejects.toThrow('transformation_input_version_mismatch');
        expect(loaded.csvData?.data[0].Amount).toBe(10);
    });

    it('reads legacy stable checkpoints conservatively and rejects malformed collections', () => {
        const { loaded, checkpoint } = fixture();
        const legacy = { schemaVersion: 1, sessionId: loaded.sessionId, datasetVersion: checkpoint.datasetVersion,
            researchGoal: checkpoint.researchGoal, nextStageIndex: 4, pendingStageIndex: null,
            committedTransformationIds: ['cast-amount'], cardFingerprints: [], warnings: [] };
        localStorage.setItem(initialCheckpointKey(loaded.sessionId), JSON.stringify(legacy));
        const read = readPiInitialCheckpoint(loaded.sessionId)!;
        expect(validateCheckpointState(read, loaded, stages, optional)).toBeNull();
        expect(validateCheckpointState(read, loaded, stages, optional, false)).toBe('legacy_checkpoint_requires_prepared_rows');
        localStorage.setItem(initialCheckpointKey(loaded.sessionId), JSON.stringify({ ...legacy, committedTransformationIds: null }));
        expect(readPiInitialCheckpoint(loaded.sessionId)).toBeNull();
    });

    it('keeps malformed checkpoint metadata blocked instead of falling through to fresh intake', async () => {
        const { file, store } = fixture();
        localStorage.setItem(initialCheckpointKey(store.getState().sessionId), '{broken');
        await reattachPiInitialCheckpointSource(file, store as never);
        expect(store.getState().initialAnalysisRecovery?.reason).toBe('checkpoint_invalid');
        expect(store.getState().csvData).toBeNull();
        expect(store.getState().isBusy).toBe(false);
        expect(recover).not.toHaveBeenCalled();
    });
});
