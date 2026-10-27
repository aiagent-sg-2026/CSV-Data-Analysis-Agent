import type { StoreApi } from '../types';
import { canonicalTaskPath, type TaskWorkspace } from '../taskWorkspace';
import { createTaskExecutionEnvelope, type AgentTaskContract, type TaskReference } from '../runtime/pi/piTaskContract';
import { assertRunActive, registerSessionResource, type ExecutionContext } from '../../session/sessionOwnership';
import { sha256Bytes } from '../../data/sourceDigest';
import { readSourceBytes, readSourceBytesBounded } from '../../data/immutableCsvSource';
import { createJavaScriptGuest } from '../../sandbox/javascriptGuestClient';
import { GUEST_LOG_BYTES, JAVASCRIPT_GUEST_PIN, resolveGuestLimits, type GuestOutcome } from '../../sandbox/javascriptGuestProtocol';
import { buildToolAvailabilityContext } from '../tools/toolGovernance';
import { buildBuiltinToolRegistry, resolveAllowedTools } from '../tools/toolRegistry';
import { normalizeRuntimeAccessControlSettings } from '../../runtimeAccessControl';
import { validateCodeRunRequest, type CodeArtifactRef, type CodeExecutionReceipt, type CodeGrantOptions, type CodeRunRequest, type CodePolicyContext } from './codeExecutionContract';
import { captureCodeTables, CODE_TABLE_LIMITS } from './codeTableInputs';
import { executeCodeStream, planCodeStream } from './codeStatefulStream';
import { createSourceRecordStream, SOURCE_STREAM_LIMITS, type SourceRecordStream } from './codeSourceRecordStream';
import type { CandidateSpillFactory } from '../../data/candidateSpill';
import { consumeEvaluationFault, recordEvaluationExecution } from '../../sandbox/evaluationFaults';

const encode = (text: string) => new TextEncoder().encode(text);
const digest = (value: unknown) => sha256Bytes(encode(JSON.stringify(value)));
const freeze = <T>(value: T): Readonly<T> => {
    const result = structuredClone(value);
    const visit = (item: unknown) => { if (item && typeof item === 'object') { Object.values(item).forEach(visit); Object.freeze(item); } };
    visit(result); return result;
};
const ref = ({ path, revision, sha256 }: CodeArtifactRef): CodeArtifactRef => ({ path, revision, sha256 });
type Guest = Pick<ReturnType<typeof createJavaScriptGuest>, 'run' | 'cancel' | 'dispose'>;

