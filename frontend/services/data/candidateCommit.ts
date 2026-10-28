import type { CsvData, DatasetBundle, SandboxTransformationOutput } from '../../types';
import type { StoreApi } from '../agent/types';
import type { StagedDatasetCandidate } from './candidateContract';
import type { CandidateValidationReceipt } from './candidateStaging';
import type { CodePolicyContext } from '../agent/execution/codeExecutionContract';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { sha256Bytes } from './sourceDigest';
import { assessDatasetRelationship } from './datasetBundle';
import { getCsvDatasetVersion } from '../../utils/datasetId';
import { registerSandboxTableRows, clearSandboxTableRows } from './sandboxTableRegistry';
import { assertRunActive, canCommitRun, registerSessionResource, rootStore } from '../session/sessionOwnership';
import { getStorageDatabase, type StorageDatabase } from '../storageService';
import { commitDatasetTransaction, readCommitIntent } from '../persistence/datasetCommitStorage';
import { datasetCommitBindings } from '../persistence/datasetCommitProjection';
import { queueSessionWrite } from '../persistence/currentSessionPersistence';
import { buildPersistedReportRecord } from '../persistence/persistedAppState';
import { primeDuckDbDataset, prepareOrdinaryDatasetBinding, prepareAcceptedSpillBinding, prepareAcceptedTablesBinding } from '../duckdb/queryEngine';
import { acceptedQueryOwner } from '../duckdb/acceptedQueryOwner';
import { planAcceptedDual, writeAcceptedDual } from './acceptedDualGrain';
import { planAcceptedStreamedDual, writeAcceptedStreamedDual, acceptedStreamedDualCsv, type AcceptedStreamedDual } from './acceptedStreamedDual';
import { dualMetrics } from './streamedDualGrain';
import { planAcceptedSpill, writeAcceptedSpill, acceptedSpillCsv, acceptedPublicationSnapshot, type AcceptedSpillManifest, type AcceptedSpillStorage, type SpillReadCustody } from './acceptedSpill';
import { detachCandidateDraft } from './detachedCandidateDraft';
import { compensateSpillCommit } from '../persistence/datasetCommitStorage';
import { normalizeRuntimeAccessControlSettings } from '../runtimeAccessControl';
import { captureDatasetReplay, rememberRecoveryMaterial } from './datasetReplay';
import type { DatasetRecoveryMaterial, CandidateRecoveryCheckpoint } from './datasetRecoveryContract';
import { pauseTaskBudget } from '../agent/runtime/pi/piTaskBudget';
import { buildBuiltinToolRegistry, resolveAllowedTools } from '../agent/tools/toolRegistry';
import { buildToolAvailabilityContext } from '../agent/tools/toolGovernance';
import { DATASET_COMMITS_STORE, commitApprovalKey, commitHeadKey, commitIntentKey, validCommitKey,
    type DatasetCommitMarker } from '../../types/datasetCommit';

const immutable = <T>(value: T): T => {
    const visit = (v: unknown) => { if (v && typeof v === 'object') { Object.values(v).forEach(visit); Object.freeze(v); } };
    const copy = structuredClone(value); visit(copy); return copy;
};
const reason = (error: unknown): string => error instanceof Error && /^[a-z_]+$/.test(error.message)
    ? error.message : error instanceof Error && error.name === 'AbortError' ? 'scope_revoked'
        : error instanceof Error && error.name === 'QuotaExceededError' ? 'storage_quota_exceeded' : 'commit_storage_failed';

export interface CandidateCommitReview {
    reviewId: string; reviewDigest: string; payloadDigest: string; candidateId: string; idempotencyKey: string;
    primaryTable: string; expiresAt: number; inputBindings: StagedDatasetCandidate['inputBindings'];
    changeDigest: string; validationDigest: string; programDigest: string; environmentDigest: string; outputDigest: string;
    scopeDigest: string; grantDigest: string; policyDigest: string;
    tables: Array<{name: string; rowCount: number; columns: string[]}>;
    rowStorage: 'transient' | 'durable_spill';
    acceptedDualGrain?: import('./acceptedDualGrain').AcceptedDualGrain;
    acceptedStreamedDual?: AcceptedStreamedDual;
    relationships?: StagedDatasetCandidate['relationships'];
    grains?: Array<{ table: string; grain: string[]; metrics: import('./candidateValidation').CandidateValidationContract['tables'][number]['metrics'] }>;
    spill?: AcceptedSpillManifest;
}
export interface CandidateCommitApproval { approvalId: string; reviewDigest: string; approvedAt: number; expiresAt: number }
export interface CandidateCommitOutcome {
    status: 'committed' | 'not_committed' | 'unknown'; admitted: boolean; replay: boolean;
    acknowledgement?: 'installed' | 'revoked' | 'binding_failed' | 'superseded';
    marker?: DatasetCommitMarker; reason?: string;
}
type Prepared = { review: CandidateCommitReview; candidate: StagedDatasetCandidate; validation: Readonly<CandidateValidationReceipt>;
    marker: DatasetCommitMarker; csv: CsvData; output: SandboxTransformationOutput; check: () => void;
    recovery?: DatasetRecoveryMaterial;
    streamed?: {manifest:AcceptedStreamedDual;custody:SpillReadCustody};
    spill?: {manifest:AcceptedSpillManifest;custody:SpillReadCustody};
    bindingStatus: ReturnType<StoreApi['getState']>['datasetCommitBindingStatus'] };

