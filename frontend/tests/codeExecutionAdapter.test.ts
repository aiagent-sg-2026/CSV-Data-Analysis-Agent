// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { createCodeExecutionAdapter } from '../services/agent/execution/codeExecutionAdapter';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { beginRun, scopeRunStore, beginSessionTransition, cancelOwnedRun } from '../services/session/sessionOwnership';
import { createAgentTask, transitionAgentTask, type AgentTaskDefinition } from '../services/agent/runtime/pi/piTaskContract';
import { createTaskWorkspace } from '../services/agent/taskWorkspace';
import type { StoreApi } from '../services/agent/types';

afterEach(() => vi.restoreAllMocks());
const hash = 'a'.repeat(64);
type Guest = Parameters<typeof createCodeExecutionAdapter>[3];
const setup = async (customGuest?: Guest) => {
    let state = { sessionId: 's', settings: { runtimeAccessControl: { permissionMode: 'open', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } }, analysisCards: [], columnProfiles: [], csvData: {data: []}, datasetBundle: { relationshipSetId: 'rel', tables: [{ tableId: 't', datasetVersion: 'v1' }] } } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    const lease = beginRun(root, 'follow_up', 'run', 'turn');
    const store = scopeRunStore(root, lease);
    const definition: AgentTaskDefinition = { goal: 'Compute synthetic input', kind: 'artifact', requiredOutputs: [{ id: 'out', kind: 'artifact', required: true }],
        inputBindings: [{ tableId: 't', datasetVersion: 'v1', relationshipSetId: 'rel' }], protectedInvariants: [], capabilityGrants: [],
        scope: { digest: hash, intentDigest: hash, answer: { requiresEvidence: false, queries: [], unresolved: [], complete: true } } };
    let task = transitionAgentTask(store, createAgentTask(store, lease, definition), lease, 'inspecting');
    const workspace = createTaskWorkspace(store, task.taskId, { allowedPrefixes: ['/workspace/'] });
    const program = await workspace.write('/workspace/program.js', 'console.log("computed"); return JSON.parse(input.rows.content).reduce((a,b)=>a+b,0);', 0);
    const input = await workspace.write('/workspace/input.json', '[2,3,5]', 0);
    const adapter = createCodeExecutionAdapter(store, workspace, () => task, customGuest ?? {
        run: (code, inputJson, options) => executeQuickJsGuest({ generation: 1, code, inputJson, limits: resolveGuestLimits(options.limits) }, () => newQuickJSWASMModuleFromVariant(variant), options.onStarted),
        cancel() {}, dispose() {},
    });
    const issued = await adapter.issueGrant({ readPaths: [program.path, input.path], writePaths: ['/workspace/result.json'], expiresAt: Date.now() + 60000 });
    task = { ...task, capabilityGrants: [issued] };
    const context = { lease, toolCallId: 'host-call', stepId: 'host-step' };
    const request = { program: { path: program.path, revision: program.revision, sha256: program.sha256 },
        inputs: [{ name: 'rows', path: input.path, revision: input.revision, sha256: input.sha256 }],
        output: { path: '/workspace/result.json', expectedRevision: 0, format: 'json' as const } };
    return { root, store, lease, workspace, adapter, context, request, issued, setTask: (next: typeof task) => { task = next; }, getTask: () => task };
};

