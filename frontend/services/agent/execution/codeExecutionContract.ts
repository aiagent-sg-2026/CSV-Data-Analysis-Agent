import type { StoreApi } from '../types';
import type { DatasetScopeBinding, ToolName, ToolStage } from '../../../types';
import type { ExecutionContext } from '../../session/sessionOwnership';
import type { GuestLimits } from '../../sandbox/javascriptGuestProtocol';
import type { TaskWorkspace } from '../taskWorkspace';

export interface CodeArtifactRef { path: string; revision: number; sha256: string }
export interface CodeTableRef { name: string; tableId: string }
export interface CodeStreamOptions {
    table: string; batchRows: number; partitionBy: string[]; initialState: unknown;
}
export interface CodeInputCoverage extends CodeTableRef, DatasetScopeBinding {
    rowCount: number; deliveredRows: number; sha256: string; complete: boolean;
}
export interface CodeStreamCheckpoint {
    sequence: number; partitionIndex: number; phase: 'batch' | 'finish'; nextRow: number;
    stateDigest: string; stateBytes: number; outputRows: number; digest: string;
}
export interface CodeRunRequest {
    program: CodeArtifactRef;
    inputs: Array<CodeArtifactRef & { name: string }>;
    sources?: Array<{ name: string; sourceId: string; sha256: string; offset: number; length: number }>;
    tables?: CodeTableRef[];
    mode?: 'whole_table' | 'stateful_stream' | 'row_map' | 'source_records';
    stream?: CodeStreamOptions;
    /** Opt-in structural-only spill. No candidate/commit authority is implied. */
    sourceRecords?: import('./codeSourceRecordStream').SourceStreamOptions;
    output: { path: string; expectedRevision: number; format: 'json' | 'text' };
}
export interface CodeExecutionReceipt {
    jobId: string; taskId: string; taskRevision: number; sessionId: string; sessionEpoch: number;
    runId: string; turnId?: string; toolCallId?: string; stepId?: string;
    executorGeneration: string; workerGeneration?: number;
    status: 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
    reasonCode: string; retry: 'repair' | 'wait' | 'new_scope' | 'none';
    cancelRequested?: boolean;
    program?: CodeArtifactRef; environmentDigest?: string; inputDigest?: string; requestDigest?: string;
    environment?: Record<string, unknown>;
    inputs?: CodeRunRequest['inputs']; sources?: CodeRunRequest['sources']; outputContract?: CodeRunRequest['output'];
    /** Host-captured invocation metadata; restoring it never restores its grant. */
    runRequest?: CodeRunRequest;
    limits?: GuestLimits; mode?: 'artifact_json' | 'whole_table' | 'stateful_stream' | 'row_map' | 'source_records';
    sourceStream?: { manifest: import('../../data/candidateSpill').SpillManifest; metrics: import('./codeSourceRecordStream').SourceStreamMetrics };
    coverage?: CodeInputCoverage[]; checkpoints?: CodeStreamCheckpoint[];
    workerGenerations?: number[];
    output?: CodeArtifactRef & { artifactId: string; byteSize: number };
    inputBindings: DatasetScopeBinding[]; grant?: { id: string; digest: string };
    stdout: string; stderr: string; logsTruncated: boolean;
    error?: { name: string; message: string };
    startedAt: number; finishedAt?: number; durationMs?: number;
}
export interface CodeExecutionPort {
    captureCommitCheck?(jobId: string, context: ExecutionContext, policy?: CodePolicyContext): (target: StoreApi, context: ExecutionContext) => void;
    assertCommitEligible?(jobId: string, context: ExecutionContext, policy?: CodePolicyContext): void;
    workspace: TaskWorkspace;
    run(request: CodeRunRequest, context: ExecutionContext, signal?: AbortSignal, policy?: CodePolicyContext): Promise<Readonly<CodeExecutionReceipt>>;
    inspect(jobId: string | undefined, context: ExecutionContext, policy?: CodePolicyContext): Readonly<CodeExecutionReceipt> | Readonly<CodeExecutionReceipt>[];
    cancel(jobId: string, context: ExecutionContext, policy?: CodePolicyContext): Readonly<CodeExecutionReceipt>;
}
export interface CodePolicyContext { toolStage?: ToolStage; allowOverrides?: ToolName[]; denyOverrides?: ToolName[] }
export interface CodeGrantOptions {
    readPaths: string[]; writePaths: string[]; expiresAt: number;
    sources?: Array<{ sourceId: string; sha256: string }>;
    tableIds?: string[];
    limits?: Partial<GuestLimits>;
}
export const validateCodeRunRequest = (value: unknown): value is CodeRunRequest => {
    const exact = (v: unknown, required: string[], optional: string[] = []) => Boolean(v && typeof v === 'object' && !Array.isArray(v)
        && required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => [...required, ...optional].includes(key)));
    const ref = (v: CodeArtifactRef) => typeof v?.path === 'string' && v.path.length <= 240
        && Number.isSafeInteger(v.revision) && v.revision > 0 && /^[a-f0-9]{64}$/.test(v.sha256);
    const request = value as CodeRunRequest;
    if (!exact(value, ['program', 'inputs', 'output'], ['sources', 'tables', 'mode', 'stream', 'sourceRecords']) || !exact(request.program, ['path', 'revision', 'sha256']) || !ref(request.program)
        || !Array.isArray(request.inputs) || request.inputs.length > 20
        || request.inputs.some(input => !exact(input, ['name', 'path', 'revision', 'sha256']) || !ref(input))
        || !exact(request.output, ['path', 'expectedRevision', 'format']) || typeof request.output.path !== 'string'
        || !Number.isSafeInteger(request.output.expectedRevision) || request.output.expectedRevision < 0
        || !['json', 'text'].includes(request.output.format)) return false;
    if (request.sources !== undefined && (!Array.isArray(request.sources) || request.sources.length > 20 || request.sources.some(source =>
        !exact(source, ['name', 'sourceId', 'sha256', 'offset', 'length']) || typeof source.sourceId !== 'string'
        || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.offset) || source.offset < 0
        || !Number.isSafeInteger(source.length) || source.length < 1 || source.length > 65536))) return false;
    if (request.mode !== undefined && !['whole_table','stateful_stream','row_map','source_records'].includes(request.mode)) return false;
    if (request.tables !== undefined && (!Array.isArray(request.tables) || !request.tables.length || request.tables.length > 20
        || request.tables.some(table => !exact(table, ['name','tableId']) || typeof table.tableId !== 'string' || !table.tableId.length || table.tableId.length > 160)
        || new Set(request.tables.map(table => table.tableId)).size !== request.tables.length)) return false;
    if (request.mode === 'stateful_stream') {
        const stream = request.stream;
        if (!exact(stream, ['table','batchRows','partitionBy','initialState']) || !stream
            || !request.tables?.some(table => table.name === stream.table)
            || !Number.isSafeInteger(stream.batchRows) || stream.batchRows < 1 || stream.batchRows > 5000
            || !Array.isArray(stream.partitionBy) || stream.partitionBy.length > 8
            || stream.partitionBy.some(column => typeof column !== 'string' || !column.length || column.length > 240)
            || new Set(stream.partitionBy).size !== stream.partitionBy.length) return false;
        try { if (JSON.stringify(stream.initialState) === undefined) return false; } catch { return false; }
    } else if (request.stream !== undefined) return false;
    if (request.mode === 'source_records') {
        const source = request.sourceRecords;
        if (!source || !exact(source, ['sourceId','sha256','width','initialState']) || typeof source.sourceId !== 'string'
            || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.width) || source.width < 1 || source.width > 256
            || request.sources?.length || request.tables?.length || request.inputs.length || request.output.format !== 'json') return false;
        try { if (JSON.stringify(source.initialState) === undefined) return false; } catch { return false; }
    } else if (request.sourceRecords !== undefined) return false;
    const names = [...request.inputs, ...(request.sources ?? []), ...(request.tables ?? [])].map(input => input.name);
    return names.every(name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
        && !['__proto__', 'constructor', 'prototype', 'stream'].includes(name)) && new Set(names).size === names.length;
};
