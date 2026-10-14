import { captureCsvSource } from '../../../data/immutableCsvSource';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AppState, CsvData } from '../../../../types';
import type { StoreApi } from '../../types';
import { beginRun, assertRunActive, awaitOwned, finishRun, ownsRun, ownsSessionScope, rootStore, scopeRunStore, scopeStore } from '../../../session/sessionOwnership';
import { parseCsvTextWithDetection } from '../../../data/csvDialectDetector';
import { buildReportIntakeIr, rebuildIntakeIrWithBoundary, buildCsvDataFromIntakeIr } from '../../../data/reportCsvIntake';
import { applyAnalysisHeaderAutoNaming } from '../../../data/csvParser';
import { verifyDatasetBundleSource } from '../../../data/datasetBundle';
import { replayDatasetBundlePrograms } from '../../../data/datasetBundleReplay';
import { getCsvDatasetVersion } from '../../../../utils/datasetId';
import { canonicalizeReportTable } from '../../canonicalizeReportTable';
import { createInitialAnalysisStageToolManifests } from '../../tools/manifests/initialAnalysisStageManifests';
import { hasPiInitialCheckpoint, readPiInitialCheckpoint, validateCheckpointState, type PiInitialCheckpointV2 } from './piInitialCheckpoint';
import { recoverPiInitialAnalysisIfNeeded, type PiInitialAnalysisOptions } from './piInitialAnalysisRuntimeService';
import {restoreAcceptedDataset,readCurrentCommit} from '../../../data/datasetRecoveryActions';
import {getStorageDatabase} from '../../../storageService';
import {verifyInitialCodingCommit,reconcileInitialCodingCheckpoint} from './piInitialCodingCheckpoint';
import {writePiInitialCheckpoint} from './piInitialCheckpoint';

const stages = createInitialAnalysisStageToolManifests();
const optional = new Set(['dataset.suggestCleaningPlan', 'dataset.applyTransform']);

/** Deterministic reattachment only. It never asks a model to recreate a saved mutation. */
export const rebuildCheckpointDataset = async (file: File, state: AppState, checkpoint: PiInitialCheckpointV2): Promise<{
    csvData: CsvData; rawCsvData: CsvData; canonicalCsvData: CsvData | null; rawIntakeIr: AppState['rawIntakeIr'];
}> => {
    const bundle = state.datasetBundle;
    if (!bundle || bundle.tables.length !== 1) throw new Error('checkpoint_source_bundle_unavailable');
    if (file.name !== checkpoint.source.fileName || file.size !== checkpoint.source.byteSize) throw new Error('source_file_identity_mismatch');
    const parsed = parseCsvTextWithDetection(await file.text());
    let intake = buildReportIntakeIr(file.name, parsed.rawRows, parsed.detection);
    if (checkpoint.sourceBoundary) intake = rebuildIntakeIrWithBoundary(intake, checkpoint.sourceBoundary, 'ai_fallback_deterministic');
    const rawData = buildCsvDataFromIntakeIr(intake);
    const verification = await verifyDatasetBundleSource({ bundle, file, parsedData: rawData });
    if (!verification.matches) throw new Error(verification.reasonCode);
    const initial = applyAnalysisHeaderAutoNaming(rawData);
    const canonicalize = (prepared: CsvData) => canonicalizeReportTable({
        csvData: prepared, rawCsvData: rawData, rawIntakeIr: intake, reportStructureResolution: state.reportStructureResolution,
    }).artifact?.canonicalCsvData ?? null;
    let replayInput = initial;
    const firstProgram = bundle.transformationPrograms[0];
    if (firstProgram && getCsvDatasetVersion(replayInput) !== firstProgram.inputVersion) {
        const candidate = canonicalize(initial);
        if (!candidate || getCsvDatasetVersion(candidate) !== firstProgram.inputVersion) throw new Error('transformation_input_version_mismatch');
        replayInput = candidate;
    }
    const replay = replayDatasetBundlePrograms({ bundle, currentData: replayInput });
    if (replay.status !== 'replayed') throw new Error(replay.reasonCodes.join(', '));
    const prepared = replay.data;
    if (getCsvDatasetVersion(prepared) !== checkpoint.preparedDatasetVersion) throw new Error('prepared_version_mismatch');
    const canonical = state.canonicalBuildMeta ? canonicalize(prepared) : null;
    const rebound = { csvData: prepared, rawCsvData: rawData, rawIntakeIr: intake, canonicalCsvData: canonical };
    const reason = validateCheckpointState(checkpoint, { ...state, ...rebound }, stages, optional);
    if (reason) throw new Error(reason);
    return rebound;
};

