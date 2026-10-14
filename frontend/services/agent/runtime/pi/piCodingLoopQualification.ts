import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { StoreApi } from '../../types';
import { beginRun, cancelOwnedRun, finishRun, scopeRunStore } from '../../../session/sessionOwnership';
import { createJavaScriptGuest } from '../../../sandbox/javascriptGuestClient';
import { preparePiTask } from './piCodingTask';
import { runPiFollowUpTurn } from './piFollowUpRuntimeService';

export interface PiLoopCheck { id: string; passed: boolean; status: string; elapsedMs: number; details?: Record<string, unknown> }
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Content = AssistantMessage['content'];
const scripted = (next: (context: Parameters<StreamFn>[1]) => Content): StreamFn => (model, context) => {
    const content = next(context), stopReason = content.some(part => part.type === 'toolCall') ? 'toolUse' as const : 'stop' as const;
    const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: stopReason, message }); return stream;
};
const results = (context: Parameters<StreamFn>[1]) => context.messages.filter(message => message.role === 'toolResult').map(message => {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
    try { return JSON.parse(text); } catch { return { error: text }; }
});
const ref = (artifact: {path: string; revision: number; sha256: string}) => ({ path: artifact.path, revision: artifact.revision, sha256: artifact.sha256 });
const programPath = '/workspace/repair.js', inputPath = '/workspace/input.json', outputPath = '/workspace/output.json';
const run = (program: ReturnType<typeof ref>, inputs: unknown[] = []) => ({ program, inputs, output: {path: outputPath, expectedRevision: 0, format: 'json'} });
const answer: Content = [{type: 'text', text: 'Fabricated stdout: 999; completed.'}];