describe('host-owned code execution adapter', () => {
    it('executes the actual guest and stages output with host lineage and immutable digests', async () => {
        const s = await setup();
        const receipt = await s.adapter.run(s.request, s.context);
        expect(receipt.status, JSON.stringify(receipt)).toBe('succeeded');
        expect(receipt).toMatchObject({ taskId: s.getTask().taskId, runId: 'run', turnId: 'turn', toolCallId: 'host-call', stdout: 'computed\n', stderr: '' });
        expect(receipt.program!.sha256).toBe(s.request.program.sha256);
        expect(receipt.environmentDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.requestDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(s.workspace.read('/workspace/result.json').content).toBe('10');
        expect(s.adapter.inspect(receipt.jobId, s.context)).toEqual(receipt);
        expect(s.root.getState().datasetBundle!.tables[0].datasetVersion).toBe('v1');
    });
    it('rejects model lineage and a metadata-only or revoked grant', async () => {
        const s = await setup();
        expect((await s.adapter.run({ ...s.request, runId: 'forged' } as never, s.context)).reasonCode).toBe('validation_failed');
        s.setTask({ ...s.getTask(), capabilityGrants: [{ id: 'forged', digest: hash }] });
        expect((await s.adapter.run(s.request, s.context)).reasonCode).toBe('approval_invalid');
        s.setTask({ ...s.getTask(), capabilityGrants: [s.issued] });
        s.adapter.revoke(s.issued.id);
        expect((await s.adapter.run(s.request, s.context)).reasonCode).toBe('approval_invalid');
        expect(s.workspace.revision('/workspace/result.json')).toBe(0);
    });
});

const deferredGuest = () => {
    let complete!: (result: Awaited<ReturnType<NonNullable<Parameters<typeof createCodeExecutionAdapter>[3]>['run']>>) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const guest = { run: vi.fn((_code, _input, options) => { options.onStarted?.(); entered(); return new Promise<Awaited<ReturnType<NonNullable<Parameters<typeof createCodeExecutionAdapter>[3]>['run']>>>(resolve => { complete = resolve; }); }), cancel: vi.fn(), dispose: vi.fn() };
    const result = { generation: 17, status: 'completed' as const, code: 'guest_completed', outputJson: '10' };
    return { guest, started, resolve: (value = result) => complete(value) };
};

describe('dispatch and publication admission', () => {
    it('uses existing dispatcher and leaves Pi discovery gated until task-loop integration', async () => {
        const { handleExecutorAction } = await import('../services/agent/execution/executorAgent');
        const { createPiAppTools } = await import('../services/agent/runtime/pi/piAppTools');
        const s = await setup(); s.store.codeExecution = s.adapter; s.store.executionContext = s.context;
        const result = await handleExecutorAction({ type: 'tool_call', toolName: 'code.run', args: s.request }, s.store);
        expect(result.status).toBe('success');
        expect(result.artifacts?.codeExecution).toMatchObject({ status: 'succeeded', toolCallId: 'host-call' });
        expect(createPiAppTools(s.store, null).some(tool => tool.name === 'code_run')).toBe(false);
        const forged = await handleExecutorAction({ type: 'tool_call', toolName: 'code.inspect', args: { runId: 'forged' } }, s.store);
        expect(forged.status).toBe('blocked');
        s.adapter.dispose();
    });
    it.each(['program', 'inputs'] as const)('rejects stale/forged %s references before execution', async field => {
        const s = await setup();
        const request = structuredClone(s.request);
        if (field === 'program') request.program.revision++;
        else request.inputs[0].sha256 = hash;
        expect((await s.adapter.run(request, s.context)).reasonCode).toBe('workspace_conflict');
        expect(s.workspace.revision(s.request.output.path)).toBe(0); s.adapter.dispose();
    });
    it('returns real bounded errors and permits a revised program to run', async () => {
        const s = await setup();
        const failed = await s.workspace.write(s.request.program.path, 'console.error("bad row"); throw new TypeError("column missing");', 1);
        const result = await s.adapter.run({ ...s.request, program: failed }, s.context);
        // Tool requests cannot smuggle the complete host artifact as lineage.
        expect(result.reasonCode).toBe('validation_failed');
        const failure = await s.adapter.run({ ...s.request, program: { path: failed.path, revision: failed.revision, sha256: failed.sha256 } }, s.context);
        expect(failure).toMatchObject({ status: 'failed', error: { name: 'TypeError', message: 'column missing' }, stderr: 'bad row\n' });
        const repaired = await s.workspace.write(s.request.program.path, 'return 42;', 2);
        expect((await s.adapter.run({ ...s.request, program: { path: repaired.path, revision: repaired.revision, sha256: repaired.sha256 } }, s.context)).status).toBe('succeeded');
        s.adapter.dispose();
    });
    it('rejects missing authority, denied paths, expiry and capacity without publishing', async () => {
        const s = await setup();
        await expect(s.adapter.issueGrant({ readPaths: [], writePaths: ['/dataset/raw.csv'], expiresAt: Date.now()+1000 })).rejects.toThrow('approval_invalid');
        expect((await s.adapter.run({ ...s.request, output: { ...s.request.output, path: '/workspace/other.json' } }, s.context)).reasonCode).toBe('approval_invalid');
        const issued = await s.adapter.issueGrant({ readPaths: [s.request.program.path, s.request.inputs[0].path], writePaths: [s.request.output.path], limits: { codeBytes: 10 }, expiresAt: Date.now()+5000 });
        s.setTask({ ...s.getTask(), capabilityGrants: [issued] });
        expect((await s.adapter.run(s.request, s.context)).reasonCode).toBe('resource_limit');
        vi.spyOn(Date, 'now').mockReturnValue(Date.now()+10000);
        expect((await s.adapter.run(s.request, s.context)).reasonCode).toBe('approval_invalid');
        expect(s.workspace.revision(s.request.output.path)).toBe(0); s.adapter.dispose();
    });
    it('applies permission mode and explicit denies through the existing policy', async () => {
        const s = await setup(); const settings = s.root.getState().settings;
        s.root.setState({ settings: { ...settings, runtimeAccessControl: { permissionMode: 'balanced', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } } });
        expect((await s.adapter.run(s.request, s.context)).reasonCode).toBe('capability_unavailable');
        s.root.setState({ settings: { ...settings, runtimeAccessControl: { permissionMode: 'open', toolOverrides: { 'code.run': 'deny' }, workspaceRules: { deniedPathPrefixes: [] } } } });
        expect((await s.adapter.run(s.request, s.context)).reasonCode).toBe('capability_unavailable');
        s.root.setState({ settings: { ...settings, runtimeAccessControl: { permissionMode: 'open', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: ['/workspace'] } } } });
        expect((await s.adapter.run(s.request, s.context)).reasonCode).toBe('capability_unavailable'); s.adapter.dispose();
    });
});

