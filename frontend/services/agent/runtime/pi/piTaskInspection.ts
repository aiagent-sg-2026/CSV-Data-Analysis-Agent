import type { ToolExecutionResult } from '../../../../types';
import type { StoreApi } from '../../types';
import type { TaskWorkspace } from '../../taskWorkspace';
import type { AgentTaskContract } from './piTaskContract';
import type { CodeArtifactRef, CodeExecutionReceipt } from '../../execution/codeExecutionContract';
import type { CandidateStagingPort } from '../../../data/candidateStaging';
import type { QueryGroundingVerdict } from './queryEvidence';
import { ownsSessionScope, ownsRun, canCommitRun, registerSessionResource, rootStore, type RunLease } from '../../../session/sessionOwnership';
import { JAVASCRIPT_GUEST_PIN } from '../../../sandbox/javascriptGuestProtocol';
import { sealTaskExports } from './piTaskExports';
import type { QueryExecutionReceipt } from './queryEvidence';
import type { ComputationEvidenceReceipt } from '../../execution/computationEvidence';

export interface TaskObservationView {
    id: string; runId: string; taskRevision: number; tool: string; status: string; message: string;
    jobId?: string; durationMs?: number; stdout?: string; stderr?: string; truncated: boolean;
    externalObservation?: { receiptId: string; connectorId: string; generation: string; protocol: string;
        remoteTool: string; argumentsDigest: string; resultDigest: string; preview: string; previewTruncated: boolean };
}
export interface TaskCandidateView {
    candidateId: string; taskRevision: number; scopeDigest: string; changeDigest: string;
    tables: Array<{ name: string; rows: number; columns: string[] }>;
    excludedCount: number; exclusions: string[]; diff: string; diffTruncated: boolean;
    requirements: string; requirementsTruncated: boolean;
    validation?: { decision: string; reasons: string[]; checks: string[]; reconciliation: string; truncated: boolean };
}
export interface TaskInspectionProjection {
    taskId: string; sessionId: string; sessionEpoch: number; runId: string; runtime: string; outcome?: string;
    programs: Array<CodeArtifactRef & { byteSize: number }>; omittedPrograms: number;
    observations: TaskObservationView[]; omittedObservations: number;
    candidate?: TaskCandidateView; grounding?: Pick<QueryGroundingVerdict, 'status' | 'queryIds' | 'computationIds' | 'reasons'>;
    outputs?: import('../../../../types').RuntimeTaskOutputVerdict;
}
const LIMITS = { programs: 40, observations: 30, text: 2000 };
const bound = (text: string) => text.slice(0, LIMITS.text);
const readers = new WeakMap<StoreApi['getState'], { lease: RunLease; workspace: TaskWorkspace; taskId: string; seen: Set<string> }>();

/** A session-owned read port exposes ranges, never an execution or mutation handle. */
export const readTaskProgram = (store: StoreApi, taskId: string, program: CodeArtifactRef, offset = 0) => {
    const state = store.getState(), reader = readers.get(rootStore(store).getState);
    if (!reader || !ownsSessionScope(store, reader.lease.scope) || state.activeAgentTask?.taskId !== taskId
        || state.taskInspection?.taskId !== taskId || reader.taskId !== taskId) throw new Error('task_code_unavailable');
    const range = reader.workspace.readRange(program.path, program.revision, offset, 3000);
    if (range.sha256 !== program.sha256) throw new Error('task_code_revision_mismatch');
    return range;
};

