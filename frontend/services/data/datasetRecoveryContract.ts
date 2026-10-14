import type { CsvRow, DatasetBundle } from '../../types';
import type { CsvSourceMetadata } from '../../types/intake';
import type { DatasetCommitReference } from '../../types/datasetCommit';
import type { CodeRunRequest, CodeInputCoverage } from '../agent/execution/codeExecutionContract';
import type { HostCandidateValidationContract } from './candidateValidationBinding';
import type { ValidationInputs } from './candidateValidation';
import type { AgentTaskContract } from '../agent/runtime/pi/piTaskContract';
import type { DatasetCommitMarker } from '../../types/datasetCommit';

/** Durable descriptions are inspection data, never executable authority or answer evidence. */
export interface DatasetReplayManifest {
    version: 1;
    effectSafety: 'isolated_local_compute_only';
    request: CodeRunRequest;
    inputBundle: DatasetBundle;
    parent: DatasetCommitReference | null;
    source: CsvSourceMetadata | null;
    roots: Record<string, { kind: 'csv_header'; dynamicTyping: boolean } | null>;
    coverage: CodeInputCoverage[];
    validationBinding: HostCandidateValidationContract;
    digest: string;
}
export interface DatasetRecoveryMaterial {
    version: 1;
    outputText: string;
    tables: Record<string, { rows: CsvRow[]; columns: string[] }>;
    validationInputs: ValidationInputs;
    dependencies: Record<string, string>;
    sourceBytes: number[] | null;
}
export interface DatasetRetainedArtifact {
    recordId: string;
    sessionId: string;
    commitId: string;
    manifestDigest: string;
    sha256: string;
    byteSize: number;
    chunks: number;
    createdAt: number;
    expiresAt: number;
    status: 'writing' | 'ready' | 'deleting' | 'deleted';
}
export interface CandidateRecoveryCheckpoint {
    version: 1; checkpointId: string; digest: string;
    proposal: DatasetCommitMarker;
    task: AgentTaskContract;
    failureKey: string; repetitions: number;
}
export const DATASET_RETENTION_STORE = 'dataset_retention' as const;
export const RETENTION_POLICY = Object.freeze({ artifactBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024,
    lifetimeMs: 7 * 24 * 60 * 60 * 1000, chunkBytes: 256 * 1024 });
