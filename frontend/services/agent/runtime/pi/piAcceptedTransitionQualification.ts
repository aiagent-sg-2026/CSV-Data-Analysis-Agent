import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { StoreApi } from '../../types';
import { runPiFollowUpTurn } from './piFollowUpRuntimeService';
import { beginRun, finishRun, scopeRunStore } from '../../../session/sessionOwnership';

/** Public synthetic browser qualification: copy the accepted primary through ordinary
 * public tools/QuickJS/independent validation and the normal exact React approval.
 * No accepted state, candidate receipt, storage or worker result is injected.
 */
export const preparePiOrdinaryTransitionSmoke = async (root: StoreApi) => {
    const before = root.getState(), bundle = before.datasetBundle!;
    const primary = bundle.tables.find(t => t.tableId === bundle.primaryTableId)!;
    const columns = primary.schema.map(c => c.name);
    const proposal = { input: { kind: 'table', name: 'records', tableId: primary.tableId }, table: {
        name: 'entities', grain: ['Id'], groupBy: [], columns: primary.schema.map(c => ({ ...c, sourceColumn: c.name,
            conversion: c.dataType === 'number' ? 'decimal' : 'identity', ...(c.dataType === 'number' ? { scale: 2, unit: 'USD' } : {}) })),
        detailRanges: [{ start: 0, end: primary.rowCount - 1 }],
    }, exclusions: [], assumptions: ['Keep the current complete entity grain unchanged; retire the detail table only with separate exact human approval.'] };
    const program = `const rows=input.records.rows.map(row=>({...row}));return {schemaVersion:1,complete:true,tables:[{name:'entities',role:'fact',schema:${JSON.stringify(primary.schema)},rowCount:rows.length,rows,lineage:rows.flatMap((_,row)=>${JSON.stringify(columns)}.map(column=>({row,column,origins:[{kind:'table',name:'records',row,column}]})))}],relationships:[],excludedRows:[]};`;
    const lease = beginRun(root, 'follow_up', crypto.randomUUID(), crypto.randomUUID()), store = scopeRunStore(root, lease);
    const goal = 'Retain the complete accepted primary entity table unchanged as an ordinary single-table generation; independently validate and request exact human approval before publication.';
    let step = 0, candidateId = '';
    const trace: string[] = [];
    const call = (name: string, args: unknown): AssistantMessage['content'] => [{ type: 'toolCall', id: crypto.randomUUID(), name, arguments: args as JsonObject }];
    const stream: StreamFn = (model, context) => {
        const last = context.messages.filter(m => m.role === 'toolResult').at(-1);
        const text = last?.content.filter(p => p.type === 'text').map(p => p.text).join('') ?? '';
        if (last) trace.push(`${last.toolName}: ${text}`);
        let v: { payload?: { workspace?: { artifact?: { path: string; revision: number; sha256: string } }; candidate?: { candidateId: string } }; taskPlan?: { candidateId: string }; receipt?: { jobId: string } } = {}; try { v = JSON.parse(text); } catch { /* Observe refusals unchanged. */ }
        let content: AssistantMessage['content'];
        if (step === 0) { step++; content = call('candidate_infer_meaning', proposal); }
        else if (step === 1) { step++; content = call('workspace_write', { path: '/workspace/ordinary-transition.js', expectedRevision: 0, content: program }); }
        else if (step === 2) { step++; const a = v.payload?.workspace?.artifact;
            content = call('code_run', { program: a && { path: a.path, revision: a.revision, sha256: a.sha256 }, inputs: [], tables: [{ name: 'records', tableId: primary.tableId }], output: { path: '/workspace/ordinary-transition.json', expectedRevision: 0, format: 'json' } }); }
        else if (step === 3) { step++; content = call('candidate_stage', { jobId: v.receipt?.jobId }); }
        else if (step === 4) { step++; candidateId = v.payload?.candidate?.candidateId ?? v.taskPlan?.candidateId ?? ''; content = call('candidate_validate', { candidateId }); }
        else if (step === 5) { step++; content = call('candidate_read', { candidateId, table: 'entities', offset: 0, limit: 3 }); }
        else if (step === 6) { step++; content = call('candidate_request_approval', { candidateId, primaryTable: 'entities' }); }
        else content = [{ type: 'text', text: 'Ordinary transition remains pending exact human approval.' }];
        const reason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
        const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() };
        const events = createAssistantMessageEventStream(); events.push({ type: 'start', partial: message }); events.push({ type: 'done', reason, message }); return events;
    };
    try { const result = await runPiFollowUpTurn({ message: goal }, store, stream); return { result, trace }; }
    finally { finishRun(root, lease); }
};