export const createTaskInspection = (store: StoreApi, lease: RunLease, workspace: TaskWorkspace, taskId: string,
    previous?: TaskInspectionProjection) => {
    let projection: TaskInspectionProjection = previous ?? { taskId, sessionId: lease.scope.sessionId, sessionEpoch: lease.scope.epoch,
        runId: lease.runId, runtime: JAVASCRIPT_GUEST_PIN, programs: [], omittedPrograms: 0, observations: [], omittedObservations: 0 };
    projection = { ...projection, runId: lease.runId, outcome: undefined, grounding: undefined, outputs: undefined };
    const key = rootStore(store).getState, prior = readers.get(key);
    const seen = prior?.taskId === taskId ? prior.seen : new Set<string>();
    const reader = { lease, workspace, taskId, seen };
    readers.set(key, reader);
    registerSessionResource(lease.scope, () => { if (readers.get(key) === reader) readers.delete(key); });
    const publish = () => {
        if (canCommitRun(store, lease)) store.setState({ taskInspection: projection });
    };
    const observe = (task: AgentTaskContract, tool: string, result: ToolExecutionResult, callId: string, candidates?: CandidateStagingPort) => {
        if (!canCommitRun(store, lease)) return;
        const codeValue = result.artifacts?.codeExecution as CodeExecutionReceipt | undefined;
        const code = codeValue && !Array.isArray(codeValue) ? codeValue : undefined;
        const remote = result.artifacts?.mcpObservation as import('../../connectors/httpMcpContract').McpObservationReceipt | undefined;
        const remotePreview = remote && store.mcpTools?.owns(remote, {lease,toolCallId:callId}) ? JSON.stringify(remote.result, null, 2) : undefined;
        const observation: TaskObservationView = { id: callId, runId: lease.runId, taskRevision: task.revision, tool,
            status: code?.status ?? result.status, message: bound(code?.error?.message ?? result.message),
            ...(code && !Array.isArray(code) ? { jobId: code.jobId, durationMs: code.durationMs,
                stdout: bound(code.stdout ?? ''), stderr: bound(code.stderr ?? '') } : {}),
            ...(remote && remotePreview ? {externalObservation:{receiptId:remote.receiptId,connectorId:remote.connectorId,
                generation:remote.generation,protocol:remote.protocol,remoteTool:remote.remoteTool,argumentsDigest:remote.argumentsDigest,
                resultDigest:remote.resultDigest,preview:bound(remotePreview),previewTruncated:remotePreview.length>LIMITS.text}} : {}),
            truncated: Boolean(code?.logsTruncated || (code?.stdout?.length ?? 0) > LIMITS.text
                || (code?.stderr?.length ?? 0) > LIMITS.text || (code?.error?.message ?? result.message).length > LIMITS.text) };
        const programs = [...projection.programs];
        for (const artifact of workspace.list().filter(a => a.kind === 'program')) {
            const identity = `${artifact.path}@${artifact.revision}`;
            if (!seen.has(identity)) { seen.add(identity); programs.push({
                path: artifact.path, revision: artifact.revision, sha256: artifact.sha256, byteSize: artifact.byteSize,
            }); }
        }
        const observations = [...projection.observations.filter(o => o.id !== callId), observation];
        projection = { ...projection, programs: programs.slice(-LIMITS.programs),
            omittedPrograms: projection.omittedPrograms + Math.max(0, programs.length - LIMITS.programs),
            observations: observations.slice(-LIMITS.observations),
            omittedObservations: projection.omittedObservations + Math.max(0, observations.length - LIMITS.observations) };
        if (tool.startsWith('candidate.') && candidates) {
            try {
                const last = candidates.list().at(-1), candidate = last ? candidates.read(last.candidateId) : undefined;
                if (!candidate) projection = { ...projection, candidate: undefined };
                else {
                    let diff = 'Structural diff unavailable under current policy.';
                    try { diff = JSON.stringify(candidates.diff(candidate.candidateId).valueDiff, null, 2); } catch { /* An inspection does not bypass a denied diff tool. */ }
                    const validation = candidates.validationReceipt(candidate.candidateId), reconciliation = JSON.stringify(validation?.groups ?? [], null, 2);
                    let requirements = 'Host requirements unavailable under current policy.';
                    try { requirements = JSON.stringify(candidates.validationRequirements(), null, 2); } catch { /* Read policy remains authoritative. */ }
                    projection = { ...projection, candidate: { candidateId: candidate.candidateId, taskRevision: candidate.taskRevision,
                        scopeDigest: candidate.requestedChange.scopeDigest, changeDigest: candidate.changeDigest,
                        tables: candidate.tables.map(t => ({ name: t.name, rows: t.rowCount, columns: t.schema.map(s => s.name) })),
                        excludedCount: candidate.excludedRows.length,
                        exclusions: candidate.excludedRows.slice(0, 20).map(e => bound(`${e.origin.kind} ${e.origin.name} row ${e.origin.row}: ${e.reason}`)),
                        diff: bound(diff), diffTruncated: diff.length > LIMITS.text,
                        requirements: bound(requirements), requirementsTruncated: requirements.length > LIMITS.text,
                        ...(validation ? { validation: { decision: validation.decision, reasons: validation.reasonCodes.slice(0, 30),
                            checks: validation.checks.slice(0, 30), reconciliation: bound(reconciliation),
                            truncated: reconciliation.length > LIMITS.text || validation.checks.length > 30 || validation.reasonCodes.length > 30 } } : {}) } };
                }
            } catch { /* Stale candidates remain observations, never executable reviews. */ }
        }
        publish();
    };
    return { publish, observe, get snapshot() { return projection; } };
};

export const publishTaskOutcome = (store: StoreApi, text: string, verdict?: QueryGroundingVerdict,
    queries: QueryExecutionReceipt[] = [], computations: ComputationEvidenceReceipt[] = [], outputs?: import('../../../../types').RuntimeTaskOutputVerdict) => {
    const lease = store.executionContext?.lease, view = store.getState().taskInspection;
    if (!lease || !ownsRun(store, lease) || !view || view.taskId !== store.piTask?.snapshot.taskId) return;
    sealTaskExports(store, store.piTask.snapshot, verdict, queries, computations);
    rootStore(store).setState({ taskInspection: { ...view, outcome: bound(text), outputs, grounding: verdict ? { status: verdict.status, queryIds: [...verdict.queryIds],
        computationIds: verdict.computationIds ? [...verdict.computationIds] : undefined, reasons: verdict.reasons.map(bound).slice(0, 20) } : undefined } });
};
