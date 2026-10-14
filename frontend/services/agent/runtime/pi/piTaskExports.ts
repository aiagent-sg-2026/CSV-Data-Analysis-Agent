import { strToU8, zipSync } from 'fflate';
import { unparse } from 'papaparse';
import type { StoreApi } from '../../types';
import type { TaskWorkspace } from '../../taskWorkspace';
import type { CodeExecutionReceipt } from '../../execution/codeExecutionContract';
import type { ComputationEvidenceReceipt } from '../../execution/computationEvidence';
import type { AgentTaskContract } from './piTaskContract';
import type { QueryExecutionReceipt, QueryGroundingVerdict } from './queryEvidence';
import { ownsSessionScope, ownsRun, canCommitRun, rootStore, registerSessionResource, type RunLease } from '../../../session/sessionOwnership';
import { RETENTION_POLICY } from '../../../data/datasetRecoveryContract';
import { sha256Bytes } from '../../../data/sourceDigest';
import { captureCodeTables } from '../../execution/codeTableInputs';
import { getCurrentAnalysisDatasetVersion } from '../../artifactProvenance';
import { currentRecoveryMaterial } from '../../../data/datasetReplay';
import { validateRecoveryMaterial } from '../../../data/datasetRecovery';
import { readExactCommit } from '../../../data/datasetRecoveryActions';
import { getStorageDatabase, type StorageDatabase } from '../../../storageService';
import type { DatasetCommitReference } from '../../../../types/datasetCommit';

type Custody = {
    lease: RunLease; workspace: TaskWorkspace; taskId: string; receipts: Readonly<CodeExecutionReceipt>[]; retire?: () => void;
    terminal?: { task: AgentTaskContract; expiresAt: number; verdict?: QueryGroundingVerdict;
        queries: QueryExecutionReceipt[]; computations: ComputationEvidenceReceipt[]; commit?: DatasetCommitReference };
};
const ports = new WeakMap<StoreApi['getState'], Custody>();
const encode = (v: unknown) => strToU8(JSON.stringify(v, null, 2));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Host custody survives terminal release, but never task/session replacement or reload. */
export const registerTaskExports = (store: StoreApi, lease: RunLease, workspace: TaskWorkspace, taskId: string) => {
    const key = rootStore(store).getState, prior = ports.get(key);
    prior?.retire?.();
    const port: Custody = { lease, workspace, taskId, receipts: prior?.taskId === taskId ? prior.receipts : [] };
    ports.set(key, port);
    port.retire = registerSessionResource(lease.scope, () => {
        if (ports.get(key) === port) ports.delete(key);
        port.receipts.length = 0; port.terminal = undefined;
    });
    return (receipt: Readonly<CodeExecutionReceipt>) => {
        if (canCommitRun(store, lease) && ports.get(key) === port) port.receipts.push(receipt);
    };
};

/** Called with actual runtime admission, never with a saved UI projection. */
export const sealTaskExports = (store: StoreApi, task: AgentTaskContract, verdict?: QueryGroundingVerdict,
    queries: QueryExecutionReceipt[] = [], computations: ComputationEvidenceReceipt[] = []) => {
    const port = ports.get(rootStore(store).getState);
    if (!port || !ownsRun(store, port.lease) || port.taskId !== task.taskId) return;
    port.terminal = { task: structuredClone(task), expiresAt: Date.now() + RETENTION_POLICY.lifetimeMs,
        commit: store.getState().datasetBundle?.acceptedCommit ? structuredClone(store.getState().datasetBundle!.acceptedCommit!) : undefined,
        verdict: verdict ? structuredClone(verdict) : undefined,
        queries: queries.filter(r => verdict?.queryIds.includes(r.queryId)).map(r => structuredClone(r)),
        computations: computations.filter(r => verdict?.computationIds?.includes(r.evidenceId)).map(r => structuredClone(r)) };
};

