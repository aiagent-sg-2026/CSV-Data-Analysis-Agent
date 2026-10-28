import type { StoreApi } from '../types';
import { beginRun, scopeRunStore } from '../../session/sessionOwnership';
import { createAgentTask, transitionAgentTask, type AgentTaskDefinition } from '../runtime/pi/piTaskContract';
import { createTaskWorkspace } from '../taskWorkspace';
import { createCodeExecutionAdapter } from './codeExecutionAdapter';
import type { CodeRunRequest } from './codeExecutionContract';
import type { CandidateSpillFactory } from '../../data/candidateSpill';
import { CsvStreamScanner, type CsvRecordSpan } from '../../data/csvStreamScanner';
import { registerScannedCsvBlob } from '../../data/immutableCsvSource';
import { handleExecutorAction } from './executorAgent';

/** Synthetic deterministic orchestration only; not a provider or business-semantics qualification. */
export const qualifySourceStream = async (rows: number, guest?: Parameters<typeof createCodeExecutionAdapter>[3], factory?: CandidateSpillFactory, suppliedFile?: File) => {
    const file = suppliedFile ?? new File(['key,payload,value\r\n' + Array.from({ length: rows }, (_, i) =>
        `${i},"${'x'.repeat(1000)}${i === rows - 1 ? 'α\r\n末尾' : ''}",${i % 2 ? '-1' : '0'}${i === rows - 1 ? ',,' : ''}\r\n`).join('')], 'synthetic-stream.csv');
    const reads = { count: 0, bytes: 0, maxBytes: 0, fullReads: 0 };
    const guard = (blob: Blob, original: boolean): Blob => {
        const slice = blob.slice.bind(blob), arrayBuffer = blob.arrayBuffer.bind(blob);
        Object.defineProperty(blob, 'slice', { value: (start?: number, end?: number) => guard(slice(start, end), false) });
        Object.defineProperty(blob, 'arrayBuffer', { value: async () => {
            if (original || blob.size > 65536) { reads.fullReads++; throw new Error('qualification_unbounded_blob_read'); }
            reads.count++; reads.bytes += blob.size; reads.maxBytes = Math.max(reads.maxBytes, blob.size);
            return arrayBuffer();
        } });
        return blob;
    };
    guard(file, true);
    let state = { sessionId: crypto.randomUUID(), settings: { runtimeAccessControl: { permissionMode: 'open', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } },
        analysisCards: [], columnProfiles: [], csvData: { data: [] }, datasetBundle: { source: {}, relationshipSetId: 'rel', tables: [{ tableId: 't', datasetVersion: 'v1' }] } } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    const lease = beginRun(root, 'follow_up', 'synthetic-stream', 'turn');
    const store = scopeRunStore(root, lease);
    const checkpoints: CsvRecordSpan[] = []; let lastByte = -512 * 1024;
    const scan = await new CsvStreamScanner(file, { delimiter: ',', onRecord: span => {
        if (span.row % 1024 === 0 || span.start - lastByte >= 512 * 1024) { checkpoints.push(span); lastByte = span.start; }
    } }).run();
    if (scan.parsingCoverage !== 'complete' || !scan.sha256) throw new Error('qualification_scan_failed');
    const source = { sourceId: crypto.randomUUID(), sha256: scan.sha256, byteSize: file.size, fileName: file.name,
        recordCount: scan.rows, dialect: { delimiter: ',', quoteChar: '"' }, diagnostics: [] };
    root.setState({ datasetBundle: { ...state.datasetBundle!, source: { ...state.datasetBundle!.source, inspection: source } } });
    registerScannedCsvBlob(store, file, source, checkpoints);
    const hash = 'a'.repeat(64);
    const definition: AgentTaskDefinition = { goal: 'Synthetic lossless rectangularization', kind: 'artifact', requiredOutputs: [{ id: 'out', kind: 'artifact', required: true }],
        inputBindings: [{ tableId: 't', datasetVersion: 'v1', relationshipSetId: 'rel' }], protectedInvariants: [], capabilityGrants: [],
        scope: { digest: hash, intentDigest: hash, answer: { requiresEvidence: false, queries: [], unresolved: [], complete: true } } };
    let task = transitionAgentTask(store, createAgentTask(store, lease, definition), lease, 'inspecting');
    const workspace = createTaskWorkspace(store, task.taskId, { allowedPrefixes: ['/workspace/'] });
    const program = await workspace.write('/workspace/repair.js', 'return {state:{count:(input.stream.state.count||0)+input.records.length},rows:input.records.map(r=>({sourceRow:r.sourceRow,cells:r.cells.slice(0,3)}))};', 0);
    const adapter = createCodeExecutionAdapter(store, workspace, () => task, guest, factory);
    const grant = await adapter.issueGrant({ readPaths: [program.path], writePaths: ['/workspace/spill.json'], sources: [{ sourceId: source.sourceId, sha256: source.sha256 }],
        expiresAt: Date.now() + 900000, limits: { inputBytes: 256 * 1024, outputBytes: 256 * 1024, heapBytes: 32 * 1024 * 1024 } });
    task = { ...task, capabilityGrants: [grant] };
    const context = { lease, toolCallId: 'synthetic-call', stepId: 'synthetic-step' }; store.executionContext = context; store.codeExecution = adapter;
    const request: CodeRunRequest = { program: { path: program.path, revision: program.revision, sha256: program.sha256 }, inputs: [],
        mode: 'source_records', sourceRecords: { sourceId: source.sourceId, sha256: source.sha256, width: 3, initialState: {} },
        output: { path: '/workspace/spill.json', expectedRevision: 0, format: 'json' } };
    const dispatch = () => handleExecutorAction({ type: 'tool_call', toolName: 'code.run', args: request }, store);
    return { root, store, source, scan, reads, adapter, workspace, context, request, dispatch, getTask: () => task,
        setTask: (value: typeof task) => { task = value; } };
};
