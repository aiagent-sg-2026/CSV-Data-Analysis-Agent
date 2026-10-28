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
import { primeDuckDbDataset, prepareAcceptedSpillBinding } from '../duckdb/queryEngine';
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
        // Only newly inferred dual-grain drafts lack qualified atomic promotion.
        // The staging closure owns this provenance; table count/serialized flags do not.
        const restriction = port.commitRestriction(candidateId);
        if (restriction) throw new Error(restriction);
        if(candidate.spill&&(candidate.tables.length!==1||candidate.execution.inputs?.length||candidate.execution.coverage?.length||candidate.execution.sources?.length))throw new Error('candidate_spill_inputs_unsupported');
        const sourceBundle = store.getState().datasetBundle;
        if (!sourceBundle) throw new Error('complete_input_unavailable');
        const custody = candidate.spill ? port.captureSpillRead(candidateId) : undefined;
        // Review revalidation can have a complete retained original without an accepted preview.
        // This affects only the host commit policy check, never ordinary tool/execution grants.
        spillPolicy=Boolean(custody);
        const capturedPolicy = policy(), expiresAt = Date.now()+300_000;
        const check = () => {
            own();
            if (Date.now() >= expiresAt || policy() !== capturedPolicy) throw new Error('approval_invalid');
            if (resumed) { detachedCheck!(store, context); return; }
            if (port.read(candidateId) !== candidate || port.validationReceipt(candidateId) !== validation) throw new Error('validation_failed');
            execution.assertCommitEligible!(candidate.execution.jobId,context,options.policy,custody?.authority);
        };
        check();
        const primary = candidate.tables.find(t=>t.name===input.primaryTable);
        if (!primary) throw new Error('candidate_primary_table_required');
        const artifact = execution.workspace.read(candidate.execution.program!.path,candidate.execution.program!.revision);
        const environment = candidate.execution.environment;
        if (!environment || await codeDigest(environment) !== validation.environmentDigest
            || await sha256Bytes(new TextEncoder().encode(artifact.content)) !== validation.programDigest) throw new Error('candidate_artifact_mismatch');
        check();
        const spill = custody ? await planAcceptedSpill(custody,store,check) : undefined;check();
        const recovery = spill ? undefined : await captureDatasetReplay(store, candidate, sourceBundle); check();
        const csv: CsvData = spill ? acceptedSpillCsv(spill) : {fileName:sourceBundle.source.fileName,data:primary.rows.map(row=>({...row}))};
        const outputVersion = getCsvDatasetVersion(csv), now = new Date().toISOString();
        const tables = candidate.tables.map((table,index)=>({tableId:table===primary?sourceBundle.primaryTableId:`${candidate.candidateId}-table-${index}`,
            bundleId:sourceBundle.bundleId,name:table.name,role:table.role,schema:structuredClone(table.schema),rowCount:table.rowCount,
            storage:spill?{mode:'accepted_spill' as const,generation:spill.generation,manifestDigest:spill.digest,loadVersion:`accepted-${spill.digest}`,ephemeral:false as const}:{mode:'memory' as const,ephemeral:true},sourceRange:null,datasetVersion:outputVersion}));
        const output: SandboxTransformationOutput = {tables:tables.map((table,index)=>({tableId:table.tableId,name:table.name,role:table.role,
            columns:table.schema.map(c=>c.name),rows:candidate.tables[index].rows.map(row=>({...row}))})),lineage:[],relationships:[]};
        const relationships = candidate.relationships.map(r=>{
            const from=tables.find(t=>t.name===r.fromTable)!,to=tables.find(t=>t.name===r.toTable)!;
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
            recoveryDigest:spill?.digest??recovery!.manifest.digest,...(spill?{spill}: {})};
        check();
        const payloadDigest=await codeDigest(payload);
        const body={...payload,reviewId:`review-${crypto.randomUUID()}`,idempotencyKey:input.idempotencyKey,payloadDigest,expiresAt,
            tables:tables.map(t=>({name:t.name,rowCount:t.rowCount,columns:t.schema.map(c=>c.name)})),rowStorage:spill?'durable_spill' as const:'transient' as const};
        const result=immutable({...body,reviewDigest:await codeDigest(body)});check();
        const marker: DatasetCommitMarker = {kind:'commit',recordId:commitIntentKey(lease.scope.sessionId,input.idempotencyKey),
            intentKey:commitIntentKey(lease.scope.sessionId,input.idempotencyKey),approvalKey:'',sessionId:lease.scope.sessionId,commitId,revision,
            parentCommitId:parent?.sessionId===lease.scope.sessionId?parent.commitId:null,idempotencyKey:input.idempotencyKey,payloadDigest,
            candidateId,changeDigest:candidate.changeDigest,inputBindings:structuredClone(candidate.inputBindings),outputBindings:datasetCommitBindings(bundle),
            bundle,transformation,program:{...candidate.execution.program!,content:artifact.content},environment:structuredClone(environment),
            inputArtifacts:structuredClone(candidate.execution.inputs??[]),outputArtifacts:structuredClone(candidate.outputArtifacts),validation:structuredClone(validation),
            lineage:{tables:candidate.tables.map(t=>({name:t.name,cells:structuredClone(t.lineage)})),excludedRows:structuredClone(candidate.excludedRows)},
            approval:{approvalId:'',reviewDigest:result.reviewDigest,approvedAt:0,expiresAt,consumedAt:0},
            audit:{sessionEpoch:lease.scope.epoch,taskId:candidate.taskId,taskRevision:candidate.taskRevision,runId:lease.runId,turnId:lease.turnId,
                toolCallId:context.toolCallId,stepId:context.stepId,grantDigest:payload.grantDigest,committedAt:now},rowStorage:spill?'durable_spill':'transient',...(spill?{acceptedSpill:spill,spillRunRequest:structuredClone(candidate.execution.runRequest!)}:{replayManifest:recovery!.manifest}),
            previousCommit:sourceBundle.acceptedCommit};
        reviews.set(result,{review:result,candidate,validation,marker,csv,output,check,recovery:recovery?.material,...(spill?{spill:{manifest:spill,custody:custody!}}:{}),bindingStatus:store.getState().datasetCommitBindingStatus});
        return result;
    };

    const approve = (reviewed: CandidateCommitReview): CandidateCommitApproval => {
        const prepared=reviews.get(reviewed);if(!prepared)throw new Error('approval_invalid');prepared.check();
        const approval=immutable({approvalId:`approval-${crypto.randomUUID()}`,reviewDigest:reviewed.reviewDigest,approvedAt:Date.now(),expiresAt:reviewed.expiresAt});
        approvals.set(approval,prepared);return approval;
    };

    const install = async (marker: DatasetCommitMarker, prepared: Prepared, db: StorageDatabase): Promise<CandidateCommitOutcome['acknowledgement']> => {
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
        const stillInstalled=()=>canCommitRun(store,lease)&&store.getState().datasetBundle?.acceptedCommit?.commitId===marker.commitId;
        store.setState({datasetBundle:structuredClone(marker.bundle),csvData:structuredClone(prepared.csv),canonicalCsvData:structuredClone(prepared.csv),candidateRecovery:null,
            datasetCommitBindingStatus:'rebinding',activeDataQuery:null,datasetSemanticSnapshot:null,semanticDatasetVersion:null,semanticStatus:'idle',
            columnRegistry:null,columnProfiles:[],canonicalBuildMeta:null,activeMetricMappingValidation:null,activeSpreadsheetFilter:null,spreadsheetFilterFunction:null,
            vectorStoreDocuments:[],pendingVectorMemoryDocs:[],vectorMemoryState:'cold',reportMemoryScope:null,
            duckDbSessionStatus:{status:'binding',engine:null,tableName:null,loadVersion:null,fallbackReason:null,lastSyncedAt:null}});
        registerSandboxTableRows(marker.bundle.bundleId,prepared.output,marker.bundle.datasetVersion);
        rememberRecoveryMaterial(store, marker.commitId, prepared.recovery!);
        registerSessionResource(lease.scope,()=>clearSandboxTableRows(marker.bundle.bundleId));
        try {
            const binding=await (options.bind??primeDuckDbDataset)(prepared.csv,lease.signal);
            if (!stillInstalled()) return 'revoked';
            const latest=await db.get(DATASET_COMMITS_STORE,commitHeadKey(marker.sessionId));
            if (!stillInstalled()) return 'revoked';
            if (latest?.kind!=='head'||latest.commitId!==marker.commitId) {
                store.setState({datasetCommitBindingStatus:'binding_failed'});return 'superseded';
            }
            if (binding.engine!=='duckdb'||!binding.tableName||!binding.loadVersion) throw new Error('committed_dataset_not_bound');
            store.setState({datasetCommitBindingStatus:'ready',duckDbSessionStatus:{...binding,status:'ready',fallbackReason:null,lastSyncedAt:new Date()}});
            return 'installed';
        } catch {
            if (!stillInstalled()) return 'revoked';
            store.setState({datasetCommitBindingStatus:'binding_failed',duckDbSessionStatus:{status:'error',engine:null,tableName:null,loadVersion:null,
                fallbackReason:'committed_dataset_not_bound',lastSyncedAt:null}});
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
                    binding!.activate();
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
                        await compensateSpillCommit(db,accepted,saved??baseline,head?.kind==='head'?head:undefined);
                        if(canCommitRun(store,lease)&&JSON.stringify(store.getState().datasetBundle?.source.inspection)===JSON.stringify(previous.datasetBundle?.source.inspection))
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

    const commit = async (approval: CandidateCommitApproval): Promise<CandidateCommitOutcome> => {
        const prepared=approvals.get(approval);
        if (!prepared||approval.reviewDigest!==prepared.review.reviewDigest) return {status:'not_committed',admitted:false,replay:false,reason:'approval_invalid'};
        if(prepared.spill)return commitSpill(approval,prepared);
        let commitDb: StorageDatabase | undefined;
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
        if (durable.status!=='committed'||!durable.marker||!commitDb) return durable;
        try {return {...durable,acknowledgement:await install(durable.marker,prepared,commitDb)};}
        catch {
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
        const grantCheck = execution.captureCommitCheck(prepared.candidate.execution.jobId, context, options.policy,prepared.spill?.custody.authority);
        detachedCheck = (target, fresh) => { candidateCheck(target, fresh); grantCheck(target, fresh); };
        const capsule = Object.freeze({reviewId: reviewed.reviewId, reviewDigest: reviewed.reviewDigest});
        if(prepared.spill)detachCandidateDraft(store,reviewed.reviewId,reviewed.reviewDigest,reviewed.expiresAt,prepared.spill.custody);
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