/** Host-only review/approval boundary. No model tool, saved record or copied object grants approval. */
export const createCandidateCommitService = (store: StoreApi, options: {
    database?: () => Promise<StorageDatabase>;
    bind?: typeof primeDuckDbDataset;
    policy?: CodePolicyContext;
    onAdmitted?: () => void;
    acceptedStorage?: AcceptedSpillStorage;
    prepareSpillBinding?: typeof prepareAcceptedSpillBinding;
    prepareTablesBinding?: typeof prepareAcceptedTablesBinding;
} = {}) => {
    let lease = store.executionContext?.lease;
    const originalLease = lease, originalRoot = rootStore(store), port = store.candidateStaging, execution = store.codeExecution;
    if (!lease || !port || !execution?.assertCommitEligible) throw new Error('candidate_commit_unavailable');
    let context = {lease, toolCallId:`host-commit-${crypto.randomUUID()}`,stepId:`commit-${crypto.randomUUID()}`};
    const reviews = new WeakMap<CandidateCommitReview, Prepared>();
    let approvals = new WeakMap<CandidateCommitApproval, Prepared>();
    const unresolved = new WeakSet<CandidateCommitApproval>();
    const capsules = new WeakMap<object, Prepared>();
    let suspended = false, resumed = false, spillPolicy = false;
    let detachedCheck: ((target: StoreApi, context: typeof store.executionContext & {}) => void) | undefined;
    const database = options.database ?? getStorageDatabase;
    const own = () => { if (suspended) throw new Error('scope_revoked'); assertRunActive(store, lease!); };
    const policy = () => {
        const state = store.getState();
        const allowed = resolveAllowedTools(buildBuiltinToolRegistry(state.columnProfiles?.map(c=>c.name)??[]),
            buildToolAvailabilityContext(state,{...options.policy,hasCodeExecution:true,...(spillPolicy?{hasCsvData:Boolean(state.datasetBundle)}:{})}));
        if (!allowed.decisions['data.mutate']?.allowed) throw new Error('capability_unavailable');
        return JSON.stringify(normalizeRuntimeAccessControlSettings(state.settings.runtimeAccessControl));
    };

    const review = async (candidateId: string, input: {idempotencyKey: string; primaryTable: string}): Promise<CandidateCommitReview> => {
        own();
        if (!validCommitKey(input.idempotencyKey)) throw new Error('idempotency_key_invalid');
        const candidate = port.read(candidateId), validation = port.validationReceipt(candidateId);
        if (!validation || validation.decision !== 'validated') throw new Error('validation_failed');
        // Private inference custody and complete independent receipts select the bounded lane.
        // Unsupported dual candidates retain the draft-only gate.
        const restriction = port.commitRestriction(candidateId);
        if (restriction) throw new Error(restriction);
        if((candidate.spill||candidate.streamedDual)&&((candidate.spill&&candidate.tables.length!==1)||candidate.execution.inputs?.length||candidate.execution.coverage?.length||candidate.execution.sources?.length))throw new Error('candidate_spill_inputs_unsupported');
        const sourceBundle = store.getState().datasetBundle;
        if (!sourceBundle) throw new Error('complete_input_unavailable');
        const custody = candidate.spill||candidate.streamedDual ? port.captureSpillRead(candidateId) : undefined;
        const targetSignature=JSON.stringify(sourceBundle),targetCsv=store.getState().csvData;
        // Review revalidation can have a complete retained original without an accepted preview.
        // This affects only the host commit policy check, never ordinary tool/execution grants.
        spillPolicy=Boolean(custody);
        const capturedPolicy = policy(), expiresAt = Date.now()+300_000;
        const check = () => {
            own();
            if(candidate.streamedDual&&(JSON.stringify(store.getState().datasetBundle)!==targetSignature||store.getState().csvData!==targetCsv))throw new Error('input_version_changed');
            if (Date.now() >= expiresAt || policy() !== capturedPolicy) throw new Error('approval_invalid');
            if (resumed) { detachedCheck!(store, context); return; }
            if (port.read(candidateId) !== candidate || port.validationReceipt(candidateId) !== validation) throw new Error('validation_failed');
            execution.assertCommitEligible!(candidate.execution.jobId,context,options.policy,custody?.authority);
        };
        check();
        const primary = candidate.tables.find(t=>t.name===input.primaryTable);
        if (!primary) throw new Error('candidate_primary_table_required');
        if ((port.boundedDualCommit(candidateId)||candidate.streamedDual) && primary.name !== candidate.relationships[0].toTable) throw new Error('candidate_primary_grain_required');
        const artifact = execution.workspace.read(candidate.execution.program!.path,candidate.execution.program!.revision);
        const environment = candidate.execution.environment;
        if (!environment || await codeDigest(environment) !== validation.environmentDigest
            || await sha256Bytes(new TextEncoder().encode(artifact.content)) !== validation.programDigest) throw new Error('candidate_artifact_mismatch');
        check();
        const streamed = candidate.streamedDual ? await planAcceptedStreamedDual(custody!,port.captureStreamedDualBinding(candidateId),store,check) : undefined;check();
        const spill = custody&&!streamed ? await planAcceptedSpill(custody,store,check) : undefined;check();
        const recovery = spill||streamed ? undefined : await captureDatasetReplay(store, candidate, sourceBundle); check();
        const csv: CsvData = streamed ? acceptedStreamedDualCsv(streamed) : spill ? acceptedSpillCsv(spill) : {fileName:sourceBundle.source.fileName,data:primary.rows.map(row=>({...row}))};
        const outputVersion = getCsvDatasetVersion(csv), now = new Date().toISOString();
        const tables = candidate.tables.map((table,index)=>({tableId:table===primary?sourceBundle.primaryTableId:`${candidate.candidateId}-table-${index}`,
            bundleId:sourceBundle.bundleId,name:table.name,role:table.role,schema:structuredClone(table.schema),rowCount:table.rowCount,
            storage:streamed?{mode:'accepted_spill' as const,generation:streamed.tables[index].generation,manifestDigest:streamed.digest,loadVersion:`accepted-${streamed.digest}`,ephemeral:false as const}:spill?{mode:'accepted_spill' as const,generation:spill.generation,manifestDigest:spill.digest,loadVersion:`accepted-${spill.digest}`,ephemeral:false as const}:{mode:'memory' as const,ephemeral:true},sourceRange:null,datasetVersion:outputVersion}));
        const output: SandboxTransformationOutput = {tables:tables.map((table,index)=>({tableId:table.tableId,name:table.name,role:table.role,
            columns:table.schema.map(c=>c.name),rows:candidate.tables[index].rows.map(row=>({...row}))})),lineage:[],relationships:[]};
        const relationships = candidate.relationships.map(r=>{
            const from=tables.find(t=>t.name===r.fromTable)!,to=tables.find(t=>t.name===r.toTable)!;
            // Independent streaming validation proves every strictly unique parent key,
            // same-record FK and unique header dimension without materializing a key map.
            if(streamed)return {relationshipId:`relationship-${candidate.candidateId}`,fromTableId:from.tableId,toTableId:to.tableId,
                fromKeys:r.fromKeys,toKeys:r.toKeys,cardinality:'many_to_one' as const,fromKeyUniqueness:to.rowCount/from.rowCount,
                toKeyUniqueness:1,foreignKeyCoverage:1,duplicateAmplification:1,decision:'trusted' as const,reasonCodes:['relationship_safe' as const],validatedAt:now};
            return assessDatasetRelationship({fromTable:from,toTable:to,fromRows:output.tables.find(t=>t.tableId===from.tableId)!.rows,
                toRows:output.tables.find(t=>t.tableId===to.tableId)!.rows,fromKeys:r.fromKeys,toKeys:r.toKeys},now);
        });
        if (relationships.some(r=>r.decision!=='trusted')) throw new Error('validation_failed');
        const commitId=`commit-${crypto.randomUUID()}`,parent=sourceBundle.acceptedCommit;
        const revision=parent?.sessionId===lease.scope.sessionId?parent.revision+1:1;
        const transformation = {programId:commitId,bundleId:sourceBundle.bundleId,inputVersion:sourceBundle.datasetVersion,outputVersion,
            idempotencyKey:input.idempotencyKey,status:'committed' as const,createdAt:now,steps:[{stepId:context.stepId,kind:'sandbox_js' as const,
                sandboxCodeRef:validation.programDigest,inputTableIds:candidate.inputBindings.map(b=>b.tableId),outputTableIds:tables.map(t=>t.tableId),idempotencyKey:input.idempotencyKey}]};
        const relationshipSetId=`relationships-${await codeDigest(relationships.map(({validatedAt:_time,...r})=>r))}`;
        check();
        const bundle: DatasetBundle = {...structuredClone(sourceBundle),datasetVersion:outputVersion,tables,relationships,relationshipSetId,
            primaryTableId:tables.find(t=>t.name===primary.name)!.tableId,transformationPrograms:[...sourceBundle.transformationPrograms,transformation],
            acceptedCommit:{sessionId:lease.scope.sessionId,commitId,revision},updatedAt:now,
            structureResolution:{status:'trusted',reasonCodes:['candidate_independently_validated'],recoveryGuidance:[],bundleId:sourceBundle.bundleId,primaryTableId:sourceBundle.primaryTableId}};
        const payload = {sessionId:lease.scope.sessionId,sessionEpoch:lease.scope.epoch,taskId:candidate.taskId,taskRevision:candidate.taskRevision,
            candidateId,primaryTable:primary.name,inputBindings:candidate.inputBindings,changeDigest:candidate.changeDigest,
            validationDigest:validation.receiptDigest,programDigest:validation.programDigest,environmentDigest:validation.environmentDigest,
            outputDigest:validation.outputDigest,scopeDigest:validation.scopeDigest,grantDigest:candidate.execution.grant!.digest,policyDigest:await codeDigest(capturedPolicy),
            recoveryDigest:streamed?.digest??spill?.digest??recovery!.manifest.digest,...(spill?{spill}: {}),...(streamed?{acceptedStreamedDual:streamed}:{}),
            ...(port.boundedDualCommit(candidateId)||streamed ? { namespaceId: candidate.namespaceId, targetCommit: bundle.acceptedCommit,
                targetBundleDigest: await codeDigest(bundle), contractDigest: validation.contractDigest } : {})};
        check();
        const payloadDigest=await codeDigest(payload);
        const body={...payload,reviewId:`review-${crypto.randomUUID()}`,idempotencyKey:input.idempotencyKey,payloadDigest,expiresAt,
            tables:tables.map(t=>({name:t.name,rowCount:t.rowCount,columns:t.schema.map(c=>c.name)})),rowStorage:spill||streamed?'durable_spill' as const:'transient' as const};
        let result=immutable({...body,reviewDigest:await codeDigest(body)});check();
        const marker: DatasetCommitMarker = {kind:'commit',recordId:commitIntentKey(lease.scope.sessionId,input.idempotencyKey),
            intentKey:commitIntentKey(lease.scope.sessionId,input.idempotencyKey),approvalKey:'',sessionId:lease.scope.sessionId,commitId,revision,
            parentCommitId:parent?.sessionId===lease.scope.sessionId?parent.commitId:null,idempotencyKey:input.idempotencyKey,payloadDigest,
            candidateId,changeDigest:candidate.changeDigest,inputBindings:structuredClone(candidate.inputBindings),outputBindings:datasetCommitBindings(bundle),
            bundle,transformation,program:{...candidate.execution.program!,content:artifact.content},environment:structuredClone(environment),
            inputArtifacts:structuredClone(candidate.execution.inputs??[]),outputArtifacts:structuredClone(candidate.outputArtifacts),validation:structuredClone(validation),
            lineage:{tables:candidate.tables.map(t=>({name:t.name,cells:structuredClone(t.lineage)})),excludedRows:structuredClone(candidate.excludedRows)},
            approval:{approvalId:'',reviewDigest:result.reviewDigest,approvedAt:0,expiresAt,consumedAt:0},
            audit:{sessionEpoch:lease.scope.epoch,taskId:candidate.taskId,taskRevision:candidate.taskRevision,runId:lease.runId,turnId:lease.turnId,
                toolCallId:context.toolCallId,stepId:context.stepId,grantDigest:payload.grantDigest,committedAt:now},rowStorage:spill||streamed?'durable_spill':'transient',...(streamed?{acceptedStreamedDual:streamed,spillRunRequest:structuredClone(candidate.execution.runRequest!)}:spill?{acceptedSpill:spill,spillRunRequest:structuredClone(candidate.execution.runRequest!)}:{replayManifest:recovery!.manifest}),
            previousCommit:sourceBundle.acceptedCommit};
        if (port.boundedDualCommit(candidateId)) {
            marker.acceptedDualGrain = await planAcceptedDual(marker, recovery!.material); check();
            const exactBody = { ...body, acceptedDualGrain: marker.acceptedDualGrain, relationships: candidate.relationships,
                grains: recovery!.manifest.validationBinding.contract.tables.map(t => ({ table: t.name, grain: t.grain, metrics: t.metrics })),
                source: sourceBundle.source.inspection, targetCommit: bundle.acceptedCommit };
            result = immutable({ ...exactBody, reviewDigest: await codeDigest(exactBody) }); check();
            marker.approval.reviewDigest = result.reviewDigest;
        }
        if(streamed){
            const exactBody={...body,acceptedStreamedDual:streamed,relationships:candidate.relationships,
                grains:streamed.binding.streamedDual!.meaning.proposal.tables.map(t=>({table:t.name,grain:t.grain,metrics:dualMetrics(t)})),targetCommit:bundle.acceptedCommit};
            result=immutable({...exactBody,reviewDigest:await codeDigest(exactBody)});check();marker.approval.reviewDigest=result.reviewDigest;
        }
        reviews.set(result,{review:result,candidate,validation,marker,csv,output,check,recovery:recovery?.material,...(streamed?{streamed:{manifest:streamed,custody:custody!}}:{}),...(spill?{spill:{manifest:spill,custody:custody!}}:{}),bindingStatus:store.getState().datasetCommitBindingStatus});
        return result;
    };

    const approve = (reviewed: CandidateCommitReview): CandidateCommitApproval => {
        const prepared=reviews.get(reviewed);if(!prepared)throw new Error('approval_invalid');prepared.check();
        const approval=immutable({approvalId:`approval-${crypto.randomUUID()}`,reviewDigest:reviewed.reviewDigest,approvedAt:Date.now(),expiresAt:reviewed.expiresAt});
        approvals.set(approval,prepared);return approval;
    };

    const install = async (marker: DatasetCommitMarker, prepared: Prepared, db: StorageDatabase,
        preparedBinding?: Awaited<ReturnType<typeof prepareOrdinaryDatasetBinding>>): Promise<CandidateCommitOutcome['acknowledgement']> => {
        if (!canCommitRun(store,lease)) return 'revoked';
        const current=await db.get(DATASET_COMMITS_STORE,commitHeadKey(marker.sessionId));
        if (!canCommitRun(store,lease)) return 'revoked';
        if (current?.kind!=='head'||current.commitId!==marker.commitId) {
            if (current?.kind!=='head'||store.getState().datasetBundle?.acceptedCommit?.commitId!==current.commitId) {
                store.setState({datasetCommitBindingStatus:'binding_failed',activeDataQuery:null});
            }
            return 'superseded';
        }
        if (store.getState().datasetBundle?.acceptedCommit?.commitId===marker.commitId && store.getState().datasetCommitBindingStatus==='ready') return 'installed';
        const previous = store.getState(), csv = structuredClone(prepared.csv), signature = JSON.stringify(previous.datasetBundle);
        const stillOwned = () => { if (!canCommitRun(store, lease)) throw new Error('scope_revoked');
            if (store.getState().csvData !== previous.csvData || JSON.stringify(store.getState().datasetBundle) !== signature) throw new Error('input_version_changed'); };
        const publish = () => store.setState({datasetBundle:structuredClone(marker.bundle),csvData:csv,canonicalCsvData:csv,candidateRecovery:null,
            datasetCommitBindingStatus:'rebinding',activeDataQuery:null,datasetSemanticSnapshot:null,semanticDatasetVersion:null,semanticStatus:'idle',
            columnRegistry:null,columnProfiles:[],canonicalBuildMeta:null,activeMetricMappingValidation:null,activeSpreadsheetFilter:null,spreadsheetFilterFunction:null,
            vectorStoreDocuments:[],pendingVectorMemoryDocs:[],vectorMemoryState:'cold',reportMemoryScope:null,
            duckDbSessionStatus:{status:'binding',engine:null,tableName:null,loadVersion:null,fallbackReason:null,lastSyncedAt:null}});
        try {
            preparedBinding ??= await prepareOrdinaryDatasetBinding(prepared.csv, stillOwned, lease.signal, options.bind);
            stillOwned();
            const latest=await db.get(DATASET_COMMITS_STORE,commitHeadKey(marker.sessionId)); stillOwned();
            if (latest?.kind!=='head'||latest.commitId!==marker.commitId) { preparedBinding.rollback(); return 'superseded'; }
            preparedBinding.activate(csv, acceptedQueryOwner(store, marker, csv), marker.bundle.primaryTableId); publish();
            store.setState({datasetCommitBindingStatus:'ready',duckDbSessionStatus:{...preparedBinding.binding,status:'ready',fallbackReason:null,lastSyncedAt:new Date()}});
            registerSandboxTableRows(marker.bundle.bundleId,prepared.output,marker.bundle.datasetVersion);
            rememberRecoveryMaterial(store, marker.commitId, prepared.recovery!);
            registerSessionResource(lease.scope,()=>clearSandboxTableRows(marker.bundle.bundleId));
            preparedBinding.finish(); return 'installed';
        } catch {
            preparedBinding?.rollback();
            if (!canCommitRun(store, lease) || (store.getState().csvData !== previous.csvData && store.getState().csvData !== csv)) return 'revoked';
            if (previous.datasetBundle?.acceptedCommit) {
                store.setState({ ...acceptedPublicationSnapshot(previous), datasetCommitBindingStatus: prepared.bindingStatus, activeDataQuery: null });
            } else {
                publish();
                store.setState({datasetCommitBindingStatus:'binding_failed',duckDbSessionStatus:{status:'error',engine:null,tableName:null,loadVersion:null,
                    fallbackReason:'committed_dataset_not_bound',lastSyncedAt:null}});
            }
            return 'binding_failed';
        }
    };

    const spillAttempts=new WeakSet<Prepared>();
    const commitSpill=async(approval:CandidateCommitApproval,prepared:Prepared):Promise<CandidateCommitOutcome>=>{
        if(spillAttempts.has(prepared))return {status:'not_committed',admitted:false,replay:false,reason:'approval_consumed'};
        spillAttempts.add(prepared);
        let admitted=false,durable=false,created:Awaited<ReturnType<typeof writeAcceptedSpill>>|undefined;
        let binding:Awaited<ReturnType<typeof prepareAcceptedSpillBinding>>|undefined;
        let marker:DatasetCommitMarker|undefined;
        const previous=store.getState();
        try{
            prepared.check();
            const db=await database();prepared.check();
            if(await readCommitIntent(db,lease!.scope.sessionId,prepared.review.idempotencyKey))throw new Error('approval_consumed');
            prepared.check();
            const spill=prepared.spill!;
            // Authentication is repeated during copy; a stored PASS never attests current backing availability.
            created=await writeAcceptedSpill(spill.manifest,spill.custody,store,prepared.check,options.acceptedStorage);prepared.check();
            binding=await (options.prepareSpillBinding??prepareAcceptedSpillBinding)(created.file,spill.manifest,prepared.check,lease!.signal);prepared.check();
            const csv=acceptedSpillCsv(spill.manifest,binding.preview);
            marker=immutable({...prepared.marker,...(store.piTask?{taskBudget:structuredClone(store.piTask.snapshot.budget)}:{}),
                approvalKey:commitApprovalKey(lease!.scope.sessionId,approval.approvalId),approval:{...approval,consumedAt:Date.now()},
                audit:{...prepared.marker.audit,runId:lease!.runId,turnId:lease!.turnId,toolCallId:context.toolCallId,stepId:context.stepId}});
            const accepted=marker;
            return await queueSessionWrite(async()=>{
                prepared.check();
                const baseline=buildPersistedReportRecord(previous,{id:lease!.scope.sessionId,filename:csv.fileName});
                const saved=await db.get('reports',lease!.scope.sessionId),head=await db.get(DATASET_COMMITS_STORE,commitHeadKey(lease!.scope.sessionId));prepared.check();
                if(head&&head.kind!=='head')throw new Error('commit_marker_invalid');
                try{
                    await commitDatasetTransaction(db,accepted,baseline,prepared.check,()=>{admitted=true;
                        store.setState({datasetCommitBindingStatus:'commit_unknown',activeDataQuery:null,datasetSemanticSnapshot:null});options.onAdmitted?.();});
                    durable=true;
                }catch(error){
                    if(admitted){
                        try{const stored=await readCommitIntent(db,accepted.sessionId,accepted.idempotencyKey);durable=stored?.payloadDigest===accepted.payloadDigest;}
                        catch{binding!.rollback();return {status:'unknown' as const,admitted,replay:false,reason:'commit_outcome_unknown'};}
                    }
                    if(!durable)throw error;
                }
                if(!canCommitRun(store,lease)){binding!.rollback();return {status:'committed' as const,admitted,replay:false,marker:accepted,acknowledgement:'revoked' as const};}
                try{
                    prepared.check();
                    const latest=await db.get(DATASET_COMMITS_STORE,commitHeadKey(accepted.sessionId));prepared.check();
                    if(latest?.kind!=='head'||latest.commitId!==accepted.commitId)throw new Error('commit_activation_superseded');
                    binding!.activate(csv, acceptedQueryOwner(store, accepted, csv), accepted.bundle.primaryTableId);
                    store.setState({datasetBundle:structuredClone(accepted.bundle),csvData:csv,canonicalCsvData:csv,rawCsvData:null,candidateRecovery:null,
                        datasetCommitBindingStatus:'ready',activeDataQuery:null,datasetSemanticSnapshot:null,semanticDatasetVersion:null,semanticStatus:'idle',
                        columnRegistry:null,columnProfiles:[],canonicalBuildMeta:null,activeMetricMappingValidation:null,activeSpreadsheetFilter:null,spreadsheetFilterFunction:null,
                        vectorStoreDocuments:[],pendingVectorMemoryDocs:[],vectorMemoryState:'cold',reportMemoryScope:null,
                        duckDbSessionStatus:{...binding!.binding,status:'ready',fallbackReason:null,lastSyncedAt:new Date()}});
                    binding!.finish();
                    return {status:'committed' as const,admitted,replay:false,marker:accepted,acknowledgement:'installed' as const};
                }catch(error){
                    binding!.rollback();
                    // Do not publish stale state across a source/session switch. The accepted journal remains recoverable.
                    if(!canCommitRun(store,lease))return {status:'committed' as const,admitted,replay:false,marker:accepted,acknowledgement:'revoked' as const};
                    try{
                        // Restore route and its publication together before yielding to journal compensation.
                        if(store.getState().csvData===previous.csvData||store.getState().csvData===csv)
                            store.setState({...acceptedPublicationSnapshot(previous),datasetCommitBindingStatus:'commit_unknown',activeDataQuery:null});
                        await compensateSpillCommit(db,accepted,saved??baseline,head?.kind==='head'?head:undefined);
                        if(canCommitRun(store,lease)&&(store.getState().csvData===previous.csvData||store.getState().csvData===csv)&&JSON.stringify(store.getState().datasetBundle?.source.inspection)===JSON.stringify(previous.datasetBundle?.source.inspection))
                            store.setState({...acceptedPublicationSnapshot(previous),activeDataQuery:null});
                        return {status:'not_committed' as const,admitted,replay:false,reason:reason(error)};
                    }catch{
                        if(canCommitRun(store,lease))store.setState({datasetCommitBindingStatus:'commit_unknown',activeDataQuery:null});
                        return {status:'unknown' as const,admitted,replay:false,reason:'commit_compensation_failed'};
                    }
                }
            });
        }catch(error){
            binding?.rollback();
            if(!durable&&created)await created.remove().catch(()=>{});
            if(!durable&&canCommitRun(store,lease)&&store.getState().datasetCommitBindingStatus==='commit_unknown')store.setState({datasetCommitBindingStatus:previous.datasetCommitBindingStatus});
            return {status:durable?'unknown':'not_committed',admitted,replay:false,reason:reason(error),...(durable?{marker}: {})};
        }
    };

    const dualAttempts = new WeakSet<Prepared>();
    const commitDual = async (approval: CandidateCommitApproval, prepared: Prepared): Promise<CandidateCommitOutcome> => {
        if (dualAttempts.has(prepared)) return { status: 'not_committed', admitted: false, replay: false, reason: 'approval_consumed' };
        dualAttempts.add(prepared);
        const previous = store.getState();
        let binding: Awaited<ReturnType<typeof prepareAcceptedTablesBinding>> | undefined;
        let directory: {remove:()=>Promise<void>} | undefined;
        let durable = false, admitted = false;
        try {
            prepared.check(); const db = await database(); prepared.check();
            if (await readCommitIntent(db, lease!.scope.sessionId, prepared.review.idempotencyKey)) throw new Error('approval_consumed');
            prepared.check();
            let files:File[]|undefined;
            if(prepared.streamed){const written=await writeAcceptedStreamedDual(prepared.marker,prepared.streamed.custody,store,prepared.check,options.acceptedStorage);directory=written;files=written.files;}
            else directory = await writeAcceptedDual(prepared.marker, prepared.recovery!, prepared.check, options.acceptedStorage); prepared.check();
            binding = await (options.prepareTablesBinding ?? prepareAcceptedTablesBinding)(prepared.marker, prepared.candidate, prepared.check, lease!.signal,files); prepared.check();
            const marker = immutable({ ...prepared.marker, approvalKey: commitApprovalKey(lease!.scope.sessionId, approval.approvalId),
                approval: { ...approval, consumedAt: Date.now() } });
            return await queueSessionWrite(async () => {
                prepared.check();
                const baseline = buildPersistedReportRecord(previous, { id: lease!.scope.sessionId, filename: prepared.csv.fileName });
                const saved = await db.get('reports', marker.sessionId), head = await db.get(DATASET_COMMITS_STORE, commitHeadKey(marker.sessionId)); prepared.check();
                try {
                    await commitDatasetTransaction(db, marker, baseline, prepared.check, () => { admitted = true;
                        store.setState({ datasetCommitBindingStatus: 'commit_unknown', activeDataQuery: null }); options.onAdmitted?.(); });
                    durable = true;
                } catch (e) {
                    if (admitted) {
                        try { durable = (await readCommitIntent(db, marker.sessionId, marker.idempotencyKey))?.payloadDigest === marker.payloadDigest; }
                        catch { throw new Error('commit_outcome_unknown'); }
                    }
                    if (!durable) throw e;
                }
                try {
                    prepared.check();
                    const latest = await db.get(DATASET_COMMITS_STORE, commitHeadKey(marker.sessionId)); prepared.check();
                    if (latest?.kind !== 'head' || latest.commitId !== marker.commitId) throw new Error('commit_activation_superseded');
                    binding!.activate(prepared.csv, acceptedQueryOwner(store, marker, prepared.csv));
                    store.setState({ datasetBundle: structuredClone(marker.bundle), csvData: prepared.csv, canonicalCsvData: prepared.csv, rawCsvData: null,
                        candidateRecovery: null, datasetCommitBindingStatus: 'ready', activeDataQuery: null, datasetSemanticSnapshot: null,
                        semanticDatasetVersion: null, semanticStatus: 'idle', columnRegistry: null, columnProfiles: [], canonicalBuildMeta: null,
                        activeMetricMappingValidation: null, activeSpreadsheetFilter: null, spreadsheetFilterFunction: null,
                        vectorStoreDocuments: [], pendingVectorMemoryDocs: [], vectorMemoryState: 'cold', reportMemoryScope: null,
                        duckDbSessionStatus: { ...binding!.binding, status: 'ready', fallbackReason: null, lastSyncedAt: new Date() } });
                    if(!prepared.streamed){registerSandboxTableRows(marker.bundle.bundleId, prepared.output, marker.bundle.datasetVersion);
                    rememberRecoveryMaterial(store, marker.commitId, prepared.recovery!);}
                    registerSessionResource(lease!.scope, () => clearSandboxTableRows(marker.bundle.bundleId));
                    binding!.finish();
                    const installedBinding = binding!;
                    registerSessionResource(lease!.scope, () => installedBinding.dispose());
                    return { status: 'committed' as const, admitted, replay: false, marker, acknowledgement: 'installed' as const };
                } catch (e) {
                    binding!.rollback();
                    if (!canCommitRun(store, lease)) return { status: 'committed' as const, admitted, replay: false, marker, acknowledgement: 'revoked' as const };
                    // Do not leave the restored owner paired with the failed publication across an await.
                    if (store.getState().csvData === previous.csvData || store.getState().csvData === prepared.csv)
                        store.setState({ ...acceptedPublicationSnapshot(previous), datasetCommitBindingStatus: 'commit_unknown', activeDataQuery: null });
                    await compensateSpillCommit(db, marker, saved ?? baseline, head?.kind === 'head' ? head : undefined);
                    durable = false;
                    if (store.getState().csvData === previous.csvData || store.getState().csvData === prepared.csv)
                        store.setState({ ...acceptedPublicationSnapshot(previous), activeDataQuery: null });
                    throw e;
                }
            });
        } catch (e) {
            binding?.rollback();
            // An unreadable acknowledgement is not proof of abort. Preserve backing for journal recovery.
            if (!durable && reason(e) !== 'commit_outcome_unknown') await directory?.remove().catch(() => {});
            if (canCommitRun(store, lease) && (store.getState().csvData === previous.csvData || store.getState().csvData === prepared.csv)) store.setState(durable || reason(e) === 'commit_outcome_unknown'
                ? { datasetCommitBindingStatus: 'commit_unknown', activeDataQuery: null }
                : { ...acceptedPublicationSnapshot(previous), activeDataQuery: null });
            return { status: durable || reason(e) === 'commit_outcome_unknown' ? 'unknown' : 'not_committed', admitted, replay: false, reason: reason(e) };
        }
    };
    const commit = async (approval: CandidateCommitApproval): Promise<CandidateCommitOutcome> => {
        const prepared=approvals.get(approval);
        if (!prepared||approval.reviewDigest!==prepared.review.reviewDigest) return {status:'not_committed',admitted:false,replay:false,reason:'approval_invalid'};
        if (prepared.marker.acceptedDualGrain||prepared.marker.acceptedStreamedDual) return commitDual(approval, prepared);
        if(prepared.spill)return commitSpill(approval,prepared);
        let commitDb: StorageDatabase | undefined;
        const ordinaryPrevious = store.getState();
        let ordinaryBinding: Awaited<ReturnType<typeof prepareOrdinaryDatasetBinding>> | undefined;
        let compensation: { report: Parameters<typeof compensateSpillCommit>[2]; head: Parameters<typeof compensateSpillCommit>[3] } | undefined;
        if (prepared.marker.previousCommit && ordinaryPrevious.datasetBundle?.acceptedCommit?.commitId === prepared.marker.previousCommit.commitId) {
            // Replacing accepted data must not admit a new journal generation before its worker is ready.
            const signature = JSON.stringify(ordinaryPrevious.datasetBundle);
            const current = () => { own(); if (store.getState().csvData !== ordinaryPrevious.csvData || JSON.stringify(store.getState().datasetBundle) !== signature) throw new Error('input_version_changed'); };
            try { ordinaryBinding = await prepareOrdinaryDatasetBinding(prepared.csv, current, lease.signal, options.bind); }
            catch (error) { return { status: unresolved.has(approval) ? 'unknown' : 'not_committed', admitted: false, replay: false, reason: reason(error) }; }
        }
        const durable = await queueSessionWrite(async(): Promise<CandidateCommitOutcome>=>{
            let admitted=false,db:StorageDatabase;
            try { own();db=await database();commitDb=db;own(); } catch(error) {return {status:unresolved.has(approval)?'unknown':'not_committed',admitted:false,replay:false,reason:reason(error)};}
            let stored:DatasetCommitMarker|undefined,replay=false;
            try {
                // Same exact intent is a read-only reconciliation, even after its input version advanced.
                stored=await readCommitIntent(db,lease.scope.sessionId,prepared.review.idempotencyKey);own();
                if (stored && stored.payloadDigest!==prepared.review.payloadDigest) throw new Error('idempotency_conflict');
                if (stored) replay=true;
                else {
                    // A successful absent-marker read resolves an earlier uncertain abort.
                    if (unresolved.delete(approval) && store.getState().datasetCommitBindingStatus==='commit_unknown') {
                        store.setState({datasetCommitBindingStatus:prepared.bindingStatus});
                    }
                    if (ordinaryBinding) {
                        const baseline = buildPersistedReportRecord(ordinaryPrevious, { id: lease.scope.sessionId, filename: prepared.csv.fileName });
                        const saved = await db.get('reports', lease.scope.sessionId), head = await db.get(DATASET_COMMITS_STORE, commitHeadKey(lease.scope.sessionId)); own();
                        if (head && head.kind !== 'head') throw new Error('commit_marker_invalid');
                        compensation = { report: saved ?? baseline, head: head?.kind === 'head' ? head : undefined };
                    }
                    const marker=immutable({...prepared.marker,...(store.piTask?{taskBudget:structuredClone(store.piTask.snapshot.budget)}:{}),approvalKey:commitApprovalKey(lease.scope.sessionId,approval.approvalId),
                        approval:{...approval,consumedAt:Date.now()},audit:{...prepared.marker.audit,runId:lease!.runId,turnId:lease!.turnId,toolCallId:context.toolCallId,stepId:context.stepId,committedAt:new Date().toISOString()}});
                    const result=await commitDatasetTransaction(db,marker,buildPersistedReportRecord(store.getState(),{id:lease!.scope.sessionId,filename:prepared.csv.fileName}),prepared.check,()=>{admitted=true;
                        // Fence old facts before the transaction can become durable. Cancellation cannot reopen the old binding.
                        if(canCommitRun(store,lease))store.setState({datasetCommitBindingStatus:'commit_unknown',activeDataQuery:null,datasetSemanticSnapshot:null});
                        options.onAdmitted?.();});
                    stored=result.marker;replay=result.replay;
                }
            } catch(error) {
                if (!admitted) return {status:unresolved.has(approval)?'unknown':'not_committed',admitted,replay:false,reason:reason(error)};
                try {
                    stored=await readCommitIntent(db,lease.scope.sessionId,prepared.review.idempotencyKey);
                    if (!stored||stored.payloadDigest!==prepared.review.payloadDigest) {unresolved.delete(approval);return {status:'not_committed',admitted,replay:false,reason:reason(error)};}
                    replay=true;
                } catch {unresolved.add(approval);return {status:'unknown',admitted,replay:false,reason:'commit_outcome_unknown'};}
            }
            unresolved.delete(approval);
            return {status:'committed',admitted,replay,marker:stored};
        });
        // The persistence barrier waits for durable truth, never for a worker/network rebind.
        if (durable.status==='unknown' && canCommitRun(store,lease)) {
            // Until the marker can be read, neither the old nor proposed version is verified truth.
            store.setState({datasetCommitBindingStatus:'commit_unknown',activeDataQuery:null,datasetSemanticSnapshot:null});
        }
        if(durable.status==='not_committed'&&canCommitRun(store,lease)&&store.getState().datasetCommitBindingStatus==='commit_unknown'
            &&JSON.stringify(datasetCommitBindings(store.getState().datasetBundle))===JSON.stringify(prepared.candidate.inputBindings)) {
            store.setState({datasetCommitBindingStatus:prepared.bindingStatus});
        }
        if (durable.status!=='committed'||!durable.marker||!commitDb) { ordinaryBinding?.rollback(); return durable; }
        try {
            const acknowledgement = await install(durable.marker, prepared, commitDb, ordinaryBinding);
            if (ordinaryBinding && acknowledgement !== 'installed') ordinaryBinding.rollback();
            if (ordinaryBinding && acknowledgement === 'binding_failed') {
                store.setState({ datasetCommitBindingStatus: 'commit_unknown', activeDataQuery: null });
                if (!compensation) return { ...durable, status: 'unknown', reason: 'commit_outcome_unknown' };
                try {
                    await compensateSpillCommit(commitDb, durable.marker, compensation.report, compensation.head);
                    if (canCommitRun(store, lease) && store.getState().csvData === ordinaryPrevious.csvData)
                        store.setState({ ...acceptedPublicationSnapshot(ordinaryPrevious), activeDataQuery: null });
                    return { status: 'not_committed', admitted: durable.admitted, replay: false, reason: 'committed_dataset_not_bound' };
                } catch { return { ...durable, status: 'unknown', reason: 'commit_compensation_failed' }; }
            }
            return { ...durable, acknowledgement };
        }
        catch {
            ordinaryBinding?.rollback();
            if (!canCommitRun(store,lease)) return {...durable,acknowledgement:'revoked'};
            store.setState({datasetCommitBindingStatus:'binding_failed',activeDataQuery:null,datasetSemanticSnapshot:null});
            return {...durable,acknowledgement:'binding_failed'};
        }
    };
    const suspend = (reviewed: CandidateCommitReview) => {
        const prepared = reviews.get(reviewed);
        if (!prepared || suspended || resumed || !execution.captureCommitCheck) throw new Error('approval_invalid');
        prepared.check();
        const candidateCheck = port.captureCommitCheck(reviewed.candidateId);
        const grantCheck = execution.captureCommitCheck(prepared.candidate.execution.jobId, context, options.policy,(prepared.streamed??prepared.spill)?.custody.authority);
        detachedCheck = (target, fresh) => { candidateCheck(target, fresh); grantCheck(target, fresh); };
        const capsule = Object.freeze({reviewId: reviewed.reviewId, reviewDigest: reviewed.reviewDigest});
        const draft=prepared.streamed??prepared.spill;
        if(draft)detachCandidateDraft(store,reviewed.reviewId,reviewed.reviewDigest,reviewed.expiresAt,draft.custody);
        capsules.set(capsule, prepared); approvals = new WeakMap(); suspended = true;
        return capsule;
    };
    const resume = (capsule: object, target: StoreApi) => {
        const prepared = capsules.get(capsule), fresh = target.executionContext;
        if (!prepared || !suspended || resumed || !fresh || !originalLease?.closed || fresh.lease === originalLease
            || rootStore(target).getState !== originalRoot.getState || fresh.lease.scope.sessionId !== originalLease.scope.sessionId
            || fresh.lease.scope.epoch !== originalLease.scope.epoch) throw new Error('approval_invalid');
        assertRunActive(target, fresh.lease);
        store = target; lease = fresh.lease; context = {...context, lease}; suspended = false; resumed = true;
        prepared.check();
    };
    const recoveryCheckpoint = async (reviewed:CandidateCommitReview):Promise<CandidateRecoveryCheckpoint> => {
        const prepared=reviews.get(reviewed); if (!prepared || !store.piTask) throw new Error('approval_invalid'); prepared.check();
        const snapshot=store.piTask.recoverySnapshot();
        const body={version:1 as const,checkpointId:`candidate-recovery-${crypto.randomUUID()}`,proposal:structuredClone(prepared.marker),
            task:{...snapshot.task,status:'awaiting_approval' as const,capabilityGrants:[],budget:pauseTaskBudget(snapshot.task.budget)},
            failureKey:snapshot.failureKey,repetitions:snapshot.repetitions};
        const result=immutable({...body,digest:await codeDigest(body)}); prepared.check(); return result;
    };
    return Object.freeze({review,approve,commit,suspend,resume,recoveryCheckpoint});
};
