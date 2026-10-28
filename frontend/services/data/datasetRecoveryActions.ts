import type { StoreApi } from '../agent/types';
import type { CsvData } from '../../types';
import type { DatasetCommitMarker, DatasetCommitReference } from '../../types/datasetCommit';
import { DATASET_COMMITS_STORE, commitHeadKey, commitIntentKey, commitApprovalKey } from '../../types/datasetCommit';
import { getStorageDatabase, type StorageDatabase } from '../storageService';
import { assertRunActive, canCommitRun, rootStore, registerSessionResource } from '../session/sessionOwnership';
import { reconstructDatasetCommit, type RecoveryOptions } from './datasetRecovery';
import { readRetainedRows, retainDatasetRows, collectRetainedRows, type RetentionDirectory } from '../persistence/datasetRetention';
import { currentRecoveryMaterial, rememberRecoveryMaterial } from './datasetReplay';
import { registerSandboxTableRows, clearSandboxTableRows } from './sandboxTableRegistry';
import { primeDuckDbDataset, prepareOrdinaryDatasetBinding, prepareAcceptedSpillBinding, prepareAcceptedTablesBinding } from '../duckdb/queryEngine';
import { acceptedQueryOwner } from '../duckdb/acceptedQueryOwner';
import { readAcceptedDual } from './acceptedDualGrain';
import { verifyAcceptedSpillMarker, verifyAcceptedSpill, acceptedSpillCsv, acceptedPublicationSnapshot, type AcceptedSpillStorage } from './acceptedSpill';
import { bindRecoverySource } from './immutableCsvSource';
import { getCsvDatasetVersion } from '../../utils/datasetId';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { commitDatasetTransaction } from '../persistence/datasetCommitStorage';
import { datasetCommitBindings } from '../persistence/datasetCommitProjection';
import { queueSessionWrite } from '../persistence/currentSessionPersistence';
import { buildPersistedReportRecord } from '../persistence/persistedAppState';
import { buildBuiltinToolRegistry, resolveAllowedTools } from '../agent/tools/toolRegistry';
import { buildToolAvailabilityContext } from '../agent/tools/toolGovernance';

type Reconstructed = Awaited<ReturnType<typeof reconstructDatasetCommit>>;
export interface RecoveryDependencies { database?: () => Promise<StorageDatabase>; bind?: typeof primeDuckDbDataset; directory?: () => Promise<RetentionDirectory>;
    persist?: (store:StoreApi)=>Promise<boolean>; prepareTablesBinding?: typeof prepareAcceptedTablesBinding; acceptedStorage?:AcceptedSpillStorage; prepareSpillBinding?:typeof prepareAcceptedSpillBinding; spillFactory?:import('./candidateSpill').CandidateSpillFactory }