/** Fixed synthetic, keyless qualification of actual Pi/tool/worker plumbing; this is not model-autonomy evaluation. */
export const qualifyPiCodingLoop = async (signal: AbortSignal, onObservation?: (check: PiLoopCheck) => void) => {
    const observations: PiLoopCheck[] = []; let callId = 0;
    const tool = (name: string, args: Record<string, unknown>): Content => [{type: 'toolCall', id: `qualification-${++callId}`, name, arguments: args as JsonObject}];
    const record = (check: PiLoopCheck) => { observations.push(check); if (!signal.aborted) onObservation?.(check); };
    const fixture = async (message = 'Write a JavaScript program and stage its output.', cancelOnStarted = false) => {
        let state = { sessionId: `pi-coding-lab-${crypto.randomUUID()}`, settings: {provider: 'default', language: 'English', simpleModel: 'mock', complexModel: 'mock',
            runtimeAccessControl: {permissionMode: 'open', toolOverrides: {}, workspaceRules: {deniedPathPrefixes: []}}},
            // Empty synthetic rows keep qualification out of current-session persistence and real data memory.
            csvData: {fileName: 'synthetic-pi-lab.csv', data: []}, rawCsvData: null, canonicalCsvData: null,
            datasetBundle: {primaryTableId: 'lab-table', datasetVersion: 'lab-v1', source: {}, relationshipSetId: 'lab-rel',
                tables: [{tableId: 'lab-table', datasetVersion: 'lab-v1'}]}, semanticDatasetVersion: 'lab-v1',
            analysisCards: [], columnProfiles: [], chatHistory: [], dataQualityIssues: [], activeDataQuery: null,
            agentEvents: [], agentToolLogs: [], runtimeEvents: [], progressMessages: [], telemetryEvents: [],
            workspaceFiles: {'skills/lab/SKILL.md': '---\nname: lab\ndescription: Inspect program inputs and use actual errors.\n---\nInspect inputs, write, run, repair and rerun.'},
            logAgentToolUsage() {}, addProgress() {}, clearActiveTurnCancellation() {}, setStreamingMessage() {},
        } as unknown as ReturnType<StoreApi['getState']>;
        const root: StoreApi = {getState: () => state, setState: patch => { state = {...state, ...(typeof patch === 'function' ? patch(state) : patch)}; }};
        const lease = beginRun(root, 'follow_up', crypto.randomUUID(), crypto.randomUUID()), store = scopeRunStore(root, lease);
        const guest = createJavaScriptGuest(store); let cancelledAt: number | undefined;
        const task = await preparePiTask(store, message, undefined, {run: (code, json, options) => guest.run(code, json, {...options,
            onStarted: () => { options.onStarted?.(); if (cancelOnStarted) { cancelledAt = performance.now(); cancelOwnedRun(root); } }}),
            cancel: () => guest.cancel(), dispose: () => guest.dispose()});
        const abort = () => cancelOwnedRun(root); signal.addEventListener('abort', abort, {once: true});
        const cleanup = () => { signal.removeEventListener('abort', abort); task.close('cancelled'); finishRun(root, lease); };
        if (signal.aborted) { cleanup(); throw new Error('scope_revoked'); }
        return {root, store, lease, task, message, cleanup, cancelledAt: () => cancelledAt};
    };
    const check = async (id: string, mode: 'repair' | 'failure' | 'repeat' | 'stale' | 'grounding' | 'stop') => {
        const started = performance.now(), s = await fixture(mode === 'grounding' ? 'What is the October total?' : undefined, mode === 'stop');
        let step = 0, program: ReturnType<typeof ref>, input: ReturnType<typeof ref>, failure: Record<string, unknown>, success: Record<string, unknown>;
        try {
            const result = await runPiFollowUpTurn({message: s.message}, s.store, scripted(context => {
                const observed = results(context), index = step++;
                if (mode === 'repair') {
                    if (index === 0) return tool('read_skill', {name: 'lab'});
                    if (index === 1) return tool('workspace_list', {path: '/', recursive: true});
                    if (index === 2) return tool('workspace_write', {path: inputPath, content: '[2,3,5]', expectedRevision: 0});
                    if (index === 3) { input = ref(observed.at(-1).payload.workspace.artifact); return tool('workspace_write', {path: programPath, content: 'throw new TypeError("missing column");', expectedRevision: 0}); }
                    if (index === 4) { program = ref(observed.at(-1).payload.workspace.artifact); return tool('code_run', run(program, [{name: 'rows', ...input}])); }
                    if (index === 5) { failure = observed.at(-1).receipt; return tool('workspace_replace', {path: programPath, oldText: 'throw new TypeError("missing column");',
                        newText: 'console.log("repaired"); return JSON.parse(input.rows.content).reduce((sum,x)=>sum+x,0);', expectedRevision: 1}); }
                    if (index === 6) { program = ref(observed.at(-1).payload.workspace.artifact); return tool('code_run', run(program, [{name: 'rows', ...input}])); }
                    if (index === 7) { success = observed.at(-1).receipt; return tool('workspace_read', {path: outputPath}); }
                    if (index === 8) { if (observed.at(-1).payload.workspace.content !== '10') throw new Error('Incorrect real output'); return answer; }
                    throw new Error('Unexpected provider turn');
                }
                if (index === 0) return tool('workspace_write', {path: programPath, expectedRevision: 0,
                    content: mode === 'stop' ? 'while(true){}' : mode === 'grounding' ? 'console.log("999"); return 999;'
                        : mode === 'stale' ? 'return 42;' : 'throw new Error("same failure");'});
                if (index === 1) { program = ref(observed.at(-1).payload.workspace.artifact); return tool('code_run', run(program)); }
                if (mode === 'repeat') return tool('code_run', run(program));
                if (mode === 'stale' && index === 2) return tool('workspace_write', {path: programPath, content: 'return 999;', expectedRevision: 1});
                return answer;
            }));
            const passed = mode === 'repair' ? result.status === 'completed' && !result.text?.includes('999') && failure?.status === 'failed'
                && (failure.error as {name?: string})?.name === 'TypeError' && success?.status === 'succeeded' && success.stdout === 'repaired\n'
                && s.task.snapshot.budget.used.transformationAttempts === 2
                : mode === 'repeat' ? result.status === 'blocked' && result.text?.includes('coding_no_progress') && s.task.snapshot.budget.used.transformationAttempts === 2
                : mode === 'stop' ? result.status === 'cancelled' && s.cancelledAt() !== undefined && performance.now() - s.cancelledAt()! < 2000
                : result.status === 'blocked' && !result.text?.includes('999');
            record({id, passed: Boolean(passed) && !s.root.getState().isBusy && s.root.getState().csvData!.data.length === 0,
                status: result.status, elapsedMs: Math.round(performance.now() - started), details: {taskId: s.task.snapshot.taskId, budget: s.task.snapshot.budget,
                    ...(mode === 'repair' ? {failure, success} : {}), ...(mode === 'stop' ? {stopMs: Math.round(performance.now() - s.cancelledAt()!)} : {})}});
        } finally { s.cleanup(); }
    };
    for (const [id, mode] of [['real-write-error-patch-run', 'repair'], ['fabricated-success-blocked', 'failure'], ['no-progress-blocked', 'repeat'],
        ['edited-program-rejected', 'stale'], ['code-not-query-evidence', 'grounding'], ['owned-stop', 'stop'], ['post-stop-recovery', 'repair']] as const) {
        if (signal.aborted) break;
        await check(id, mode);
    }
    return {passed: !signal.aborted && observations.length === 7 && observations.every(check => check.passed), observations,
        qualification: 'scripted-provider plumbing; real Pi tools and QuickJS worker; no model-autonomy claim'};
};
