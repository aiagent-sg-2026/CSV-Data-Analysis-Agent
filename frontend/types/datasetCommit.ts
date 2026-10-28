import type { DatasetBundle, DatasetScopeBinding, TransformationProgram } from './datasetBundle';
import type { CandidateValidationReceipt } from '../services/data/candidateStaging';
import type { CodeArtifactRef } from '../services/agent/execution/codeExecutionContract';
import type { DatasetReplayManifest } from '../services/data/datasetRecoveryContract';

/** Persisted references describe durable truth; they never restore a live approval or lease. */
export interface DatasetCommitReference { sessionId: string; commitId: string; revision: number }
export type DatasetCommitBindingStatus = 'rebinding' | 'ready' | 'binding_failed' | 'awaiting_source' | 'commit_unknown';
export interface DatasetCommitHead {
    kind: 'head'; recordId: string; sessionId: string; commitId: string; revision: number; markerKey: string;
}
export interface DatasetCommitMarker {
    /** Diagnostic lower bound for cumulative recovery accounting; never an execution grant. */
    taskBudget?: import('../services/agent/runtime/pi/piTaskBudget').TaskBudget;
    kind: 'commit'; recordId: string; intentKey: string; approvalKey: string;
    sessionId: string; commitId: string; revision: number; parentCommitId: string | null;
    idempotencyKey: string; payloadDigest: string; candidateId: string; changeDigest: string;
    inputBindings: DatasetScopeBinding[]; outputBindings: DatasetScopeBinding[];
    bundle: DatasetBundle; transformation: TransformationProgram;
    program: CodeArtifactRef & { content: string }; environment: Record<string, unknown>;
    inputArtifacts: CodeArtifactRef[]; outputArtifacts: CodeArtifactRef[];
    validation: Readonly<CandidateValidationReceipt>;
    lineage: { tables: Array<{ name: string; cells: unknown[] }>; excludedRows: unknown[] };
    approval: { approvalId: string; reviewDigest: string; approvedAt: number; expiresAt: number; consumedAt: number };
    audit: { sessionEpoch: number; taskId: string; taskRevision: number; runId: string; turnId?: string; toolCallId: string; stepId: string; grantDigest: string; committedAt: string };
    rowStorage: 'transient' | 'durable_spill';
    acceptedSpill?: import('../services/data/acceptedSpill').AcceptedSpillManifest;
    acceptedDualGrain?: import('../services/data/acceptedDualGrain').AcceptedDualGrain;
    spillRunRequest?: import('../services/agent/execution/codeExecutionContract').CodeRunRequest;
    /** Compensated failed publication; consumes approval but is not an accepted head. */
    activationFailed?: true;
    /** Optional for compatible v12 reads. Missing metadata blocks automatic reconstruction. */
    replayManifest?: DatasetReplayManifest;
    rollbackTarget?: DatasetCommitReference;
    previousCommit?: DatasetCommitReference;
}
export type DatasetCommitRecord = DatasetCommitHead | DatasetCommitMarker;
export const DATASET_COMMITS_STORE = 'dataset_commits' as const;
export const commitHeadKey = (sessionId: string): string => JSON.stringify(['head', sessionId]);
export const commitIntentKey = (sessionId: string, key: string): string => JSON.stringify(['intent', sessionId, key]);
export const commitApprovalKey = (sessionId: string, id: string): string => JSON.stringify(['approval', sessionId, id]);
export const validCommitKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key);