const own = (store: StoreApi) => {
    const lease = store.executionContext?.lease; if (!lease) throw new Error('scope_revoked'); assertRunActive(store, lease); return lease;
};
export const readExactCommit = async (db: StorageDatabase, reference: DatasetCommitReference): Promise<DatasetCommitMarker> => {
    const matches = await db.getAllFromIndex(DATASET_COMMITS_STORE, 'commitId', reference.commitId);
    const marker = matches.find((c): c is DatasetCommitMarker => c.kind === 'commit' && c.sessionId === reference.sessionId && c.revision === reference.revision);
    if (!marker) throw new Error('commit_marker_unavailable'); return marker;
};
/** The local journal resolves a lost acknowledgement before any worker can execute. */
export const readCurrentCommit = async (db: StorageDatabase, store: StoreApi): Promise<DatasetCommitMarker> => {
    own(store); const state = store.getState(), reference = state.datasetBundle?.acceptedCommit;
    const head = await db.get(DATASET_COMMITS_STORE, commitHeadKey(state.sessionId)); own(store);
    if (head) {
        if (head.kind !== 'head' || head.sessionId !== state.sessionId) throw new Error('commit_marker_invalid');
        const marker = await db.get(DATASET_COMMITS_STORE, head.markerKey); own(store);
        if (!marker || marker.kind !== 'commit' || marker.sessionId !== head.sessionId || marker.commitId !== head.commitId || marker.revision !== head.revision) throw new Error('commit_marker_invalid');
        return marker;
    }
    if (state.datasetCommitBindingStatus === 'commit_unknown') throw new Error('commit_outcome_unknown');
    if (!reference) throw new Error('commit_marker_unavailable');
    const marker = await readExactCommit(db, reference); own(store); return marker;
};
const same = (a: DatasetCommitMarker, b: DatasetCommitMarker) => a.sessionId === b.sessionId && a.commitId === b.commitId && a.revision === b.revision && a.payloadDigest === b.payloadDigest;
const reconstruct = async (store: StoreApi, db: StorageDatabase, marker: DatasetCommitMarker, options: RecoveryOptions, dependencies: RecoveryDependencies) => {
    const result = await reconstructDatasetCommit(store, marker, { ...options,
        material: options.material ?? currentRecoveryMaterial(store, marker.commitId),
        readMaterial: async m => m.acceptedDualGrain ? (await readAcceptedDual(m, () => { own(store); }, dependencies.acceptedStorage)).material
            : readRetainedRows(db, m, dependencies.directory), readParent: ref => readExactCommit(db, ref) });
    own(store); return result;
};
export const installVerifiedDatasetCommit = async (store: StoreApi, db: StorageDatabase, marker: DatasetCommitMarker, result: Reconstructed, dependencies: RecoveryDependencies) => {
    const lease = own(store), csv = { fileName: marker.bundle.source.fileName,
        data: structuredClone(result.output.tables.find(t => t.name === marker.bundle.tables.find(t => t.tableId === marker.bundle.primaryTableId)?.name)!.rows) };
    if (getCsvDatasetVersion(csv) !== marker.bundle.datasetVersion) throw new Error('recovery_version_mismatch');
    if (!same(await readCurrentCommit(db, store), marker)) throw new Error('input_version_changed'); own(store);
    if (marker.acceptedDualGrain) {
        const previous = store.getState(), signature = JSON.stringify(previous.datasetBundle);
        const current = () => { own(store); if (store.getState().csvData !== previous.csvData || JSON.stringify(store.getState().datasetBundle) !== signature) throw new Error('input_version_changed'); };
        // Always authenticate durable backing, even when this tab has retained replay material.
        await readAcceptedDual(marker, current, dependencies.acceptedStorage); current();
        const prepared = await (dependencies.prepareTablesBinding ?? prepareAcceptedTablesBinding)(marker, result.output, current, lease.signal);
        try {
            current(); if (!same(await readCurrentCommit(db, store), marker)) throw new Error('input_version_changed'); current();
            prepared.activate(csv, acceptedQueryOwner(store, marker, csv));
            store.setState({ datasetBundle: structuredClone(marker.bundle), csvData: csv, canonicalCsvData: csv, rawCsvData: null,
                datasetCommitBindingStatus: 'ready', activeDataQuery: null, datasetSemanticSnapshot: null, semanticDatasetVersion: null,
                semanticStatus: 'idle', columnRegistry: null, columnProfiles: [], canonicalBuildMeta: null, candidateRecovery: null,
                activeMetricMappingValidation: null, activeSpreadsheetFilter: null, spreadsheetFilterFunction: null,
                vectorStoreDocuments: [], pendingVectorMemoryDocs: [], vectorMemoryState: 'cold', reportMemoryScope: null,
                currentView: 'analysis_dashboard', initialAnalysisStatus: 'ready',
                duckDbSessionStatus: { ...prepared.binding, status: 'ready', fallbackReason: null, lastSyncedAt: new Date() } });
            registerSandboxTableRows(marker.bundle.bundleId, { tables: result.output.tables.map(t => ({ ...t,
                tableId: marker.bundle.tables.find(b => b.name === t.name)!.tableId, columns: t.schema.map(c => c.name) })), lineage: [], relationships: [] }, marker.bundle.datasetVersion);
            rememberRecoveryMaterial(store, marker.commitId, result.material);
            registerSessionResource(lease.scope, () => clearSandboxTableRows(marker.bundle.bundleId));
            prepared.finish(); registerSessionResource(lease.scope, () => prepared.dispose()); return;
        } catch (e) { prepared.rollback(); if (canCommitRun(store, lease) && (store.getState().csvData === previous.csvData || store.getState().csvData === csv)) store.setState(acceptedPublicationSnapshot(previous)); throw e; }
    }
    const previous = store.getState(), signature = JSON.stringify(previous.datasetBundle);
    const current = () => { own(store); if (store.getState().csvData !== previous.csvData || JSON.stringify(store.getState().datasetBundle) !== signature) throw new Error('input_version_changed'); };
    const publish = () => store.setState({ datasetBundle: structuredClone(marker.bundle), csvData: csv, canonicalCsvData: csv, rawCsvData: null,
        datasetCommitBindingStatus: 'rebinding', activeDataQuery: null, datasetSemanticSnapshot: null, semanticDatasetVersion: null, semanticStatus: 'idle',
        columnRegistry: null, columnProfiles: [], canonicalBuildMeta: null, activeMetricMappingValidation: null,
        activeSpreadsheetFilter: null, spreadsheetFilterFunction: null, rawIntakeIr: null, initialDataSample: null,
        pendingClarification: null, pendingMutationConfirmation: null, activeAgentTask: null, candidateRecovery:null,
        vectorStoreDocuments: [], pendingVectorMemoryDocs: [], vectorMemoryState: 'cold', reportMemoryScope: null,
        duckDbSessionStatus: { status: 'binding', engine: null, tableName: null, loadVersion: null, fallbackReason: null, lastSyncedAt: null } });
    const output = { tables: result.output.tables.map(t => ({ ...t, tableId: marker.bundle.tables.find(b => b.name === t.name)!.tableId,
        columns: t.schema.map(c => c.name) })), lineage: [], relationships: [] };
    let prepared: Awaited<ReturnType<typeof prepareOrdinaryDatasetBinding>> | undefined;
    try {
        prepared = await prepareOrdinaryDatasetBinding(csv, current, lease.signal, dependencies.bind); current();
        if (!same(await readCurrentCommit(db, store), marker)) throw new Error('input_version_changed'); current();
        prepared.activate(csv, acceptedQueryOwner(store, marker, csv), marker.bundle.primaryTableId); publish();
        store.setState({ datasetCommitBindingStatus: 'ready', currentView: 'analysis_dashboard', initialAnalysisStatus: 'ready',
            duckDbSessionStatus: { ...prepared.binding, status: 'ready', fallbackReason: null, lastSyncedAt: new Date() } });
        registerSandboxTableRows(marker.bundle.bundleId, output, marker.bundle.datasetVersion);
        registerSessionResource(lease.scope, () => clearSandboxTableRows(marker.bundle.bundleId));
        rememberRecoveryMaterial(store, marker.commitId, result.material);
        prepared.finish();
    } catch (error) {
        prepared?.rollback();
        if (canCommitRun(store, lease) && (store.getState().csvData === previous.csvData || store.getState().csvData === csv) && (JSON.stringify(store.getState().datasetBundle) === signature
            || store.getState().datasetBundle?.acceptedCommit?.commitId === marker.commitId)) {
            if (previous.datasetBundle?.acceptedCommit && previous.csvData) store.setState(acceptedPublicationSnapshot(previous));
            else {
                publish();
                store.setState({ datasetCommitBindingStatus: 'binding_failed', activeDataQuery: null,
                    duckDbSessionStatus: { status: 'error', engine: null, tableName: null, loadVersion: null, fallbackReason: 'committed_dataset_not_bound', lastSyncedAt: null } });
            }
        }
        throw error;
    }
};

