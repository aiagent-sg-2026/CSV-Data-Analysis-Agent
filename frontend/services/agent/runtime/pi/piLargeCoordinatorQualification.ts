import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { StoreApi } from '../../types';
import { createSingleTableDatasetBundle } from '../../../data/datasetBundle';
import { scanCsvSourceForImport, bindCsvSourceScan, scannedCsvSourceMetadata } from '../../../data/csvSourceScan';
import { runPiInitialAnalysis, type PiInitialAnalysisOptions } from './piInitialAnalysisRuntimeService';
import type { SpillMeaningProposal } from '../../../data/spillMeaningProposal';

/** Deterministic provider only: normal initial runtime, public tools and real host custody.
 * No bindSpill test helper, direct stage/validate or approval shortcut is used here. */
export const preparePiLargeCoordinatorSmoke = async (root: StoreApi, file: File, options: {
    columns?: string[]; numeric?: boolean; summary?: boolean; mode?: 'repair' | 'retry' | 'exhaust';
    coding?: PiInitialAnalysisOptions['codingPreparation']; proposal?: (p: SpillMeaningProposal) => unknown;
    confirmedProposal?: (p: SpillMeaningProposal) => unknown; goal?: string; beforeProvider?: (turn: number) => Promise<void>;
} = {}) => {
    const columns = options.columns ?? ['key', 'payload', 'value'], data = { fileName: file.name, data: [] }, datasetId = crypto.randomUUID();
    const goal = options.goal ?? 'Repair the complete original source using bounded record tools, independently validate a single source-record table and request separate exact human approval.';
    root.setState({ sessionId: crypto.randomUUID(), sessionCreatedAt: new Date(), confirmedAnalysisGoal: goal, currentView: 'analysis_dashboard',
        csvData: data, rawCsvData: structuredClone(data), canonicalCsvData: null, rawIntakeIr: null,
        datasetBundle: createSingleTableDatasetBundle({ datasetId, sourceFingerprint: 'pending', file, data }), currentDatasetId: datasetId,
        pipelineOutcome: { canAutoAnalyze: false, reasonCode: 'header_shape_drift' } as never,
        pendingClarification: null, candidateRecovery: null, analysisCards: [], columnProfiles: [], queryHistory: [], workspaceFiles: {}, datasetCommitBindingStatus: undefined,
        settings: { ...root.getState().settings, provider: 'default', simpleModel: 'mock', complexModel: 'mock', language: 'English',
            runtimeAccessControl: { permissionMode: 'open', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } } });
    const reads = { bytes: 0, calls: 0, maxBytes: 0, fullReads: 0 };
    const guard = (blob: Blob, full: boolean): Blob => {
        const slice = blob.slice.bind(blob), arrayBuffer = blob.arrayBuffer.bind(blob);
        Object.defineProperty(blob, 'slice', { value: (start?: number, end?: number) => guard(slice(start, end), false) });
        Object.defineProperty(blob, 'arrayBuffer', { value: async () => {
            if (full || blob.size > 65536) { reads.fullReads++; throw new Error('qualification_unbounded_source_read'); }
            reads.calls++; reads.bytes += blob.size; reads.maxBytes = Math.max(reads.maxBytes, blob.size); return arrayBuffer();
        } }); return blob;
    };
    guard(file, true);
    const scan = await scanCsvSourceForImport(root, file);
    if (scan.parsingCoverage !== 'complete' || !scan.sha256) throw new Error('qualification_scan_incomplete');
    const source = scannedCsvSourceMetadata(root, file);
    const bundle = root.getState().datasetBundle!;
    root.setState({ datasetBundle: { ...bundle, source: { ...bundle.source, inspection: source } } });
    bindCsvSourceScan(root, file, source);
    const proposal: SpillMeaningProposal = { input: { kind: 'source', name: 'original' }, stream: { sourceId: source.sourceId, sha256: source.sha256, dialect: source.dialect,
        meaning: { version: 1, kind: 'ordered-source-records', table: 'records', grain: 'source_record', headerRow: 0, summary: options.summary ? 'last_record_sum' : 'none',
            columns: columns.map((name, sourceColumn) => ({ name, sourceColumn, conversion: options.numeric && sourceColumn === columns.length - 1 ? 'decimal' : 'identity',
                ...(options.numeric && sourceColumn === columns.length - 1 ? { scale: 0, unit: 'count' } : {}) })) } }, assumptions: ['Ordered physical source records; no natural-key uniqueness or general business grain asserted.'] };
    const program = `return {state:{},rows:input.records.map(r=>({sourceRow:r.sourceRow,cells:r.cells.slice(0,${columns.length})}))};`;
    let step = 0, attempt = 0, candidateId = '';
    const trace: string[] = [];
    const call = (name: string, args: unknown): AssistantMessage['content'] => [{ type: 'toolCall', id: crypto.randomUUID(), name, arguments: args as JsonObject }];
    let providerCalls = 0;
    const stream: StreamFn = async (model, context) => {
        await options.beforeProvider?.(++providerCalls);
        const last = context.messages.filter(m => m.role === 'toolResult').at(-1), text = last?.content.filter(p => p.type === 'text').map(p => p.text).join('') ?? '';
        if (last) trace.push(`${last.toolName}: ${text}`);
        let value: { payload?: { workspace?: { artifact?: { path: string; revision: number; sha256: string } }; candidate?: { candidateId: string } }; receipt?: { jobId: string; status: string } } = {};
        try { value = JSON.parse(text); } catch { /* Host failures stay failures. */ }
        // A resumed semantic run must submit the newly selected proposal, not treat choice as commit.
        if (!last && root.getState().workspaceFiles['/intake/meaning-confirmation.json']) step = 2;
        let content: AssistantMessage['content'];
        if (step === 0) { step++; content = call('workspace_read', { path: '/intake/source-scan.json' }); }
        else if (step === 1) { step++; content = call('workspace_read', { path: '/intake/source-records.json', startRow: source.recordCount - 1, rowCount: 1 }); }
        else if (step === 2) { step++; const confirmed = root.getState().workspaceFiles['/intake/meaning-confirmation.json'];
            content = call('candidate_infer_meaning', confirmed ? options.confirmedProposal?.(JSON.parse(confirmed).proposal) ?? JSON.parse(confirmed).proposal : options.proposal?.(proposal) ?? proposal); }
        else if (step === 3) { step++; attempt++; content = call('workspace_write', { path: `/workspace/repair-${attempt}.js`, expectedRevision: 0,
            content: options.mode && options.mode !== 'repair' && (attempt === 1 || options.mode === 'exhaust') ? 'throw new Error("synthetic fixable program failure");' : program }); }
        else if (step === 4) { step++; const a = value.payload?.workspace?.artifact;
            content = call('code_run', { program: a ? { path: a.path, revision: a.revision, sha256: a.sha256 } : undefined, inputs: [], mode: 'source_records',
            sourceRecords: { sourceId: source.sourceId, sha256: source.sha256, width: columns.length, initialState: {} },
            output: { path: `/workspace/output-${attempt}.json`, expectedRevision: 0, format: 'json' } }); }
        else if (step === 5 && value.receipt?.status !== 'succeeded') { step = 3; content = call('workspace_read', { path: '/intake/source-scan.json' }); }
        else if (step === 5) { step++; content = call('candidate_stage', { jobId: value.receipt?.jobId }); }
        else if (step === 6) { step++; candidateId = value.payload?.candidate?.candidateId ?? ''; content = call('candidate_validate', { candidateId }); }
        else if (step === 7) { step++; content = call('candidate_read', { candidateId, table: 'records', offset: 0, limit: 3 }); }
        else if (step === 8) { step++; content = call('candidate_request_approval', { candidateId, primaryTable: 'records' }); }
        else content = [{ type: 'text', text: 'Stopped; no commit authority.' }];
        const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
        const events = createAssistantMessageEventStream(); events.push({ type: 'start', partial: message }); events.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return events;
    };
    const runtimeOptions: PiInitialAnalysisOptions = { codingPreparation: options.coding ?? { enabled: true, qualified: true },
        // Post-commit initial report production is not this deterministic provider's qualification.
        stageServices: { runEvidence: async () => { throw new Error('qualification_postcommit_stage_stop'); } } };
    const request = { appSessionId: root.getState().sessionId, datasetId, datasetVersion: bundle.datasetVersion,
        researchGoal: goal, provider: { provider: 'default' as const, modelId: 'mock' } };
    const result = await runPiInitialAnalysis(request, root, stream, runtimeOptions);
    const retrySameSource = (researchGoal = goal) => {
        step = 0; attempt = 0; candidateId = '';
        return runPiInitialAnalysis({ ...request, researchGoal }, root, stream, runtimeOptions);
    };
    return { result, source, trace, reads, proposal, candidateId, file, retrySameSource };
};