describe('controlled execution races', () => {
    it.each(['version','program','input','output','task','grant','session','stop'] as const)('refuses late completion after %s changes', async change => {
        const d = deferredGuest(), s = await setup(d.guest);
        const pending = s.adapter.run(s.request, s.context); await d.started;
        const jobs = s.adapter.inspect(undefined, s.context) as Array<{ jobId: string; status: string }>;
        expect(jobs[0].status).toBe('running');
        expect((await s.adapter.run(s.request, s.context)).reasonCode).toBe('executor_busy');
        if (change === 'version') s.root.setState({ datasetBundle: { ...s.root.getState().datasetBundle!, tables: [{ ...s.root.getState().datasetBundle!.tables[0], datasetVersion: 'v2' }] } });
        if (change === 'program') await s.workspace.write(s.request.program.path, 'return 999;', 1);
        if (change === 'input') await s.workspace.write(s.request.inputs[0].path, '[999]', 1);
        if (change === 'output') await s.workspace.write(s.request.output.path, 'existing', 0);
        if (change === 'task') s.setTask({ ...s.getTask(), revision: 2 });
        if (change === 'grant') s.adapter.revoke(s.issued.id);
        if (change === 'session') { beginSessionTransition(s.root); s.root.setState({ sessionId: 'replacement' }); }
        if (change === 'stop') cancelOwnedRun(s.root);
        d.resolve(); const result = await pending;
        expect(result.status).not.toBe('succeeded'); expect(result.output).toBeUndefined();
        if (change !== 'session' && change !== 'stop') expect(s.workspace.revision(s.request.output.path)).toBe(change === 'output' ? 1 : 0);
        expect(() => s.adapter.inspect(jobs[0].jobId, { ...s.context, lease: { ...s.lease } })).toThrow(); s.adapter.dispose();
    });
    it('owns exact cancellation and records one terminal receipt after a late callback', async () => {
        const d = deferredGuest(), s = await setup(d.guest);
        const pending = s.adapter.run(s.request, s.context); await d.started;
        const [job] = s.adapter.inspect(undefined, s.context) as Array<{ jobId: string }>;
        expect(() => s.adapter.cancel('foreign-job', s.context)).toThrow();
        expect(s.adapter.cancel(job.jobId, s.context).cancelRequested).toBe(true);
        d.resolve(); const result = await pending;
        expect(result.status).toBe('cancelled'); expect(result.cancelRequested).toBe(true);
        expect(s.adapter.cancel(job.jobId, s.context)).toEqual(result);
        expect(s.adapter.inspect(job.jobId, s.context)).toEqual(result); s.adapter.dispose();
    });
    it('fences task changes during the output hash transaction', async () => {
        const s = await setup();
        const original = crypto.subtle.digest.bind(crypto.subtle);
        let release!: (value: ArrayBuffer) => void, entered!: () => void;
        const hashing = new Promise<void>(resolve => { entered = resolve; });
        vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
            if (new TextDecoder().decode(data as Uint8Array) === '10') { entered(); return new Promise(resolve => { release = resolve; }); }
            return original(algorithm, data);
        });
        const pending = s.adapter.run(s.request, s.context); await hashing;
        s.setTask({ ...s.getTask(), revision: 2 }); release(new ArrayBuffer(32));
        expect((await pending).reasonCode).toBe('approval_invalid');
        expect(s.workspace.revision(s.request.output.path)).toBe(0); s.adapter.dispose();
    });
    it('rejects malformed worker output and oversized forged logs', async () => {
        const d = deferredGuest(), s = await setup(d.guest);
        const pending = s.adapter.run(s.request, s.context); await d.started;
        d.resolve({ generation: 17, status: 'completed', code: 'guest_completed', outputJson: '10', stdout: 'x'.repeat(20000) } as never);
        expect((await pending).reasonCode).toBe('protocol_incompatible');
        expect(s.workspace.revision(s.request.output.path)).toBe(0); s.adapter.dispose();
    });
});