export const installAcceptedSpillCommit=async(store:StoreApi,db:StorageDatabase,marker:DatasetCommitMarker,options:RecoveryOptions={},dependencies:RecoveryDependencies={})=>{
    const lease=own(store),previous=store.getState(),signature=JSON.stringify(previous.datasetBundle);
    const current=()=>{own(store);if(store.getState().csvData!==previous.csvData||JSON.stringify(store.getState().datasetBundle)!==signature)throw new Error('input_version_changed');};
    let prepared:Awaited<ReturnType<typeof prepareAcceptedSpillBinding>>|undefined;
    let csv: CsvData | undefined;
    try{
        const manifest=await verifyAcceptedSpillMarker(marker);current();
        if(options.file){await bindRecoverySource(store,options.file,manifest.source);current();}
        const file=await verifyAcceptedSpill(manifest,current,dependencies.acceptedStorage);current();
        prepared=await (dependencies.prepareSpillBinding??prepareAcceptedSpillBinding)(file,manifest,current,lease.signal);current();
        if(!same(await readCurrentCommit(db,store),marker))throw new Error('input_version_changed');current();
        csv=acceptedSpillCsv(manifest,prepared.preview);
        prepared.activate(csv, acceptedQueryOwner(store, marker, csv), marker.bundle.primaryTableId);
        store.setState({datasetBundle:structuredClone(marker.bundle),csvData:csv,canonicalCsvData:csv,rawCsvData:null,candidateRecovery:null,
            datasetCommitBindingStatus:'ready',activeDataQuery:null,datasetSemanticSnapshot:null,semanticDatasetVersion:null,semanticStatus:'idle',
            columnRegistry:null,columnProfiles:[],canonicalBuildMeta:null,activeMetricMappingValidation:null,activeSpreadsheetFilter:null,spreadsheetFilterFunction:null,
            vectorStoreDocuments:[],pendingVectorMemoryDocs:[],vectorMemoryState:'cold',reportMemoryScope:null,
            currentView:'analysis_dashboard',initialAnalysisStatus:'ready',
            duckDbSessionStatus:{...prepared.binding,status:'ready',fallbackReason:null,lastSyncedAt:new Date()}});
        prepared.finish();
    }catch(e){prepared?.rollback();
        if(canCommitRun(store,lease)&&(store.getState().csvData===previous.csvData||store.getState().csvData===csv)&&JSON.stringify(store.getState().datasetBundle?.source.inspection)===JSON.stringify(previous.datasetBundle?.source.inspection)){
            try{store.setState({...acceptedPublicationSnapshot(previous),datasetCommitBindingStatus:previous.datasetBundle?.acceptedCommit?.commitId===marker.commitId?'binding_failed':previous.datasetCommitBindingStatus,activeDataQuery:null});}
            catch{/* A throwing observer must not keep a ready partial publication. */}
        }
        throw e;
    }
};