const currentPort = (store: StoreApi, taskId: string): Custody & { terminal: NonNullable<Custody['terminal']> } => {
    const port = ports.get(rootStore(store).getState), state = store.getState(), task = state.activeAgentTask;
    if (!port?.terminal || port.taskId !== taskId || !ownsSessionScope(store, port.lease.scope)
        || task?.taskId !== taskId || task.sessionId !== port.lease.scope.sessionId) throw new Error('task_export_custody_unavailable');
    const captured = port.terminal.task;
    if (task.status !== 'completed' || captured.status !== 'completed' || state.activeExecution
        || task.revision !== captured.revision || !same(task.scope, captured.scope)) throw new Error('task_export_requires_current_completed_task');
    if (Date.now() >= port.terminal.expiresAt) throw new Error('task_export_expired');
    if (!same(port.terminal.commit, state.datasetBundle?.acceptedCommit)) throw new Error('task_export_commit_changed');
    if (state.datasetCommitBindingStatus && state.datasetCommitBindingStatus !== 'ready') throw new Error('task_export_binding_unavailable');
    for (const b of captured.inputBindings) {
        if (!state.datasetBundle?.tables.some(t => t.tableId === b.tableId && t.datasetVersion === b.datasetVersion)
            || state.datasetBundle.relationshipSetId !== b.relationshipSetId) throw new Error('task_export_input_version_changed');
    }
    if (port.terminal.queries.some(r => r.query.datasetVersion !== getCurrentAnalysisDatasetVersion(state))) throw new Error('task_export_query_version_changed');
    return port as Custody & { terminal: NonNullable<Custody['terminal']> };
};

const selectedExecutions = (port: Custody) => port.receipts.filter(r => r.status === 'succeeded' && r.output && r.program
    && r.taskId === port.taskId && r.taskRevision === port.terminal!.task.revision && r.runId === port.lease.runId);

export const inspectTaskExport = (store: StoreApi, taskId: string) => {
    try {
        const port = currentPort(store, taskId);
        if (!selectedExecutions(port).length && !port.terminal.queries.length && !port.terminal.computations.length) throw new Error('task_export_no_completed_outputs');
        return { available: true, reason: 'Download actual outputs and provenance. File completeness does not certify facts.' };
    } catch (error) { return { available: false, reason: error instanceof Error ? error.message : 'task_export_unavailable' }; }
};

const describeJson = (text: string) => {
    try {
        const value: unknown = JSON.parse(text), rows = Array.isArray(value) ? value : [value];
        const objects = rows.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object' && !Array.isArray(r)));
        const columns = [...new Set(objects.flatMap(r => Object.keys(r)))];
        return { shape: Array.isArray(value) ? 'array' : typeof value, rowCount: rows.length,
            columns: columns.map(name => ({ name, observedTypes: [...new Set(objects.map(r =>
                r[name] === null ? 'null' : Array.isArray(r[name]) ? 'array' : typeof r[name]))].sort() })) };
    } catch { return { shape: 'text', rowCount: null, columns: [] }; }
};