/** Host-only factory and grant issuer. No executable authority is read from model arguments or checkpoints. */
export const createCodeExecutionAdapter = (store: StoreApi, workspace: TaskWorkspace, getTask: () => AgentTaskContract,
    guest: Guest = createJavaScriptGuest(store), spillFactory?: CandidateSpillFactory) => {
    const context = store.executionContext;
    if (!context) { guest.dispose(); throw new Error('scope_revoked'); }
    const lease = context.lease, taskId = getTask().taskId;
    assertRunActive(store, lease);
    if (workspace.taskId !== taskId) { guest.dispose(); throw new Error('workspace_conflict'); }
    const executorGeneration = crypto.randomUUID();
    const grants = new Map<string, { reference: TaskReference; payload: {
        taskId: string; taskRevision: number; sessionId: string; sessionEpoch: number; namespaceId: string;
        executorGeneration: string; inputBindings: AgentTaskContract['inputBindings']; sources: NonNullable<CodeGrantOptions['sources']>;
        readPaths: string[]; writePaths: string[]; expiresAt: number; limits: ReturnType<typeof resolveGuestLimits>;
        tableIds: string[]; operations: string[]; egress: 'denied'; retention: 'session'; revocationRevision: number;
    } }>();
    const jobs = new Map<string, { receipt: Readonly<CodeExecutionReceipt>; controller: AbortController; grantId?: string }>();
    const sourceStreams = new Map<string, SourceRecordStream>();
    let disposed = false, suspended = false, active: string | undefined;
    const own = (execution = context) => {
        if (disposed || suspended || execution.lease !== lease || !execution.toolCallId || (lease.kind === 'initial_analysis' ? !execution.stepId : !lease.turnId)) throw new Error('scope_revoked');
        assertRunActive(store, lease);
        const task = getTask();
        if (task.taskId !== taskId || task.sessionId !== lease.scope.sessionId || !['inspecting', 'programming', 'executing', 'validating', 'verifying'].includes(task.status)) throw new Error('scope_revoked');
        return task;
    };
    const bindings = () => getTask().inputBindings.map(binding => {
        const table = store.getState().datasetBundle?.tables.find(item => item.tableId === binding.tableId);
        if (!table) throw new Error('input_version_changed');
        return { tableId: table.tableId, datasetVersion: table.datasetVersion, relationshipSetId: store.getState().datasetBundle!.relationshipSetId };
    });
    const policy = (tool: 'code.run' | 'code.inspect' | 'code.cancel', overrides: CodePolicyContext = {}) => {
        const state = store.getState();
        const registry = resolveAllowedTools(buildBuiltinToolRegistry(state.columnProfiles?.map(column => column.name) ?? []),
            buildToolAvailabilityContext(state, { ...overrides, hasCodeExecution: true }));
        if (!registry.decisions[tool]?.allowed) throw new Error('capability_unavailable');
    };
    const pathAllowed = (path: string) => {
        canonicalTaskPath(path);
        const denied = normalizeRuntimeAccessControlSettings(store.getState().settings.runtimeAccessControl).workspaceRules.deniedPathPrefixes;
        if (denied.some(prefix => prefix === '/' || path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) throw new Error('capability_unavailable');
    };
    const check = (grantId: string, execution: ExecutionContext, request?: CodeRunRequest, policyContext?: CodePolicyContext) => {
        const task = own(execution), issued = grants.get(grantId);
        if (!issued || !task.capabilityGrants.some(item => item.id === grantId && item.digest === issued.reference.digest)
            || issued.payload.taskRevision !== task.revision || issued.payload.expiresAt <= Date.now()) throw new Error('approval_invalid');
        const payload = issued.payload;
        if (JSON.stringify(bindings()) !== JSON.stringify(payload.inputBindings)) throw new Error('input_version_changed');
        for (const source of payload.sources) {
            const current = store.getState().datasetBundle?.source.inspection;
            if (current?.sourceId !== source.sourceId || current.sha256 !== source.sha256) throw new Error('input_version_changed');
        }
        if (request) {
            policy('code.run', policyContext);
            if (request.sources?.length || request.sourceRecords) pathAllowed('/dataset/source.bytes');
            if (request.sourceRecords && !payload.sources.some(source => source.sourceId === request.sourceRecords!.sourceId
                && source.sha256 === request.sourceRecords!.sha256)) throw new Error('approval_invalid');
            if (request.tables?.length) pathAllowed('/dataset/cleaned.csv');
            if (request.tables?.some(table => !payload.tableIds.includes(table.tableId))) throw new Error('approval_invalid');
            for (const item of [request.program, ...request.inputs]) {
                pathAllowed(item.path);
                if (!payload.readPaths.includes(item.path)) throw new Error('approval_invalid');
                const current = workspace.read(item.path);
                if (current.revision !== item.revision || current.sha256 !== item.sha256) throw new Error('workspace_conflict');
            }
            pathAllowed(request.output.path);
            if (!payload.writePaths.includes(request.output.path)) throw new Error('approval_invalid');
            if (workspace.revision(request.output.path) !== request.output.expectedRevision) throw new Error('workspace_conflict');
            if ((request.sources ?? []).some(source => !payload.sources.some(item => item.sourceId === source.sourceId && item.sha256 === source.sha256))) throw new Error('approval_invalid');
        }
        return issued;
    };
    const dispose = () => { disposed = true; jobs.forEach(job => job.controller.abort()); guest.dispose(); grants.clear();
        sourceStreams.forEach(stream => { void stream.dispose().catch(() => {}); }); sourceStreams.clear(); };
    const unregister = registerSessionResource(lease.scope, dispose);
    return {
        workspace, executorGeneration,
        async issueGrant(options: CodeGrantOptions): Promise<TaskReference> {
            const task = getTask(); assertRunActive(store, lease);
            if (grants.size >= 100) throw new Error('resource_limit');
            if (disposed || suspended || task.taskId !== taskId || task.sessionId !== lease.scope.sessionId
                || !Array.isArray(options.readPaths) || !Array.isArray(options.writePaths) || options.readPaths.length > 40 || options.writePaths.length > 20
                || !Number.isSafeInteger(options.expiresAt) || options.expiresAt <= Date.now() || options.expiresAt > Date.now() + 900000) throw new Error('approval_invalid');
            [...options.readPaths, ...options.writePaths].forEach(pathAllowed);
            if (options.writePaths.some(path => !path.startsWith('/workspace/') && path !== '/dataset/cleaned.csv')) throw new Error('approval_invalid');
            const limits = resolveGuestLimits({ outputBytes: 1024 * 1024, ...options.limits });
            const tableIds = [...(options.tableIds ?? [])];
            if (tableIds.length) pathAllowed('/dataset/cleaned.csv');
            if (tableIds.length > 20 || new Set(tableIds).size !== tableIds.length
                || tableIds.some(tableId => !task.inputBindings.some(binding => binding.tableId === tableId))) throw new Error('approval_invalid');
            const sources = structuredClone(options.sources ?? []);
            if (sources.length) pathAllowed('/dataset/source.bytes');
            if (sources.length > 20 || sources.some(source => {
                const current = store.getState().datasetBundle?.source.inspection;
                return current?.sourceId !== source.sourceId || current.sha256 !== source.sha256
                    || readSourceBytes(store, source.sourceId, 0, 0).source.sha256 !== source.sha256;
            })) throw new Error('input_version_changed');
            const payload = { taskId, taskRevision: task.revision, sessionId: lease.scope.sessionId, sessionEpoch: lease.scope.epoch,
                namespaceId: workspace.namespaceId, executorGeneration, inputBindings: bindings(), sources,
                readPaths: [...options.readPaths], writePaths: [...options.writePaths], tableIds, expiresAt: options.expiresAt, limits,
                operations: ['code.run', 'code.inspect', 'code.cancel'], egress: 'denied' as const, retention: 'session' as const, revocationRevision: 0 };
            const reference = Object.freeze({ id: `code-grant-${crypto.randomUUID()}`, digest: await digest(payload) });
            assertRunActive(store, lease);
            if (disposed || getTask().taskId !== taskId || getTask().revision !== task.revision || JSON.stringify(bindings()) !== JSON.stringify(payload.inputBindings)) throw new Error('scope_revoked');
            grants.set(reference.id, { reference, payload: freeze(payload) });
            return reference;
        },
        revoke(grantId: string) {
            grants.delete(grantId);
            jobs.forEach(job => { if (job.grantId === grantId) job.controller.abort(); });
        },
        async run(raw: CodeRunRequest, execution: ExecutionContext, signal?: AbortSignal, policyContext: CodePolicyContext = {}): Promise<Readonly<CodeExecutionReceipt>> {
            const jobId = crypto.randomUUID(), startedAt = Date.now();
            let receipt: Readonly<CodeExecutionReceipt> = freeze({ jobId, taskId, taskRevision: getTask().revision,
                sessionId: lease.scope.sessionId, sessionEpoch: lease.scope.epoch, runId: lease.runId, turnId: lease.turnId,
                toolCallId: execution.toolCallId, stepId: execution.stepId, executorGeneration, status: 'preparing', reasonCode: 'preparing', retry: 'none',
                inputBindings: [], stdout: '', stderr: '', logsTruncated: false, startedAt });
            const controller = new AbortController();
            const publish = (patch: Partial<CodeExecutionReceipt>) => {
                receipt = freeze({ ...(jobs.get(jobId)?.receipt ?? receipt), ...patch });
                const job = jobs.get(jobId); if (job) job.receipt = receipt;
                return receipt;
            };
            const finish = (status: CodeExecutionReceipt['status'], reasonCode: string, retry: CodeExecutionReceipt['retry']) => {
                const result = publish({ status, reasonCode, retry, finishedAt: Date.now(), durationMs: Date.now() - startedAt });
                recordEvaluationExecution(store, result);
                return result;
            };
            let issued: ReturnType<typeof check> | undefined;
            try {
                own(execution);
                if (!validateCodeRunRequest(raw)) throw new Error('validation_failed');
                const request = structuredClone(raw);
                const capturedPolicy = freeze(policyContext);
                if (active) return finish('blocked', 'executor_busy', 'wait');
                if (jobs.size >= 40) return finish('blocked', 'resource_limit', 'none');
                issued = [...grants.values()].reverse().find(grant => getTask().capabilityGrants.some(item => item.id === grant.reference.id && item.digest === grant.reference.digest));
                if (!issued) throw new Error('approval_invalid');
                check(issued.reference.id, execution, request, capturedPolicy);
                if (!request.program.path.endsWith('.js')) throw new Error('capability_unavailable');
                jobs.set(jobId, { receipt, controller, grantId: issued.reference.id }); active = jobId;
                const workspaceRevision = await digest({ program: request.program, inputs: request.inputs, sources: request.sources,
                    tables: request.tables, mode: request.mode, stream: request.stream, sourceRecords: request.sourceRecords, output: request.output });
                check(issued.reference.id, execution, request, capturedPolicy);
                const envelope = createTaskExecutionEnvelope(store, getTask(), execution, { executorId: 'browser-quickjs', executorGeneration, workspaceRevision, grantRef: issued.reference.id });
                const inputs: Record<string, unknown> = Object.create(null);
                for (const input of request.inputs) inputs[input.name] = { ...ref(input), content: workspace.read(input.path, input.revision).content };
                for (const source of request.sources ?? []) {
                    const range = await readSourceBytesBounded(store, source.sourceId, source.offset, source.length);
                    check(issued.reference.id, execution, request, capturedPolicy);
                    if (range.bytes.length !== source.length) throw new Error('validation_failed');
                    inputs[source.name] = range;
                }
                const abort = AbortSignal.any([lease.signal, controller.signal, ...(signal ? [signal] : [])]);
                let expectedOutputRevision = request.output.expectedRevision;
                let executionDeadline: number | undefined;
                const baseCurrent = () => {
                    if (abort.aborted) throw new Error('scope_revoked');
                    if (executionDeadline !== undefined && Date.now() >= executionDeadline) throw new Error('execution_deadline');
                    check(issued!.reference.id, execution, { ...request, output: { ...request.output, expectedRevision: expectedOutputRevision } }, capturedPolicy);
                };
                if (request.mode === 'row_map') throw new Error('execution_mode_unavailable');
                const mode = request.mode ?? (request.tables?.length ? 'whole_table' : 'artifact_json');
                if (request.mode === 'stateful_stream' && request.output.format !== 'json') throw new Error('validation_failed');
                const tableSnapshot = await captureCodeTables(store, request.tables ?? [], envelope.inputBindings, issued.payload.limits.inputBytes, baseCurrent);
                Object.assign(inputs, tableSnapshot.tables);
                const current = () => { baseCurrent(); tableSnapshot.check(); };
                current();
                const streamSteps = request.stream ? planCodeStream(request.stream, tableSnapshot.tables) : undefined;
                const inputJson = JSON.stringify(inputs);
                if (encode(inputJson).length > issued.payload.limits.inputBytes) throw new Error('resource_limit');
                const inputDigest = await digest(inputs);
                const evaluationFault = consumeEvaluationFault(store);
                const environment = { protocol: 1, runtime: JAVASCRIPT_GUEST_PIN, wasmSha256: '105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232',
                    mode, semantics: 1, tableLimits: CODE_TABLE_LIMITS, egress: 'denied', limits: issued.payload.limits, logBytes: GUEST_LOG_BYTES,
                    ...(evaluationFault ? { evaluationFault } : {}) };
                const environmentDigest = await digest(environment);
                const requestDigest = await digest({ taskId, taskRevision: envelope.taskRevision, scope: lease.scope, runId: lease.runId,
                    toolCallId: execution.toolCallId, executorGeneration, workspaceRevision, grant: issued.reference, program: request.program,
                    inputDigest, environmentDigest, policy: capturedPolicy, mode, stream: request.stream, tables: request.tables, output: request.output });
                publish({ program: ref(request.program), inputs: request.inputs, sources: request.sources, outputContract: request.output, runRequest: request,
                    limits: issued.payload.limits, mode, coverage: tableSnapshot.coverage, checkpoints: [], workerGenerations: [],
                    inputDigest, environmentDigest, environment, requestDigest, inputBindings: envelope.inputBindings, grant: issued.reference });
                current();
                const deadline = Date.now() + (mode === 'source_records' ? SOURCE_STREAM_LIMITS.activeMs : issued.payload.limits.timeoutMs);
                executionDeadline = deadline;
                const runGuest = async (json: string): Promise<GuestOutcome> => {
                    current();
                    const remaining = Math.min(issued!.payload.limits.timeoutMs, deadline - Date.now());
                    if (remaining < 1) throw new Error('execution_deadline');
                    const result = await guest.run(workspace.read(request.program.path, request.program.revision).content, json, {
                        limits: { ...issued!.payload.limits, timeoutMs: remaining }, signal: abort,
                        ...(evaluationFault ? { evaluationFault } : {}),
                        onStarted: () => { current(); publish({ status: 'running', reasonCode: 'executing' }); },
                    });
                    if (abort.aborted || result.status === 'cancelled') throw new Error('scope_revoked');
                    current();
                    if (!Number.isSafeInteger(result.generation) || result.generation < 1 || typeof result.code !== 'string' || result.code.length > 80
                    || !['completed','failed','capacity','timeout','unavailable'].includes(result.status)
                    || (result.status === 'completed' && result.code !== 'guest_completed')
                    || (result.stdout !== undefined && (typeof result.stdout !== 'string' || encode(result.stdout).length > GUEST_LOG_BYTES))
                    || (result.stderr !== undefined && (typeof result.stderr !== 'string' || encode(result.stderr).length > GUEST_LOG_BYTES))
                    || (result.logsTruncated !== undefined && typeof result.logsTruncated !== 'boolean')
                    || (result.error !== undefined && (typeof result.error.name !== 'string' || encode(result.error.name).length > 80 || typeof result.error.message !== 'string' || encode(result.error.message).length > 2048))) throw new Error('protocol_incompatible');
                    if (result.status === 'completed' && (typeof result.outputJson !== 'string' || encode(result.outputJson).length > issued!.payload.limits.outputBytes)) throw new Error('protocol_incompatible');
                    const appendLog = (previous: string, next: string) => {
                        const text = previous + next, bytes = encode(text);
                        if (bytes.length <= GUEST_LOG_BYTES) return {text,truncated:false};
                        let bounded = new TextDecoder().decode(bytes.subarray(0,GUEST_LOG_BYTES));
                        while (encode(bounded).length > GUEST_LOG_BYTES) bounded=bounded.slice(0,-1);
                        return {text:bounded,truncated:true};
                    };
                    const stdout=appendLog(receipt.stdout,result.stdout??''), stderr=appendLog(receipt.stderr,result.stderr??'');
                    publish({ workerGeneration: result.generation, workerGenerations: [...(receipt.workerGenerations??[]),result.generation].slice(mode === 'source_records' ? -20 : 0),
                        stdout:stdout.text, stderr:stderr.text, logsTruncated:receipt.logsTruncated||Boolean(result.logsTruncated)||stdout.truncated||stderr.truncated,error:result.error });
                    return result;
                };
                let result: GuestOutcome;
                if (request.sourceRecords) {
                    const streamKey = await digest({ taskId, revision: envelope.taskRevision, workspaceRevision, source: request.sourceRecords }); current();
                    let stream = sourceStreams.get(streamKey);
                    if (!stream) {
                        if (sourceStreams.size >= 3) throw new Error('resource_limit');
                        stream = await createSourceRecordStream(store, request.sourceRecords,
                            { taskId, revision: envelope.taskRevision, program: request.program, workspaceRevision }, current, spillFactory);
                        try { current(); sourceStreams.set(streamKey, stream); }
                        catch (error) { await stream.dispose().catch(() => {}); throw error; }
                    }
                    const manifest = await stream.execute(runGuest, current); current();
                    publish({ sourceStream: { manifest, metrics: stream.metrics } });
                    result = { generation: receipt.workerGeneration ?? 1, status: 'completed', code: 'guest_completed', outputJson: JSON.stringify(manifest) };
                } else result = request.stream && streamSteps ? await executeCodeStream(request.stream,streamSteps,inputs,issued.payload.limits,
                    runGuest,current,checkpoint=>publish({checkpoints:[...(receipt.checkpoints??[]),checkpoint]}),{requestDigest,jobId}) : await runGuest(inputJson);
                current();
                if (result.code === 'guest_busy') return finish('blocked', 'executor_busy', 'wait');
                if (result.status !== 'completed') return finish(result.status === 'unavailable' || result.status === 'capacity' ? 'blocked' : 'failed',
                    result.status === 'capacity' ? 'resource_limit' : result.status === 'unavailable' ? 'capability_unavailable' : result.code, 'repair');
                if (typeof result.outputJson !== 'string' || encode(result.outputJson).length > issued.payload.limits.outputBytes) throw new Error('protocol_incompatible');
                let parsed: unknown;
                try { parsed = JSON.parse(result.outputJson); } catch { throw new Error('protocol_incompatible'); }
                if (request.output.format === 'text' && typeof parsed !== 'string') throw new Error('validation_failed');
                const content = request.output.format === 'text' ? parsed as string : result.outputJson;
                const output = await workspace.write(request.output.path, content, request.output.expectedRevision, current);
                // Publication rechecks the revision this job just wrote, rather than its pre-write CAS value.
                expectedOutputRevision = output.revision;
                // The transaction admitted this completed output before its deadline. Terminal inspection
                // must still fence ownership/bindings, but cannot retroactively time out that commit.
                executionDeadline = undefined;
                current();
                publish({ output: { ...ref(output), artifactId: output.artifactId, byteSize: output.byteSize },
                    coverage: tableSnapshot.coverage.map(table=>({...table,deliveredRows:table.rowCount,complete:true})) });
                return finish('succeeded', 'execution_completed', 'none');
            } catch (error) {
                const message = error instanceof Error ? error.message : '';
                const reason = raw?.mode === 'source_records' && error instanceof DOMException && error.name === 'QuotaExceededError' ? 'spill_storage_quota'
                    : message.startsWith('source_stream_') || message.startsWith('source_record_') || message.startsWith('spill_') ? message : ['scope_revoked','input_version_changed','workspace_conflict','capability_unavailable','approval_invalid','validation_failed','resource_limit','protocol_incompatible',
                    'complete_input_unavailable','execution_mode_unavailable','partition_not_contiguous','execution_deadline'].includes(message) ? message : 'execution_failed';
                return finish(controller.signal.aborted || lease.signal.aborted || reason === 'scope_revoked' ? 'cancelled' : 'blocked', reason,
                    reason === 'scope_revoked' || reason === 'input_version_changed' ? 'new_scope' : 'repair');
            } finally { if (active === jobId) active = undefined; }
        },
        sourceSpill(jobId: string, execution: ExecutionContext, policyContext?: CodePolicyContext) {
            const job = jobs.get(jobId), receipt = job?.receipt;
            const manifest = receipt?.sourceStream?.manifest;
            const stream = manifest && [...sourceStreams.values()].find(value => value.generation === manifest.generation);
            if (!job?.grantId || receipt?.status !== 'succeeded' || receipt.mode !== 'source_records' || !manifest || !stream) throw new Error('candidate_spill_unavailable');
            const current = () => {
                policy('code.inspect', policyContext); check(job.grantId!, execution, undefined, policyContext);
                pathAllowed('/dataset/source.bytes');
                for (const artifact of [receipt.program!, receipt.output!]) {
                    pathAllowed(artifact.path); const actual = workspace.read(artifact.path);
                    if (actual.revision !== artifact.revision || actual.sha256 !== artifact.sha256) throw new Error('workspace_conflict');
                }
            };
            current();
            return Object.freeze({ manifest,
                inspectRows: (invocation: () => void) => stream.inspectRows(() => { current(); invocation(); }),
                readChunk: (sequence: number, invocation: () => void) => stream.readChunk(sequence, () => { current(); invocation(); }),
            });
        },
        assertCommitEligible(jobId: string, execution: ExecutionContext, policyContext?: CodePolicyContext) {
            policy('code.run', policyContext);
            const job = jobs.get(jobId);
            if (!job?.grantId || job.receipt.status !== 'succeeded' || job.receipt.mode === 'source_records') throw new Error('approval_invalid');
            check(job.grantId, execution, undefined, policyContext);
        },
        captureCommitCheck(jobId: string, execution: ExecutionContext, policyContext?: CodePolicyContext) {
            policy('code.run', policyContext);
            const job = jobs.get(jobId);
            if (!job?.grantId || job.receipt.status !== 'succeeded' || job.receipt.mode === 'source_records') throw new Error('approval_invalid');
            const issued = check(job.grantId, execution, undefined, policyContext), capturedTask = getTask();
            // Retained grant data permits exact commit checks only. The guest and old execution API stay retired.
            return (target: StoreApi, fresh: ExecutionContext) => {
                assertRunActive(target, fresh.lease);
                const task = target.piTask?.snapshot;
                if (disposed || !task || fresh.lease.scope.sessionId !== lease.scope.sessionId || fresh.lease.scope.epoch !== lease.scope.epoch
                    || task.taskId !== capturedTask.taskId || task.revision !== capturedTask.revision
                    || grants.get(job.grantId!) !== issued || issued.payload.expiresAt <= Date.now()
                    || !task.capabilityGrants.some(g => g.id === issued.reference.id && g.digest === issued.reference.digest)) throw new Error('approval_invalid');
                const state = target.getState();
                if (issued.payload.inputBindings.some(b => !state.datasetBundle?.tables.some(t => t.tableId === b.tableId && t.datasetVersion === b.datasetVersion)
                    || state.datasetBundle.relationshipSetId !== b.relationshipSetId)) throw new Error('input_version_changed');
                for (const source of issued.payload.sources) if (state.datasetBundle?.source.inspection?.sourceId !== source.sourceId
                    || state.datasetBundle.source.inspection.sha256 !== source.sha256) throw new Error('input_version_changed');
            };
        },
        suspend() {
            if (active) throw new Error('execution_still_active');
            suspended = true; guest.dispose();
        },
        inspect(jobId: string | undefined, execution: ExecutionContext, policyContext?: CodePolicyContext) {
            own(execution); policy('code.inspect', policyContext);
            if (jobId === undefined) return [...jobs.values()].filter(job => job.receipt.taskRevision === getTask().revision).slice(-20).map(job => job.receipt);
            const job = jobs.get(jobId); if (!job || job.receipt.taskRevision !== getTask().revision) throw new Error('scope_revoked');
            return job.receipt;
        },
        cancel(jobId: string, execution: ExecutionContext, policyContext?: CodePolicyContext) {
            own(execution); policy('code.cancel', policyContext);
            const job = jobs.get(jobId); if (!job || job.receipt.taskRevision !== getTask().revision) throw new Error('scope_revoked');
            if (['preparing', 'running'].includes(job.receipt.status)) {
                job.receipt = freeze({ ...job.receipt, cancelRequested: true }); job.controller.abort();
            }
            return job.receipt;
        },
        dispose() { dispose(); unregister(); },
    };
};