export const restoreAcceptedDataset = async (store: StoreApi, options: RecoveryOptions = {}, dependencies: RecoveryDependencies = {}): Promise<DatasetCommitMarker> => {
    own(store); const db = await (dependencies.database ?? getStorageDatabase)(); own(store);
    let marker: DatasetCommitMarker;
    try { marker = await readCurrentCommit(db, store); own(store); }
    catch (error) { if (canCommitRun(store, store.executionContext!.lease)) store.setState({ datasetCommitBindingStatus: 'commit_unknown', activeDataQuery: null }); throw error; }
    if(marker.acceptedSpill){await installAcceptedSpillCommit(store,db,marker,options,dependencies);own(store);return marker;}
    const result = await reconstruct(store, db, marker, options, dependencies); own(store);
    await installVerifiedDatasetCommit(store, db, marker, result, dependencies); own(store); return marker;
};
export const retainAcceptedDataset = async (store: StoreApi, dependencies: RecoveryDependencies = {}): Promise<void> => {
    own(store); const db = await (dependencies.database ?? getStorageDatabase)(); own(store);
    const marker = await readCurrentCommit(db, store), material = currentRecoveryMaterial(store, marker.commitId); own(store);
    if (!material) throw new Error('recovery_rows_unavailable');
    await retainDatasetRows(db, marker, material, () => {
        own(store); if (store.getState().datasetBundle?.acceptedCommit?.commitId !== marker.commitId) throw new Error('input_version_changed');
    }, dependencies.directory); own(store);
};
export const collectExpiredDatasetRows = async (store: StoreApi, dependencies: RecoveryDependencies = {}) => {
    const lease = own(store), ownerId = store.getState().datasetBundle?.acceptedCommit?.sessionId ?? lease.scope.sessionId;
    const db = await (dependencies.database ?? getStorageDatabase)(); own(store);
    const result = await collectRetainedRows(db, ownerId, Date.now(), dependencies.directory); own(store); return result;
};