/** No model tool exposes this port. The user downloads only captured, hash-verified local bytes. */
export const buildTaskExport = async (store: StoreApi, taskId: string,
    dependencies: { database?: () => Promise<StorageDatabase> } = {}) => {
    const port = currentPort(store, taskId), terminal = port.terminal, task = terminal.task;
    const check = () => { if (currentPort(store, taskId) !== port) throw new Error('task_export_custody_replaced'); };
    const files: Record<string, Uint8Array> = {};
    const fileMetadata: Array<{ path: string; sha256: string; byteSize: number }> = [];
    let total = 0;
    const add = async (path: string, bytes: Uint8Array) => {
        check(); total += bytes.length;
        if (bytes.length > RETENTION_POLICY.artifactBytes || total > RETENTION_POLICY.totalBytes) throw new Error('task_export_quota');
        const sha256 = await sha256Bytes(bytes); check(); files[path] = bytes;
        fileMetadata.push({ path, sha256, byteSize: bytes.length });
    };
    const addCsv = async (path: string, value: unknown, columns?: string[]) => {
        const rows = Array.isArray(value) ? value : [value];
        if (!rows.every(r => r && typeof r === 'object' && !Array.isArray(r)
            && Object.values(r).every(v => v === null || ['string', 'number', 'boolean'].includes(typeof v)))) return;
        const fields = columns ?? [...new Set(rows.flatMap(r => Object.keys(r)))];
        if (fields.length) await add(path, strToU8(unparse({ fields, data: rows.map(r => fields.map(f => r[f])) })));
    };
    const read = async (ref: { path: string; revision: number; sha256: string }) => {
        check(); const artifact = port.workspace.read(ref.path, ref.revision), bytes = strToU8(artifact.content);
        if (artifact.sha256 !== ref.sha256 || bytes.length !== artifact.byteSize || await sha256Bytes(bytes) !== ref.sha256) throw new Error('task_export_digest_mismatch');
        check(); return artifact;
    };
    const executions = [];
    for (const [i, receipt] of selectedExecutions(port).entries()) {
        for (const b of receipt.inputBindings) if (!task.inputBindings.some(input => same(input, b))) throw new Error('task_export_execution_binding_mismatch');
        if (receipt.sessionId !== port.lease.scope.sessionId || receipt.sessionEpoch !== port.lease.scope.epoch) throw new Error('task_export_execution_scope_mismatch');
        if (!receipt.environment || !receipt.environmentDigest || !receipt.outputContract) throw new Error('task_export_execution_metadata_missing');
        if (await sha256Bytes(strToU8(JSON.stringify(receipt.environment))) !== receipt.environmentDigest) throw new Error('task_export_environment_digest_mismatch');
        check();
        if (receipt.coverage?.length) {
            const captured = await captureCodeTables(store, receipt.coverage.map(c => ({name:c.name,tableId:c.tableId})), receipt.inputBindings, 8*1024*1024, check);
            if (captured.coverage.some((c,n) => c.sha256 !== receipt.coverage![n].sha256 || c.rowCount !== receipt.coverage![n].rowCount)) throw new Error('task_export_input_digest_changed');
            captured.check();
        }
        const output = await read(receipt.output!), program = await read(receipt.program!);
        const outputPath = `executions/${i}/output.${receipt.outputContract?.format === 'text' ? 'txt' : 'json'}`;
        await add(outputPath, strToU8(output.content)); await add(`executions/${i}/program.js`, strToU8(program.content));
        if (receipt.outputContract?.format === 'json') await addCsv(`executions/${i}/table.csv`, JSON.parse(output.content));
        for (const [n, input] of (receipt.inputs ?? []).entries()) await add(`executions/${i}/inputs/${n}.txt`, strToU8((await read(input)).content));
        const { grant: _grant, stdout: _stdout, stderr: _stderr, ...description } = receipt;
        executions.push({ ...description, outputPath, schema: describeJson(output.content),
            grain: { status: 'not_semantically_validated', note: 'Observed JSON structure does not establish business grain.' } });
    }
    const queries = terminal.queries, computations = terminal.computations, verdict = terminal.verdict;
    let acceptedDataset: Record<string, unknown> | undefined;
    if (terminal.commit) {
        const material = currentRecoveryMaterial(store, terminal.commit.commitId);
        if (!material) acceptedDataset = { status: 'unavailable', reference: terminal.commit, reason: 'Verified live row material is unavailable; no reconstruction is performed by export.' };
        else {
            const db = await (dependencies.database ?? getStorageDatabase)(); check();
            const marker = await readExactCommit(db, terminal.commit); check();
            const verified = await validateRecoveryMaterial(marker, material); check();
            if (!same(marker.outputBindings, task.inputBindings)) throw new Error('task_export_commit_binding_mismatch');
            const captured = await captureCodeTables(store, marker.bundle.tables.map(t => ({name:t.name,tableId:t.tableId})), task.inputBindings, 8*1024*1024, check);
            if (verified.output.tables.some(t => !same(captured.tables[t.name]?.rows, t.rows))) throw new Error('task_export_live_rows_mismatch');
            captured.check();
            await add('accepted/output.json', strToU8(material.outputText));
            await add('accepted/program.js', strToU8(marker.program.content));
            for (const [n, ref] of verified.manifest.request.inputs.entries()) {
                const content = material.dependencies[ref.name];
                if (typeof content !== 'string' || await sha256Bytes(strToU8(content)) !== ref.sha256) throw new Error('task_export_dependency_unavailable');
                await add(`accepted/inputs/${n}.txt`, strToU8(content));
            }
            for (const [i,t] of verified.output.tables.entries()) {
                await add(`accepted/tables/${i}.json`, encode(t.rows)); await addCsv(`accepted/tables/${i}.csv`, t.rows, t.schema.map(c=>c.name));
            }
            acceptedDataset = { status: 'independently_validated', reference: terminal.commit, program: marker.program,
                environment: marker.environment, validation: marker.validation, inputCoverage: verified.manifest.coverage,
                inputs: verified.manifest.request.inputs.map((ref,n)=>({...ref,exportPath:`accepted/inputs/${n}.txt`})),
                grainAndScope: verified.manifest.validationBinding.contract, outputBindings: marker.outputBindings,
                tables: verified.output.tables.map(t => ({name:t.name,schema:t.schema,rowCount:t.rowCount})),
                relationships: verified.output.relationships, excludedRows: verified.output.excludedRows };
            // Program bytes belong in their digest-listed file, rather than a second inline copy.
            acceptedDataset.program = {path:marker.program.path,revision:marker.program.revision,sha256:marker.program.sha256};
        }
    }
    const ids = [...queries.map(r => r.queryId), ...computations.map(r => r.evidenceId)];
    // Different answer roles may legitimately select the same executed receipt.
    const expected = [...new Set([...(verdict?.queryIds ?? []), ...(verdict?.computationIds ?? [])])];
    const admitted = verdict?.status === 'accepted';
    if (admitted && (!expected.length || new Set(ids).size !== ids.length || ids.length !== expected.length
        || expected.some(id => !ids.includes(id)))) throw new Error('task_export_evidence_incomplete');
    for (const r of [...queries, ...computations]) {
        if (r.taskId !== taskId || r.taskRevision !== task.revision || r.answerScopeDigest !== task.scope.digest
            || r.runId !== port.lease.runId) throw new Error('task_export_evidence_scope_mismatch');
    }
    for (const [i, r] of queries.entries()) {
        if (r.semanticValidation !== 'passed' || r.scope.sessionId !== port.lease.scope.sessionId
            || r.scope.epoch !== port.lease.scope.epoch || r.turnId !== port.lease.turnId) throw new Error('task_export_query_unverified');
        await add(`evidence/query-${i}.json`, encode(r.query.result));
        await addCsv(`evidence/query-${i}.csv`, r.query.result.rows, r.query.result.selectedColumns);
    }
    for (const [i, r] of computations.entries()) await add(`evidence/computation-${i}.json`, encode(r.result));
    if (computations.some(r => r.sessionId !== port.lease.scope.sessionId || r.sessionEpoch !== port.lease.scope.epoch
        || r.turnId !== port.lease.turnId || !executions.some(e => e.jobId === r.execution.jobId))) throw new Error('task_export_computation_unverified');
    if (!executions.length && !ids.length) throw new Error('task_export_no_completed_outputs');
    const manifest = { version: 1, purpose: 'inspectable_task_outputs', task: { taskId, revision: task.revision, status: task.status,
        kind: task.kind, scope: task.scope, inputBindings: task.inputBindings },
        session: port.lease.scope, runId: port.lease.runId, turnId: port.lease.turnId,
        retention: { automaticPersistence: false, expiresAt: terminal.expiresAt, policy: RETENTION_POLICY,
            note: 'Transient custody ends on task/session replacement or reload. Downloaded files are user-managed; this is not a replay grant.' },
        executions, acceptedDataset, evidence: { status: admitted ? 'accepted' : 'unvalidated_artifact', selectedIds: ids,
            queryRoles: verdict?.scope.queries.map((query,n)=>({role:query.role,queryId:verdict.queryIds[n]})) ?? [],
            queries: queries.map(r => ({ ...r, grain: { kind: r.query.plan.groupBy?.length ? 'grouped' : r.query.plan.aggregates?.length ? 'scalar' : 'selected_rows',
                columns: r.query.plan.groupBy ?? r.query.result.selectedColumns }, query: { ...r.query, result: { ...r.query.result, rows: undefined } } })),
            computations: computations.map(r => ({ evidenceId: r.evidenceId, method: r.method, methodVersion: r.methodVersion,
                seed: r.seed, inputSha256: r.inputSha256, reference: r.reference, tolerance: r.tolerance, executionId: r.execution.jobId,
                grain: r.result.method==='lower_weighted_median'?'positive_frequency_value_pairs':'pairwise_complete_numeric_pairs',
                coverage: { scopedRows: r.result.scopedRows, completePairs: r.result.n, excluded: r.result.excluded,
                    ...(r.result.method==='lower_weighted_median'?{zeroWeightRows:r.result.zeroWeightRows,totalWeight:r.result.totalWeight,unit:r.result.unit}: {}) } })),
            reasons: verdict?.reasons ?? ['Execution success alone does not validate factual conclusions.'] },
        formats: { json: 'Authoritative typed output / query results.', csv: 'Flat display derivative; null/type distinctions remain in JSON.' },
        answerComplete: Boolean(admitted && task.scope.answer.complete && queries.every(r => !r.query.result.truncated)),
        files: fileMetadata };
    const manifestBytes = encode(manifest);
    if (manifestBytes.length > RETENTION_POLICY.artifactBytes || total + manifestBytes.length > RETENTION_POLICY.totalBytes) throw new Error('task_export_quota');
    files['manifest.json'] = manifestBytes; check();
    const bytes = zipSync(files, { level: 6 }); check();
    return { bytes, manifest, fileName: `task-${taskId}-r${task.revision}.zip` };
};
