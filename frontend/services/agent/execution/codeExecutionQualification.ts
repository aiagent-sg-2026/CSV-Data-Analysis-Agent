import type { StoreApi } from '../types';
import type { CodeExecutionReceipt } from './codeExecutionContract';
import { createCodeExecutionAdapter } from './codeExecutionAdapter';
import { handleExecutorAction } from './executorAgent';
import { createTaskWorkspace } from '../taskWorkspace';
import { createAgentTask, transitionAgentTask, type AgentTaskDefinition } from '../runtime/pi/piTaskContract';
import { beginRun, cancelOwnedRun, finishRun, scopeRunStore } from '../../session/sessionOwnership';
import { createJavaScriptGuest } from '../../sandbox/javascriptGuestClient';
import { sha256Bytes } from '../../data/sourceDigest';

export interface AdapterCheck { id: string; passed: boolean; receipt?: Readonly<CodeExecutionReceipt>; elapsedMs: number }

/** Fixed synthetic host fixture. It has no references to application data, actions or Store setters. */
export const qualifyCodeExecutionAdapter = async (signal: AbortSignal, onObservation?: (value: AdapterCheck) => void) => {
    let state = { sessionId: `adapter-lab-${crypto.randomUUID()}`, settings: { provider: 'default', simpleModel: 'mock', complexModel: 'mock',
        runtimeAccessControl: { permissionMode: 'open', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } },
        analysisCards: [], columnProfiles: [], csvData: { data: [] }, datasetBundle: { relationshipSetId: 'lab-relationships',
            tables: [{ tableId: 'lab-table', datasetVersion: 'lab-v1' }] },
    } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: partial => { state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) }; } };
    const lease = beginRun(root, 'follow_up', crypto.randomUUID(), crypto.randomUUID());
    const store = scopeRunStore(root, lease);
    const abort = () => cancelOwnedRun(root); signal.addEventListener('abort', abort, { once: true });
    const observations: AdapterCheck[] = [];
    let cleanup = () => {};
    try {
        if (signal.aborted) throw new Error('scope_revoked');
        const startedAt = performance.now();
        const hash = await sha256Bytes(new TextEncoder().encode('fixed synthetic adapter checks v1'));
        const definition: AgentTaskDefinition = { goal: 'Verify fixed synthetic worker/dispatcher plumbing', kind: 'artifact', requiredOutputs: [{ id: 'synthetic-output', kind: 'artifact', required: true }],
            inputBindings: [{ tableId: 'lab-table', datasetVersion: 'lab-v1', relationshipSetId: 'lab-relationships' }], protectedInvariants: [], capabilityGrants: [],
            scope: { digest: hash, intentDigest: hash, answer: { requiresEvidence: false, queries: [], unresolved: [], complete: true } } };
        let task = transitionAgentTask(store, createAgentTask(store, lease, definition), lease, 'inspecting');
        const workspace = createTaskWorkspace(store, task.taskId, { allowedPrefixes: ['/workspace/'] });
        cleanup = () => workspace.dispose();
        const programPath = '/workspace/program.js', inputPath = '/workspace/input.json', outputPath = '/workspace/output.json';
        const input = await workspace.write(inputPath, '[2,3,5]', 0);
        const guest = createJavaScriptGuest(store);
        let onExecuting: (() => void) | undefined;
        const adapter = createCodeExecutionAdapter(store, workspace, () => task, {
            run: (code, json, options) => guest.run(code, json, { ...options, onStarted: () => { options.onStarted?.(); onExecuting?.(); } }),
            cancel: () => guest.cancel(), dispose: () => guest.dispose(),
        });
        cleanup = () => { adapter.dispose(); workspace.dispose(); };
        store.codeExecution = adapter;
        const reference = await adapter.issueGrant({ readPaths: [programPath, inputPath], writePaths: [outputPath], expiresAt: Date.now()+900000 });
        task = { ...task, capabilityGrants: [reference] };
        const record = (id: string, passed: boolean, receipt?: Readonly<CodeExecutionReceipt>) => {
            const observation = { id, passed, receipt, elapsedMs: Math.round(performance.now()-startedAt) };
            observations.push(observation); if (!signal.aborted) onObservation?.(observation);
        };
        const execute = async (id: string, code: string, extra: Record<string, unknown> = {}) => {
            const program = await workspace.write(programPath, code, workspace.revision(programPath));
            store.executionContext = { lease, toolCallId: `lab-call-${id}`, stepId: `lab-step-${id}` };
            const request = { program: { path: programPath, revision: program.revision, sha256: program.sha256 },
                inputs: [{ name: 'rows', path: input.path, revision: input.revision, sha256: input.sha256 }],
                output: { path: outputPath, expectedRevision: workspace.revision(outputPath), format: 'json' }, ...extra };
            const result = await handleExecutorAction({ type: 'tool_call', toolName: 'code.run', args: request }, store, { abortSignal: signal });
            return result.artifacts?.codeExecution as Readonly<CodeExecutionReceipt>;
        };
        const valid = await execute('compute', 'console.log("computed"); return JSON.parse(input.rows.content).reduce((a,b)=>a+b,0);');
        record('real-compute', valid.status === 'succeeded' && workspace.read(outputPath).content === '10'
            && valid.stdout === 'computed\n' && valid.toolCallId === 'lab-call-compute' && Boolean(valid.requestDigest && valid.environmentDigest && valid.output?.sha256), valid);
        const inspected = await handleExecutorAction({ type: 'tool_call', toolName: 'code.inspect', args: { jobId: valid.jobId } }, store);
        record('owned-inspect', JSON.stringify(inspected.artifacts?.codeExecution) === JSON.stringify(valid), valid);
        const failed = await execute('failure', 'console.error("invalid row"); throw new TypeError("column missing");');
        record('real-error', failed.status === 'failed' && !failed.output && failed.error?.name === 'TypeError' && failed.error.message === 'column missing' && failed.stderr === 'invalid row\n', failed);
        const repaired = await execute('repair', 'return JSON.parse(input.rows.content).length;');
        record('revised-program', repaired.status === 'succeeded' && workspace.read(outputPath).content === '3' && repaired.program!.revision > valid.program!.revision, repaired);
        const forged = await execute('forged', 'return 999;', { runId: 'model-forged-lineage' });
        record('forged-lineage', forged.status === 'blocked' && !forged.output && workspace.read(outputPath).content === '3', forged);
        const logs = await execute('logs', 'console.log("😀".repeat(20000)); console.error("x".repeat(20000)); return 7;');
        record('bounded-logs', logs.status === 'succeeded' && logs.logsTruncated && new TextEncoder().encode(logs.stdout).length <= 16384 && new TextEncoder().encode(logs.stderr).length <= 16384, logs);
        let executed!: () => void;
        const entered = new Promise<void>(resolve => { executed = resolve; }); onExecuting = executed;
        const cancellation = execute('cancel', 'while(true){}');
        await Promise.race([entered, cancellation.then(() => { throw new Error('Worker did not start'); })]);
        onExecuting = undefined;
        const jobs = adapter.inspect(undefined, store.executionContext!) as Readonly<CodeExecutionReceipt>[];
        const running = jobs.find(job => job.status === 'running');
        if (!running) throw new Error('No running owned job');
        const cancelledAt = performance.now();
        await handleExecutorAction({ type: 'tool_call', toolName: 'code.cancel', args: { jobId: running.jobId } }, store);
        const cancelled = await cancellation;
        record('owned-cancel', cancelled.status === 'cancelled' && !cancelled.output && performance.now()-cancelledAt < 2000, cancelled);
        const recovered = await execute('recovery', 'return 42;');
        record('post-cancel-recovery', recovered.status === 'succeeded' && workspace.read(outputPath).content === '42', recovered);
        return { passed: !signal.aborted && observations.length === 8 && observations.every(check => check.passed), observations };
    } finally { signal.removeEventListener('abort', abort); cleanup(); finishRun(root, lease); }
};