export interface DatasetRollbackReview {
    reviewId: string; digest: string; current: DatasetCommitReference; target: DatasetCommitReference; expiresAt: number;
    tables: Array<{ name: string; rowCount: number; columns: string[] }>;
}
type PreparedRollback = { owner: StoreApi['getState']; scope: object; originRunId: string; current: DatasetCommitMarker; target: DatasetCommitMarker;
    result: Reconstructed; intentKey: string; policy: string };
const rollbacks = new WeakMap<DatasetRollbackReview, PreparedRollback>();
const rollbackPolicy = (store: StoreApi) => {
    const state = store.getState(), allowed = resolveAllowedTools(buildBuiltinToolRegistry(state.columnProfiles?.map(c => c.name) ?? []),
        buildToolAvailabilityContext(state,{hasCsvData:Boolean(state.datasetBundle)}));
    if (!allowed.decisions['data.mutate']?.allowed) throw new Error('capability_unavailable');
    return JSON.stringify(state.settings.runtimeAccessControl);
};
export const listRollbackTargets = async (store: StoreApi, dependencies: RecoveryDependencies = {}) => {
    own(store); const db = await (dependencies.database ?? getStorageDatabase)(); own(store);
    const current = await readCurrentCommit(db, store); own(store);
    const targets:DatasetCommitReference[]=[],seen=new Set([current.commitId]);let cursor=current;
    for(let depth=0;depth<100;depth++){
        const previous=cursor.previousCommit??(cursor.parentCommitId?{sessionId:cursor.sessionId,commitId:cursor.parentCommitId,revision:cursor.revision-1}:null);
        if(!previous)break;if(seen.has(previous.commitId))throw new Error('commit_marker_invalid');seen.add(previous.commitId);
        cursor=await readExactCommit(db,previous);own(store);targets.push(previous);
    }
    return targets;
};
export const reviewDatasetRollback = async (store: StoreApi, targetRef: DatasetCommitReference, options: RecoveryOptions = {}, dependencies: RecoveryDependencies = {}) => {
    const lease = own(store), policy = rollbackPolicy(store), db = await (dependencies.database ?? getStorageDatabase)(); own(store);
    const current = await readCurrentCommit(db, store), target = await readExactCommit(db, targetRef); own(store);
    if(!(await listRollbackTargets(store,{...dependencies,database:async()=>db})).some(ref=>ref.sessionId===target.sessionId&&ref.commitId===target.commitId&&ref.revision===target.revision))throw new Error('rollback_target_invalid');own(store);
    const result = await reconstruct(store, db, target, options, dependencies); own(store);
    if (!same(await readCurrentCommit(db, store), current)) throw new Error('input_version_changed'); own(store);
    const ref = (m: DatasetCommitMarker): DatasetCommitReference => ({ sessionId: m.sessionId, commitId: m.commitId, revision: m.revision });
    const body = { reviewId: `rollback-review-${crypto.randomUUID()}`, current: ref(current), target: ref(target), expiresAt: Date.now() + 300_000,
        tables: target.bundle.tables.map(t => ({ name: t.name, rowCount: t.rowCount, columns: t.schema.map(c => c.name) })) };
    const review: DatasetRollbackReview = Object.freeze({ ...body, digest: await codeDigest({ ...body, targetPayload: target.payloadDigest, policy }) }); own(store);
    rollbacks.set(review, { owner: rootStore(store).getState, scope: lease.scope, originRunId: lease.runId, current, target, result,
        intentKey: `rollback-${crypto.randomUUID()}`, policy }); return review;
};
export const commitDatasetRollback = async (store: StoreApi, review: DatasetRollbackReview, dependencies: RecoveryDependencies = {}) => {
    const lease = own(store), prepared = rollbacks.get(review);
    if (!prepared || prepared.owner !== rootStore(store).getState || prepared.scope !== lease.scope || prepared.originRunId === lease.runId
        || Date.now() >= review.expiresAt || prepared.policy !== rollbackPolicy(store)) throw new Error('approval_invalid');
    const db = await (dependencies.database ?? getStorageDatabase)(); own(store);
    const sessionId = lease.scope.sessionId, current = prepared.current, target = prepared.target, revision = current.sessionId === sessionId ? current.revision + 1 : 1;
    const existing = await db.get(DATASET_COMMITS_STORE, commitIntentKey(sessionId, prepared.intentKey)); own(store);
    if (existing?.kind === 'commit') {
        if (!existing.rollbackTarget || existing.rollbackTarget.commitId !== target.commitId) throw new Error('idempotency_conflict');
        await installVerifiedDatasetCommit(store, db, existing, prepared.result, dependencies); return existing;
    }
    const commitId = `commit-${crypto.randomUUID()}`, now = new Date().toISOString(), approvalId = `approval-${crypto.randomUUID()}`;
    const bundle = { ...structuredClone(target.bundle), acceptedCommit: { sessionId, commitId, revision }, updatedAt: now,
        transformationPrograms: [...current.bundle.transformationPrograms] };
    const transformation = { ...structuredClone(target.transformation), programId: commitId, idempotencyKey: prepared.intentKey,
        inputVersion: current.bundle.datasetVersion, outputVersion: target.bundle.datasetVersion, createdAt: now };
    bundle.transformationPrograms.push(transformation);
    const marker: DatasetCommitMarker = { ...structuredClone(target), recordId: commitIntentKey(sessionId, prepared.intentKey), intentKey: commitIntentKey(sessionId, prepared.intentKey),
        approvalKey: commitApprovalKey(sessionId, approvalId), sessionId, commitId, revision, parentCommitId: current.sessionId === sessionId ? current.commitId : null,
        idempotencyKey: prepared.intentKey, payloadDigest: await codeDigest({ current: current.payloadDigest, target: target.payloadDigest, review: review.digest }),
        candidateId: `rollback-${target.candidateId}`, inputBindings: datasetCommitBindings(current.bundle), outputBindings: datasetCommitBindings(bundle), bundle, transformation,
        rollbackTarget: review.target, previousCommit:{sessionId:current.sessionId,commitId:current.commitId,revision:current.revision},
        approval: { approvalId, reviewDigest: review.digest, approvedAt: Date.now(), expiresAt: review.expiresAt, consumedAt: Date.now() },
        audit: { ...target.audit, sessionEpoch: lease.scope.epoch, runId: lease.runId, turnId: lease.turnId,
            toolCallId: `host-rollback-${crypto.randomUUID()}`, stepId: `rollback-${crypto.randomUUID()}`, committedAt: now } }; own(store);
    let admitted = false;
    try {
        await queueSessionWrite(async () => {
            own(store); if (!same(await readCurrentCommit(db, store), current)) throw new Error('input_version_changed'); own(store);
            return commitDatasetTransaction(db, marker, buildPersistedReportRecord(store.getState(), { id: sessionId, filename: target.bundle.source.fileName }),
                () => { own(store); if (prepared.policy !== rollbackPolicy(store) || Date.now() >= review.expiresAt) throw new Error('approval_invalid'); },
                () => { admitted = true; store.setState({ datasetCommitBindingStatus: 'commit_unknown', activeDataQuery: null, datasetSemanticSnapshot: null }); });
        });
    } catch (error) {
        if (!admitted) throw error;
        // Read durable truth, never execute the operation again on an uncertain result.
        let durable;
        try { durable = await db.get(DATASET_COMMITS_STORE, marker.recordId); }
        catch { throw new Error('commit_outcome_unknown'); }
        if (durable?.kind !== 'commit' || durable.payloadDigest !== marker.payloadDigest) throw new Error('rollback_not_committed');
    }
    own(store); await installVerifiedDatasetCommit(store, db, marker, prepared.result, dependencies); return marker;
};