export const reattachPiInitialCheckpointSource = async (file: File, inputStore: StoreApi, streamOverride?: StreamFn, options?:PiInitialAnalysisOptions) => {
    const store = rootStore(inputStore);
    const state = store.getState();
    const checkpoint = readPiInitialCheckpoint(state.sessionId);
    if (!checkpoint) {
        if (hasPiInitialCheckpoint(state.sessionId)) store.setState({ isBusy: false, initialAnalysisRecovery: {
            status: 'blocked', reason: 'checkpoint_invalid', fileName: state.datasetBundle?.source.fileName ?? '', nextStageIndex: 0,
        } });
        return null;
    }
    const projection = (status: NonNullable<AppState['initialAnalysisRecovery']>['status'], reason: string | null = null) => ({
        status, reason, fileName: checkpoint.schemaVersion === 2 ? checkpoint.source.fileName : state.datasetBundle?.source.fileName ?? '',
        nextStageIndex: checkpoint.nextStageIndex,
    });
    const codingCommit=checkpoint.schemaVersion===2&&checkpoint.coding&&(checkpoint.coding.commit||[2,3].includes(checkpoint.pendingStageIndex??-1));
    const reason = codingCommit?null:validateCheckpointState(checkpoint, state, stages, optional, false);
    if (reason || checkpoint.schemaVersion !== 2) {
        store.setState({ initialAnalysisRecovery: projection('blocked', reason ?? 'legacy_checkpoint_requires_prepared_rows'), isBusy: false });
        state.addProgress?.(`Checkpoint recovery blocked: ${reason ?? 'legacy_checkpoint_requires_prepared_rows'}.`, 'warning');
        return null;
    }
    const lease = beginRun(store, 'initial_analysis', `pi-rebind-${crypto.randomUUID()}`);
    const owned = scopeRunStore(store, lease);
    owned.setState({ isBusy: true, initialAnalysisRecovery: projection('verifying_source') });
    try {
        if(codingCommit){
            const db=await awaitOwned(getStorageDatabase(),store,lease);
            const marker=await awaitOwned(readCurrentCommit(db,owned),store,lease);
            await awaitOwned(verifyInitialCodingCommit(checkpoint,marker),store,lease);
            await awaitOwned(restoreAcceptedDataset(owned,{file}),store,lease);
            const reconciled=await awaitOwned(reconcileInitialCodingCheckpoint(checkpoint,owned.getState(),marker),store,lease);
            const invalid=validateCheckpointState(reconciled,owned.getState(),stages,optional);
            if(invalid)throw new Error(invalid);
            writePiInitialCheckpoint(reconciled);
            finishRun(store,lease);
            return await recoverPiInitialAnalysisIfNeeded(scopeStore(store,lease.scope),streamOverride,options);
        }
        const rebound = await awaitOwned(rebuildCheckpointDataset(file, state, checkpoint), store, lease);
        assertRunActive(store, lease);
        const inspection = await awaitOwned(captureCsvSource(owned, file), store, lease);
        assertRunActive(store, lease);
        owned.setState({ ...rebound, datasetBundle: { ...state.datasetBundle!, source: { ...state.datasetBundle!.source, inspection } },
            workspaceFiles: { ...state.workspaceFiles, '/intake/source.json': JSON.stringify(inspection, null, 2) },
            initialAnalysisRecovery: projection('rebinding'), initialAnalysisStatus: 'paused' });
        // Bind the reconstructed material view before granting a fresh runtime lease.
        if (owned.getState().refreshDuckDbSession) {
            const binding = await awaitOwned(owned.getState().refreshDuckDbSession(rebound.canonicalCsvData ?? rebound.csvData, lease.scope, lease), store, lease);
            assertRunActive(store, lease);
            if (binding.status !== 'ready') throw new Error('query_engine_rebind_failed');
        }
        owned.setState({ currentView: 'analysis_dashboard', isBusy: false });
        finishRun(store, lease);
        return await recoverPiInitialAnalysisIfNeeded(scopeStore(store, lease.scope), streamOverride,options);
    } catch (error) {
        if (ownsRun(store, lease) || (ownsSessionScope(store, lease.scope) && !store.getState().activeExecution)) {
            // Keep the metadata and checkpoint available for a corrected source; never start fresh analysis here.
            const message = error instanceof Error ? error.message : String(error);
            store.setState({ ...(!codingCommit ? {csvData: state.csvData, rawCsvData: state.rawCsvData, rawIntakeIr: state.rawIntakeIr,
                canonicalCsvData: state.canonicalCsvData, currentView: state.currentView} : {}), initialAnalysisStatus: 'paused',
                initialAnalysisRecovery: projection('blocked', message), isBusy: false });
            store.getState().addProgress?.(`Checkpoint recovery blocked: ${message}. Saved analysis was preserved.`, 'error');
        }
        return null;
    } finally {
        if (ownsRun(store, lease)) {
            store.setState({ isBusy: false });
            finishRun(store, lease);
        }
    }
};