it('reads only issued immutable source ranges and binds their original digest', async () => {
    const { captureCsvSource } = await import('../services/data/immutableCsvSource');
    const s = await setup();
    const metadata = await captureCsvSource(s.store, new File(['a,b\n1,2'], 'synthetic.csv'));
    s.root.setState({ datasetBundle: { ...s.root.getState().datasetBundle!, source: { ...s.root.getState().datasetBundle!.source, inspection: metadata } } });
    const issued = await s.adapter.issueGrant({ readPaths: [s.request.program.path], writePaths: [s.request.output.path],
        sources: [{ sourceId: metadata.sourceId, sha256: metadata.sha256 }], expiresAt: Date.now()+5000 });
    s.setTask({ ...s.getTask(), capabilityGrants: [issued] });
    const program = await s.workspace.write(s.request.program.path, 'return input.raw.bytes.length;', 1);
    const request = { ...s.request, program: { path: program.path, revision: program.revision, sha256: program.sha256 }, inputs: [],
        sources: [{ name: 'raw', sourceId: metadata.sourceId, sha256: metadata.sha256, offset: 0, length: metadata.byteSize }] };
    const result = await s.adapter.run(request, s.context);
    expect(result.status).toBe('succeeded'); expect(s.workspace.read(s.request.output.path).content).toBe(String(metadata.byteSize));
    expect(result.sources?.[0].sha256).toBe(metadata.sha256);
    expect((await s.adapter.run({ ...request, sources: [{ ...request.sources[0], sourceId: 'model-forged' }], output: { ...request.output, expectedRevision: 1 } }, s.context)).reasonCode).toBe('approval_invalid');
    s.adapter.dispose();
});

it('rejects a forged worker generation through the actual client while a real owned job completes', async () => {
    const { createJavaScriptGuest } = await import('../services/sandbox/javascriptGuestClient');
    const s = await setup(); s.adapter.dispose();
    const fake = { onmessage: null as Worker['onmessage'], onerror: null as Worker['onerror'], terminate: vi.fn(), postMessage: vi.fn() };
    const client = createJavaScriptGuest(s.store, () => fake as unknown as Worker);
    const adapter = createCodeExecutionAdapter(s.store, s.workspace, s.getTask, client);
    const issued = await adapter.issueGrant({ readPaths: [s.request.program.path,s.request.inputs[0].path], writePaths: [s.request.output.path], expiresAt: Date.now()+5000 });
    s.setTask({ ...s.getTask(), capabilityGrants: [issued] });
    let posted!: () => void; const started = new Promise<void>(resolve => { posted = resolve; }); fake.postMessage.mockImplementation(posted);
    const pending = adapter.run(s.request, s.context); await started;
    const generation = fake.postMessage.mock.calls[0][0].generation;
    fake.onmessage!.call({} as Worker, { data: { generation: generation-1, status: 'completed', code: 'guest_completed', outputJson: '999' } } as MessageEvent);
    expect(s.workspace.revision(s.request.output.path)).toBe(0);
    fake.onmessage!.call({} as Worker, { data: { generation, status: 'completed', code: 'guest_completed', outputJson: '10', runId: 'model-forged', jobId: 'foreign' } } as MessageEvent);
    const result = await pending;
    expect(result.status).toBe('succeeded'); expect(result.runId).toBe('run'); expect(result.jobId).not.toBe('foreign');
    expect(s.workspace.read(s.request.output.path).content).toBe('10'); expect(fake.terminate).toHaveBeenCalledOnce(); adapter.dispose();
});

it('preserves host runtime allow overrides while explicit denies win', async () => {
    const s = await setup();
    const settings = s.root.getState().settings;
    s.root.setState({ settings: { ...settings, runtimeAccessControl: { permissionMode: 'balanced', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } } });
    const allowed = await s.adapter.run(s.request, s.context, undefined, { toolStage: 'analysis', allowOverrides: ['code.run'] });
    expect(allowed.status).toBe('succeeded');
    const denied = await s.adapter.run({ ...s.request, output: { ...s.request.output, expectedRevision: 1 } }, s.context, undefined,
        { toolStage: 'analysis', allowOverrides: ['code.run'], denyOverrides: ['code.run'] });
    expect(denied.reasonCode).toBe('capability_unavailable'); s.adapter.dispose();
});
