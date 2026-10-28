import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { StoreApi } from '../../types';
import { createSingleTableDatasetBundle } from '../../../data/datasetBundle';
import { captureCsvSource } from '../../../data/immutableCsvSource';
import { parseCsvTextWithDetection } from '../../../data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../../../data/reportCsvIntake';
import { scanCsvSourceForImport, bindCsvSourceScan } from '../../../data/csvSourceScan';
import { runPiInitialAnalysis, type PiInitialAnalysisOptions } from './piInitialAnalysisRuntimeService';
import { executeSqlPlanAndCreateCard } from '../../execution/sqlCardExecutor';
import { attachAutoAnalysisEvaluationToCards } from '../../autoAnalysisEvaluation';
import type { CandidateMeaningProposal } from '../../../data/inferredCandidateMeaning';
import { executeManagedDataQuery } from '../../../duckdb/queryEngine';
import type { QueryPlan } from '../../../../types';

/** Ten deterministic post-commit worker queries, not live model answer qualification. */
export const queryPiStructureRepairSmoke = async (root: StoreApi) => {
    const state = root.getState(), data = state.canonicalCsvData, commitId = state.datasetBundle?.acceptedCommit?.commitId;
    if (!data || !commitId || state.datasetCommitBindingStatus !== 'ready') throw new Error('repair_draft_is_not_accepted_query_evidence');
    const columns = ['Entity', 'Status', 'Cost', 'Sales', 'Rate'];
    const sum = (column: string): QueryPlan => ({ aggregates: [{ function: 'sum', column, as: 'Value' }] });
    const cases: Array<{ name: string; plan: QueryPlan; expected: unknown[] }> = [
        { name: 'entity count', plan: { aggregates: [{ function: 'count', as: 'Value' }] }, expected: [{ Value: 3 }] },
        { name: 'identifiers and statuses', plan: { select: ['Entity', 'Status'], orderBy: [{ column: 'Entity', direction: 'asc' }] }, expected: [{ Entity: 'Atlas', Status: 'Open' }, { Entity: 'Birch', Status: 'Closed' }, { Entity: 'Cedar', Status: 'Open' }] },
        { name: 'cost total', plan: sum('Cost'), expected: [{ Value: 400 }] },
        { name: 'negative sales total', plan: sum('Sales'), expected: [{ Value: -400 }] },
        { name: 'cost by entity', plan: { ...sum('Cost'), groupBy: ['Entity'], orderBy: [{ column: 'Entity', direction: 'asc' }] }, expected: [{ Entity: 'Atlas', Value: 250 }, { Entity: 'Birch', Value: 30 }, { Entity: 'Cedar', Value: 120 }] },
        { name: 'sales by entity', plan: { ...sum('Sales'), groupBy: ['Entity'], orderBy: [{ column: 'Entity', direction: 'asc' }] }, expected: [{ Entity: 'Atlas', Value: -250 }, { Entity: 'Birch', Value: -30 }, { Entity: 'Cedar', Value: -120 }] },
        { name: 'status grain counts', plan: { groupBy: ['Status'], aggregates: [{ function: 'count', as: 'Value' }], orderBy: [{ column: 'Status', direction: 'asc' }] }, expected: [{ Status: 'Closed', Value: 1 }, { Status: 'Open', Value: 2 }] },
        { name: 'cost range', plan: { aggregates: [{ function: 'min', column: 'Cost', as: 'Minimum' }, { function: 'max', column: 'Cost', as: 'Maximum' }] }, expected: [{ Minimum: 30, Maximum: 250 }] },
        { name: 'non-additive rate preservation', plan: { select: ['Entity', 'Rate'], orderBy: [{ column: 'Entity', direction: 'asc' }] }, expected: [{ Entity: 'Atlas', Rate: '10%' }, { Entity: 'Birch', Rate: '0%' }, { Entity: 'Cedar', Rate: '5%' }] },
        { name: 'entity cost mean', plan: { aggregates: [{ function: 'avg', column: 'Cost', as: 'Value' }] }, expected: [{ Value: 400 / 3 }] },
    ];
    const observations = [];
    for (const test of cases) {
        const current = () => {
            if (root.getState().datasetBundle?.acceptedCommit?.commitId !== commitId || root.getState().canonicalCsvData !== data
                || root.getState().datasetCommitBindingStatus !== 'ready') throw new Error('input_version_changed');
        };
        current(); const result = await executeManagedDataQuery(data, { ...test.plan, limit: 20 }, columns); current();
        // Object property order is not SQL semantics. Compare using a stable column order.
        const stable = (rows: unknown[]) => JSON.stringify(rows.map(row => Object.entries(row as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
        if (stable(result.result.rows) !== stable(test.expected)) throw new Error(`repair_query_reference_mismatch:${test.name}`);
        observations.push({ name: test.name, engine: result.engine, loadVersion: result.loadVersion, sql: result.sqlPreview, rows: result.result.rows,
            datasetVersion: state.datasetBundle!.datasetVersion, commitId });
    }
    return observations;
};

/** Synthetic single-grain ERP report, NOT the unresolved 42/60/90 dual-grain qualification.
 * The provider is deterministic. Pi dispatch, original bytes, QuickJS, validator and approval are real.
 */
export const preparePiStructureRepairSmoke = async (root: StoreApi, options: {
    mode?: 'repair' | 'retry' | 'no-progress';
    observe?: (context: Parameters<StreamFn>[1]) => void;
    stageServices?: PiInitialAnalysisOptions['stageServices'];
} = {}) => {
    const text = ',Fictional ERP,,,\nEntity,Status,Cost,Sales,Rate\nAtlas,Open,250.00,-250.00,10%\nBirch,Closed,30.00,-30.00,0%\n,,,,\nEntity,Status,Cost,Sales,Rate\nCedar,Open,120.00,-120.00,5%\nTOTAL,,400.00,-400.00,\n,,,,\n';
    const file = new File([text], 'synthetic-erp-source.csv');
    const parsed = parseCsvTextWithDetection(text), ir = buildReportIntakeIr(file.name, parsed.rawRows, parsed.detection);
    const data = buildCsvDataFromIntakeIr(ir), datasetId = `erp-${crypto.randomUUID()}`;
    const goal = 'Repair the ERP report from original records; retain one row per entity, reconcile cost and negative sales, preserve rate strings without summing percentages.';
    const bundle = createSingleTableDatasetBundle({ datasetId, sourceFingerprint: 'synthetic', file, data });
    root.setState({ sessionId: `erp-smoke-${crypto.randomUUID()}`, sessionCreatedAt: new Date(), confirmedAnalysisGoal: goal,
        csvData: data, rawCsvData: structuredClone(data), canonicalCsvData: null, rawIntakeIr: ir, datasetBundle: bundle, currentDatasetId: datasetId,
        pipelineOutcome: { canAutoAnalyze: false, reasonCode: 'header_shape_drift' } as never,
        currentView: 'analysis_dashboard', pendingClarification: null, analysisCards: [], columnProfiles: [], queryHistory: [], activeDataQuery: null,
        workspaceFiles: {}, finalSummary: null, finalSummaryProvenance: null, datasetCommitBindingStatus: undefined,
        settings: { ...root.getState().settings, provider: 'default', simpleModel: 'mock', complexModel: 'mock', language: 'English',
            runtimeAccessControl: { permissionMode: 'open', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } } });
    const source = await captureCsvSource(root, file);
    root.setState({ datasetBundle: { ...bundle, source: { ...bundle.source, inspection: source } } });
    await scanCsvSourceForImport(root, file); bindCsvSourceScan(root, file, source);
    const proposal: CandidateMeaningProposal = { input: { kind: 'source', name: 'original' }, table: {
        name: 'entities', grain: ['Entity'], groupBy: [], columns: ['Entity', 'Status', 'Cost', 'Sales', 'Rate'].map((name, sourceColumn) => ({
            name, sourceColumn, dataType: ['Cost', 'Sales'].includes(name) ? 'number' : 'string', nullable: false,
            conversion: ['Cost', 'Sales'].includes(name) ? 'decimal' : 'identity', ...(['Cost', 'Sales'].includes(name) ? { scale: 2 } : {}),
        })), detailRanges: [{ start: 2, end: 3 }, { start: 6, end: 6 }] },
        exclusions: [{ row: 0, role: 'note' }, { row: 1, role: 'header' }, { row: 4, role: 'note' },
            { row: 5, role: 'header' }, { row: 7, role: 'grand_total' }, { row: 8, role: 'note' }],
        assumptions: ['Entity is the source record grain; rates remain non-additive original strings.'] };
    // This is scripted provider-authored code for this public ASCII fixture, never a production CSV mapper.
    const program = `const records=String.fromCharCode(...input.original.bytes).trimEnd().split('\\n').map(line=>line.split(','));
const detail=[2,3,6],columns=['Entity','Status','Cost','Sales','Rate'];
const rows=detail.map(index=>Object.fromEntries(columns.map((name,column)=>[name,column===2||column===3?Number(records[index][column]):records[index][column]])));
/*FAULT*/
return {schemaVersion:1,complete:true,tables:[{name:'entities',role:'fact',schema:columns.map((name,column)=>({name,dataType:column===2||column===3?'number':'string',nullable:false})),rowCount:rows.length,rows,lineage:detail.flatMap((index,row)=>columns.map((column,c)=>({row,column,origins:[{kind:'source',name:'original',row:index,column:c}]})))}],relationships:[],excludedRows:[0,1,4,5,7,8].map(row=>({origin:{kind:'source',name:'original',row},reason:'explicit host-checked role'}))};`;
    let step = 0, candidateId = '', attempt = 0;
    const trace: string[] = [];
    const call = (name: string, args: unknown): AssistantMessage['content'] => [{ type: 'toolCall', id: crypto.randomUUID(), name, arguments: args as JsonObject }];
    const stream: StreamFn = (model, context) => {
        options.observe?.(context);
        const last = context.messages.filter(m => m.role === 'toolResult').at(-1);
        const lastText = last?.content.filter(p => p.type === 'text').map(p => p.text).join('') ?? '';
        if (last) trace.push(`${last.toolName}: ${lastText}`);
        let value: { payload?: { workspace?: { artifact?: { path: string; revision: number; sha256: string } }; candidate?: { candidateId: string }; candidateValidation?: { decision: string } }; receipt?: { jobId: string } } = {};
        try { value = JSON.parse(lastText); } catch { /* A host refusal is observed, not turned into a success. */ }
        let content: AssistantMessage['content'];
        if (step === 0) { step++; content = call('run_next_analysis_stage', {}); }
        else if (step === 1) { step++; content = call('workspace_read', { path: '/intake/source-scan.json' }); }
        else if (step === 2) { step++; content = call('workspace_read', { path: '/intake/source-records.json', startRow: 0, rowCount: 9 }); }
        else if (step === 3) { step++; content = call('candidate_infer_meaning', proposal); }
        else if (step === 4) { step++; content = call('workspace_write', { path: '/workspace/erp-repair.js', expectedRevision: 0,
            content: program.replace('/*FAULT*/', options.mode && options.mode !== 'repair' ? 'rows[0].Cost=999;' : '') }); }
        else if (step === 5) { step++; attempt++; const artifact = value.payload?.workspace?.artifact;
            content = call('code_run', { program: artifact ? {path: artifact.path, revision: artifact.revision, sha256: artifact.sha256} : undefined, inputs: [], sources: [{ name: 'original', sourceId: source.sourceId, sha256: source.sha256, offset: 0, length: source.byteSize }],
                output: { path: '/workspace/erp-output.json', expectedRevision: attempt - 1, format: 'json' } }); }
        else if (step === 6) { step++; content = call('candidate_stage', { jobId: value.receipt?.jobId }); }
        else if (step === 7) { step++; candidateId = value.payload?.candidate?.candidateId ?? ''; content = call('candidate_validate', { candidateId }); }
        else if (step === 8 && value.payload?.candidateValidation?.decision !== 'validated') {
            step = 5; content = call('workspace_replace', { path: '/workspace/erp-repair.js', expectedRevision: attempt,
                oldText: 'rows[0].Cost=999;', newText: options.mode === 'no-progress' ? 'rows[0].Cost=999;\n' : '' });
        } else if (step === 8) { step++; content = call('candidate_read', { candidateId, table: 'entities', offset: 0, limit: 3 }); }
        else if (step === 9) { step++; content = call('candidate_request_approval', { candidateId, primaryTable: 'entities' }); }
        else content = call('run_next_analysis_stage', {});
        const stopReason = 'toolUse' as const;
        const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
        const events = createAssistantMessageEventStream(); events.push({ type: 'start', partial: message }); events.push({ type: 'done', reason: stopReason, message }); return events;
    };
    const runtimeOptions: PiInitialAnalysisOptions = { codingPreparation: { enabled: true, qualified: true }, stageServices: {
        runEvidence: async ({ store }) => {
            const card = await executeSqlPlanAndCreateCard({ chartType: 'bar', title: 'ERP repair cost', description: 'Complete committed entity grain.', aggregation: 'sum', queryMode: 'aggregate',
                query: { groupBy: ['Entity'], aggregates: [{ function: 'sum', column: 'Cost', as: 'Total' }], orderBy: [{ column: 'Total', direction: 'desc' }], limit: 10 },
                bindings: { groupByColumn: 'Entity', valueColumn: 'Total' } }, store);
            store.setState(state => ({ analysisCards: attachAutoAnalysisEvaluationToCards(state.analysisCards, { columnProfiles: state.columnProfiles }) }));
            return { acceptedCardCount: 1, session: { status: 'completed', acceptedOutputs: [{ cardId: card.id }] } } as never;
        },
        generateSummaries: async store => { store.setState({ finalSummary: { language: 'English', text: 'Synthetic committed ERP query only.' }, finalSummaryProvenance: store.getState().analysisCards.at(-1)!.provenance }); },
        ...options.stageServices,
    } };
    const result = await runPiInitialAnalysis({ appSessionId: root.getState().sessionId, datasetId, datasetVersion: bundle.datasetVersion,
        researchGoal: goal, provider: { provider: 'default', modelId: 'mock' } }, root, stream, runtimeOptions);
    // Qualification-only retry on the same original/session; do not reseed the fixture or reset its ledger.
    const retrySameSource = (researchGoal = goal) => runPiInitialAnalysis({ appSessionId: root.getState().sessionId, datasetId,
        datasetVersion: bundle.datasetVersion, researchGoal, provider: { provider: 'default', modelId: 'mock' } }, root, stream, runtimeOptions);
    return { result, source, file, data, ir, trace, stream, runtimeOptions, retrySameSource };
};
