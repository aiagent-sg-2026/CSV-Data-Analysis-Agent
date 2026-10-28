import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { StoreApi } from '../../types';
import { createSingleTableDatasetBundle } from '../../../data/datasetBundle';
import { captureCsvSource } from '../../../data/immutableCsvSource';
import { parseCsvTextWithDetection } from '../../../data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../../../data/reportCsvIntake';
import { scanCsvSourceForImport, bindCsvSourceScan, scannedCsvSourceMetadata } from '../../../data/csvSourceScan';
import { runPiInitialAnalysis, type PiInitialAnalysisOptions } from './piInitialAnalysisRuntimeService';
import type { DualGrainCandidateMeaning, DualGrainMeaningAlternatives } from '../../../data/dualGrainCandidateMeaning';

/** Public fictional shapes only. These are provider proposals, never trusted candidate state. */
export const syntheticDualGrainSource = (width = 90) => {
    const measures = width === 90 ? 60 : width === 60 ? 30 : 12, base = width - measures;
    const header = ['Id', 'Metric', 'Cost [USD]', 'Net [USD]', ...Array.from({ length: base - 4 }, (_, i) => `Descriptor${i}`), ...Array(12).fill('Value [USD]')];
    const inner = Array.from({ length: measures }, (_, i) => `Period${Math.floor(i / 5) + 1}:Category${i % 5 + 1}`);
    const records = Array.from({ length: 3 }, (_, i) => [`E${i + 1}`, `Label,\nα${i + 1}`, ['250.00', '30.00', '120.00'][i], ['-250.00', '-30.00', '-120.00'][i],
        ...Array.from({ length: base - 4 }, (_, j) => `D${j}`), ...Array.from({ length: measures }, (_, j) => j === 0 ? '' : j === 1 ? '0.00' : j === 2 ? '-1.25' : `${i + 1}.01`) ]);
    const raw = [header, inner, records[0], records[1], header, inner, records[2], ['TOTAL', '400.00', '-400.00']];
    const columns: DualGrainCandidateMeaning['tables'][number]['columns'] = header.slice(0, base).map((name, i) => ({ name, dataType: i === 2 || i === 3 ? 'number' : 'string',
        nullable: false, conversion: i === 2 || i === 3 ? 'decimal' : 'identity', ...(i === 2 || i === 3 ? { scale: 2, unit: 'USD' } : {}), header: { row: 0, column: i } }));
    const detailRanges = [{ start: 2, end: 3 }, { start: 6, end: 6 }];
    const meaning: DualGrainCandidateMeaning = { input: { kind: 'source', name: 'original' }, tables: [
        { name: 'entities', grain: ['Id'], groupBy: [], columns, detailRanges, projections: [columns.map((c, sourceColumn) => ({ column: c.name, sourceColumn }))] },
        { name: 'metrics', grain: ['Id', 'Metric'], groupBy: ['Metric'], columns: [columns[0], columns[1], { name: 'Value [USD]', dataType: 'number', nullable: true, conversion: 'decimal_or_null', scale: 2, unit: 'USD', header: { row: 0, column: base } }],
            detailRanges, projections: inner.map((_, i) => [{ column: 'Id', sourceColumn: 0 }, { column: 'Metric', sourceRow: 1, sourceColumn: i }, { column: 'Value [USD]', sourceColumn: base + i }]) },
    ], relationships: [{ fromTable: 'metrics', toTable: 'entities', fromKeys: ['Id'], toKeys: ['Id'], cardinality: 'many_to_one' }],
    exclusions: [{ row: 0, role: 'header' }, { row: 1, role: 'header' }, { row: 4, role: 'header' }, { row: 5, role: 'header' },
        { row: 7, role: 'grand_total', cells: [{ column: 0, kind: 'label' }, { column: 1, kind: 'sum', table: 'entities', metric: 'Cost [USD]' }, { column: 2, kind: 'sum', table: 'entities', metric: 'Net [USD]' }] }],
    assumptions: ['One entity per included record; metric labels align to the chosen source header order. Footer role is a semantic proposal, not inferred from matching totals.'] };
    const alternative = structuredClone(meaning);
    for (const projection of alternative.tables[1].projections) projection[1].sourceColumn = measures - 1 - projection[1].sourceColumn;
    const proposal: DualGrainMeaningAlternatives = { input: meaning.input, interpretations: [
        { label: 'A: category header sequence aligns forwards to physical measure cells', meaning },
        { label: 'B: category header sequence aligns in reverse to physical measure cells', meaning: alternative },
    ], assumptions: ['Both alignments are structurally possible; business meaning requires exact human selection.'] };
    const text = raw.map(row => row.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n');
    return { raw, text, proposal, measures };
};

/** Meaningful synthetic records, not whitespace padding. Every descriptor identifies a
 * different source dimension and every metric cell is independently value-bearing. */
export const syntheticStreamedDualSource = (records = 10000, width = 90) => {
    const small = syntheticDualGrainSource(width), proposal = structuredClone(small.proposal), measures = small.measures, base = width - measures;
    for (const interpretation of proposal.interpretations) {
        for (const table of interpretation.meaning.tables) table.detailRanges = [{ start: 2, end: records + 1 }];
        interpretation.meaning.exclusions = [interpretation.meaning.exclusions[0], interpretation.meaning.exclusions[1], { row: records + 2, role: 'grand_total', cells: small.proposal.interpretations[0].meaning.exclusions.at(-1)!.cells }];
    }
    const header = small.raw[0], inner = small.raw[1];
    const raw = [header, inner];
    for (let i = 0; i < records; i++) raw.push([`E${String(i).padStart(8, '0')}`, `Source record ${i}, verified fictional metric inventory\nregion ${i % 17}`,
        '1.25', '-1.25', ...Array.from({ length: base - 4 }, (_, j) => `Dimension ${j}: entity ${i}; zone ${i % 17}; revision ${i % 11}; status ${i % 3}; catalog item ${i * 31 + j}; source attribute ${j}`),
        ...Array.from({ length: measures }, (_, j) => j === 0 ? '' : j === 1 ? '0.00' : j === 2 ? '-1.25' : `${i % 100 + 1}.${String(j % 100).padStart(2, '0')}`)]);
    const total = String(records * 125), amount = total.slice(0, -2) + '.' + total.slice(-2);
    raw.push(['TOTAL', amount, '-' + amount]);
    return { raw, text: raw.map(row => row.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n'), proposal, measures };
};

/** Distinct document-header/detail records, with explicit preceding-document boundaries. */
export const syntheticDocumentGrainSource = (width = 42) => {
    const header = ['Id', 'Metric', 'Cost [USD]', 'Net [USD]', ...Array.from({ length: width - 4 }, (_, i) => `Descriptor${i}`)];
    const record = (id: string, item: string, cost: string, net: string) => [id, item, cost, net, ...Array.from({ length: width - 4 }, (_, i) => `Text${i}`)];
    const raw = [header, record('D1', 'document', '250.00', '-250.00'), record('D1', 'L1', '0.00', '0.00'), record('D1', 'L2', '-1.25', '1.25'),
        record('D2', 'document', '150.00', '-150.00'), record('D2', 'L1', '2.50', '-2.50'), record('D2', 'L2', '3.00', '-3.00'), header, ['TOTAL', '400.00', '-400.00']];
    const columns: DualGrainCandidateMeaning['tables'][number]['columns'] = header.map((name, i) => ({ name, dataType: i === 2 || i === 3 ? 'number' : 'string',
        nullable: false, conversion: i === 2 || i === 3 ? 'decimal' : 'identity', ...(i === 2 || i === 3 ? { scale: 2, unit: 'USD' } : {}), header: { row: 0, column: i } }));
    const meaning: DualGrainCandidateMeaning = { input: { kind: 'source', name: 'original' }, tables: [
        { name: 'entities', grain: ['Id'], groupBy: [], columns, detailRanges: [{ start: 1, end: 1 }, { start: 4, end: 4 }], projections: [columns.map((c, sourceColumn) => ({ column: c.name, sourceColumn }))] },
        { name: 'metrics', grain: ['Id', 'Metric'], groupBy: ['Id'], columns, detailRanges: [{ start: 2, end: 3 }, { start: 5, end: 6 }], projections: [columns.map((c, sourceColumn) => ({ column: c.name, sourceColumn }))] },
    ], relationships: [{ fromTable: 'metrics', toTable: 'entities', fromKeys: ['Id'], toKeys: ['Id'], cardinality: 'many_to_one' }], exclusions: [{ row: 0, role: 'header' }, { row: 7, role: 'header' },
        { row: 8, role: 'grand_total', cells: [{ column: 0, kind: 'label' }, { column: 1, kind: 'sum', table: 'entities', metric: 'Cost [USD]' }, { column: 2, kind: 'sum', table: 'entities', metric: 'Net [USD]' }] }],
    assumptions: ['Physical document headers and detail rows are different grains; each detail must reference the immediately preceding document. Amounts at the two grains are never added together.'] };
    const alternative = structuredClone(meaning);
    for (const table of alternative.tables) [table.projections[0][4].sourceColumn, table.projections[0][5].sourceColumn] = [5, 4];
    const proposal: DualGrainMeaningAlternatives = { input: meaning.input, interpretations: [
        { label: 'A: document/detail roles with direct descriptor alignment', meaning },
        { label: 'B: same document/detail roles with first two descriptors reversed', meaning: alternative },
    ], assumptions: ['Choose source roles and descriptor alignment, not commit authority.'] };
    return { raw, text: raw.map(row => row.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n'), proposal, measures: 2 };
};

/** Scripted provider-authored transformation; parses actual protected UTF-8 bytes in QuickJS.
 * No expected rows or host reference values are embedded in the program. */
const programFor = (p: DualGrainCandidateMeaning, fault?: string) => `
const bytes=input.original.bytes; let csv='';
for(let i=0;i<bytes.length;){const a=bytes[i++];let n=a;if(a>=240)n=((a&7)<<18)|((bytes[i++]&63)<<12)|((bytes[i++]&63)<<6)|(bytes[i++]&63);else if(a>=224)n=((a&15)<<12)|((bytes[i++]&63)<<6)|(bytes[i++]&63);else if(a>=192)n=((a&31)<<6)|(bytes[i++]&63);csv+=String.fromCodePoint(n);}
const records=[];let row=[],value='',quoted=false;
for(let i=0;i<csv.length;i++){const ch=csv[i];if(ch==='"'){if(quoted&&csv[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(ch===','&&!quoted){row.push(value);value='';}else if((ch==='\\r'||ch==='\\n')&&!quoted){if(ch==='\\r'&&csv[i+1]==='\\n')i++;row.push(value);records.push(row);row=[];value='';}else value+=ch;}
if(quoted)throw new Error('unclosed quote');row.push(value);records.push(row);
const p=${JSON.stringify(p)};
const tables=p.tables.map(t=>{const rows=[],lineage=[];
for(const range of t.detailRanges)for(let r=range.start;r<=range.end;r++)for(const projection of t.projections){const out={},index=rows.length;
for(const c of t.columns){const m=projection.find(m=>m.column===c.name),sourceRow=m.sourceRow===undefined?r:m.sourceRow,raw=records[sourceRow][m.sourceColumn];
out[c.name]=c.conversion==='decimal_or_null'&&raw===''?null:c.dataType==='number'?Number(raw):c.conversion==='trim'?raw.trim():raw;
lineage.push({row:index,column:c.name,origins:[{kind:'source',name:p.input.name,row:sourceRow,column:m.sourceColumn}]});}rows.push(out);}
return {name:t.name,role:'fact',schema:t.columns.map(({name,dataType,nullable})=>({name,dataType,nullable})),rowCount:rows.length,rows,lineage};});
${fault === 'value' ? 'tables[1].rows[2][p.tables[1].columns[2].name]=999;' : ''}
return {schemaVersion:1,complete:true,tables,relationships:p.relationships,excludedRows:p.exclusions.map(e=>({origin:{kind:'source',name:p.input.name,row:e.row},reason:e.role}))};`;

/** Normal production coordinator/public tools. Deterministic provider, not a live provider test. */
export const preparePiDualGrainSmoke = async (root: StoreApi, options: {
    /** Qualification-only: start a fresh normal task without replacing accepted source/session. */
    keepAccepted?: boolean;
    streamRecords?: number;
    width?: number; layout?: 'document_rows'; coding?: PiInitialAnalysisOptions['codingPreparation']; fault?: 'value' | 'program_revision';
    proposal?: (proposal: DualGrainMeaningAlternatives) => unknown;
    confirmedProposal?: (proposal: DualGrainCandidateMeaning) => unknown;
    beforeProvider?: (turn: number) => Promise<void>;
} = {}) => {
    const fixture = options.streamRecords ? syntheticStreamedDualSource(options.streamRecords,options.width) : options.layout === 'document_rows' ? syntheticDocumentGrainSource(options.width) : syntheticDualGrainSource(options.width), file = new File([fixture.text], 'fictional-dual-grain.csv');
    const parsed = parseCsvTextWithDetection(options.streamRecords ? '' : fixture.text), ir = options.streamRecords ? null : buildReportIntakeIr(file.name, parsed.rawRows, parsed.detection), data = ir ? buildCsvDataFromIntakeIr(ir) : {fileName:file.name,data:[]};
    const reads={bytes:0,calls:0,maxBytes:0,fullReads:0};
    if(options.streamRecords){
        // Fixture construction is not app execution memory. Release its source-sized arrays
        // before qualification; the production path retains only the immutable native File.
        fixture.raw=[];fixture.text='';
        const guard=(blob:Blob,full:boolean):Blob=>{const slice=blob.slice.bind(blob),arrayBuffer=blob.arrayBuffer.bind(blob);
            Object.defineProperty(blob,'slice',{value:(start?:number,end?:number)=>guard(slice(start,end),false)});
            Object.defineProperty(blob,'arrayBuffer',{value:async()=>{if(full||blob.size>65536){reads.fullReads++;throw new Error('qualification_unbounded_source_read');}
                reads.calls++;reads.bytes+=blob.size;reads.maxBytes=Math.max(reads.maxBytes,blob.size);return arrayBuffer();}});return blob;};guard(file,true);
    }
    const datasetId = options.keepAccepted ? root.getState().currentDatasetId! : crypto.randomUUID(), goal = 'Repair both source-backed grains without fanout; independently validate both tables and request separate exact human approval. Never commit without that approval.';
    const bundle = options.keepAccepted ? root.getState().datasetBundle! : createSingleTableDatasetBundle({ datasetId, sourceFingerprint: 'pending', file, data });
    if (!options.keepAccepted) root.setState({ sessionId: crypto.randomUUID(), sessionCreatedAt: new Date(), confirmedAnalysisGoal: goal, csvData: data, rawCsvData: structuredClone(data), canonicalCsvData: null,
        rawIntakeIr: ir, datasetBundle: bundle, currentDatasetId: datasetId, currentView: 'analysis_dashboard', pipelineOutcome: { canAutoAnalyze: false, reasonCode: 'header_shape_drift' } as never,
        pendingClarification: null, candidateRecovery: null, analysisCards: [], columnProfiles: [], queryHistory: [], workspaceFiles: {}, datasetCommitBindingStatus: undefined,
        settings: { ...root.getState().settings, provider: 'default', simpleModel: 'mock', complexModel: 'mock', language: 'English', runtimeAccessControl: { permissionMode: 'open', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } } });
    if(options.streamRecords){await scanCsvSourceForImport(root,file);}
    const source = options.keepAccepted ? bundle.source.inspection! : options.streamRecords ? scannedCsvSourceMetadata(root,file) : await captureCsvSource(root, file);
    if (options.keepAccepted) root.setState({ workspaceFiles: {}, pendingClarification: null, activeAgentTask: null, taskInspection: null });
    else {
        root.setState({ datasetBundle: { ...bundle, source: { ...bundle.source, inspection: source } } });
        if(!options.streamRecords)await scanCsvSourceForImport(root, file); bindCsvSourceScan(root, file, source);
    }
    let step = 0, candidateId = '', staleJobId = '', calls = 0;
    const trace: string[] = [];
    const call = (name: string, args: unknown): AssistantMessage['content'] => [{ type: 'toolCall', id: crypto.randomUUID(), name, arguments: args as JsonObject }];
    const stream: StreamFn = async (model, context) => {
        await options.beforeProvider?.(++calls);
        const last = context.messages.filter(m => m.role === 'toolResult').at(-1), text = last?.content.filter(p => p.type === 'text').map(p => p.text).join('') ?? '';
        if (last) trace.push(`${last.toolName}: ${text}`);
        let v: { taskPlan?: { candidateId?: string }; payload?: { workspace?: { artifact?: { path: string; revision: number; sha256: string } }; candidate?: { candidateId: string } }; receipt?: { jobId: string } } = {};
        try { v = JSON.parse(text); } catch { /* Host refusals are not successes. */ }
        const confirmation = root.getState().workspaceFiles['/intake/meaning-confirmation.json'];
        if (!last && confirmation) step = 2;
        const selected: DualGrainCandidateMeaning | undefined = confirmation ? JSON.parse(confirmation).proposal : undefined;
        let content: AssistantMessage['content'];
        if (step === 0) { step++; content = call('workspace_read', { path: '/intake/source-scan.json' }); }
        else if (step === 1) { step++; content = call('workspace_read', { path: '/intake/source-records.json', startRow: 0, rowCount: options.streamRecords ? 2 : fixture.raw.length }); }
        else if (step === 2) { step++; content = call('candidate_infer_meaning', selected ? options.confirmedProposal?.(selected) ?? selected : options.proposal?.(fixture.proposal) ?? fixture.proposal); }
        else if (step === 3) { step++; content = call('workspace_write', { path: '/workspace/dual-grain.js', expectedRevision: 0, content: options.streamRecords ? `return {state:{},rows:input.records.map(r=>({sourceRow:r.sourceRow,cells:Array.from({length:${options.width??90}},(_,i)=>${options.fault==='value'?"r.sourceRow===2&&i===2?'999.99':":""}(r.cells[i]??'') )}))};` : programFor(selected ?? fixture.proposal.interpretations[0].meaning, options.fault) }); }
        else if (step === 4) { step++; const a = v.payload?.workspace?.artifact; content = call('code_run', { program: a && { path: a.path, revision: a.revision, sha256: a.sha256 }, inputs: [], ...(options.streamRecords ? {mode:'source_records',sourceRecords:{sourceId:source.sourceId,sha256:source.sha256,width:options.width??90,initialState:{}}} : {sources: [{ name: 'original', sourceId: source.sourceId, sha256: source.sha256, offset: 0, length: source.byteSize }]}), output: { path: '/workspace/dual-grain-output.json', expectedRevision: 0, format: 'json' } }); }
        else if (step === 5 && options.fault === 'program_revision') { staleJobId = v.receipt?.jobId ?? ''; step = 51; content = call('workspace_append', { path: '/workspace/dual-grain.js', expectedRevision: 1, content: '\n// changed after execution' }); }
        else if (step === 51) { step = 10; content = call('candidate_stage', { jobId: staleJobId }); }
        else if (step === 5) { step++; content = call('candidate_stage', { jobId: v.receipt?.jobId }); }
        else if (step === 6) { step++; candidateId = v.taskPlan?.candidateId ?? v.payload?.candidate?.candidateId ?? ''; content = call('candidate_validate', { candidateId }); }
        else if (step === 7 || step === 8) { content = call('candidate_read', { candidateId, table: step++ === 7 ? 'entities' : 'metrics', offset: 0, limit: 3 }); }
        else if (step === 9) { step++; content = call('candidate_request_approval', { candidateId, primaryTable: 'entities' }); }
        else content = [{ type: 'text', text: 'Both drafts remain uncommitted until exact all-table human approval.' }];
        const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
        const events = createAssistantMessageEventStream(); events.push({ type: 'start', partial: message }); events.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return events;
    };
    const result = await runPiInitialAnalysis({ appSessionId: root.getState().sessionId, datasetId, datasetVersion: bundle.datasetVersion, researchGoal: goal, provider: { provider: 'default', modelId: 'mock' } }, root, stream,
        { codingPreparation: options.coding ?? { enabled: true, qualified: true } });
    return { result, source, trace, fixture, data, file, reads };
};
