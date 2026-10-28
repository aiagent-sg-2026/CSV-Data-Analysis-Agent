// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { preparePiDualGrainSmoke } from '../services/agent/runtime/pi/piDualGrainQualification';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import { handleClarificationResponse } from '../services/agent/orchestration/chatOrchestrator';
import { readTaskCandidateDraft } from '../services/agent/runtime/pi/piTaskInspection';
import type { StoreApi } from '../services/agent/types';
import { repairReservationStorage } from './helpers/repairReservationStorage';
const persistence = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../services/storageService', async original => ({ ...await original<typeof import('../services/storageService')>(), getStorageDatabase: async () => persistence.db }));
vi.mock('../services/persistence/currentSessionPersistence', () => ({ persistCurrentAppSessionSnapshot: vi.fn(async () => true) }));
const wasm = newQuickJSWASMModuleFromVariant(variant);
const roots: StoreApi[] = [];
const guest = { run: (code: string, inputJson: string, options: { limits?: Parameters<typeof resolveGuestLimits>[0]; onStarted?: () => void }) =>
    executeQuickJsGuest({ generation: 1, code, inputJson, limits: resolveGuestLimits(options?.limits) }, () => wasm, options?.onStarted), cancel() {}, dispose() {} };
beforeEach(() => {
    for (const name of ['localStorage', 'sessionStorage']) { const values = new Map<string, string>(); vi.stubGlobal(name, { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) }); }
    persistence.db = repairReservationStorage().db;
});
afterEach(() => { roots.splice(0).forEach(beginSessionTransition); vi.unstubAllGlobals(); });
const setup = () => {
    let state = { sessionId: crypto.randomUUID(), settings: {}, workspaceFiles: {}, analysisCards: [], columnProfiles: [], chatHistory: [], agentEvents: [], agentToolLogs: [], runtimeEvents: [], telemetryEvents: [], progressMessages: [], queryHistory: [],
        logAgentToolUsage() {}, addProgress() {}, clearActiveTurnCancellation() {}, ensureDatasetSemanticSnapshot: async () => null } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: p => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; } }; roots.push(root); return root;
};
const prepare = (root: StoreApi, options: Parameters<typeof preparePiDualGrainSmoke>[1] = {}) => preparePiDualGrainSmoke(root, { coding: { enabled: true, qualified: true, guest }, ...options });
const read = (root: StoreApi, table: string, offset = 0) => {
    const state = root.getState(), candidate = state.taskInspection!.candidate!;
    return readTaskCandidateDraft(root, state.activeAgentTask!.taskId, candidate.candidateId, table, candidate.validation!.receiptDigest!, offset);
};
const unchanged = (root: StoreApi, data: unknown) => {
    const state = root.getState(); expect(state.csvData).toBe(data); expect(state.canonicalCsvData).toBeNull(); expect(state.datasetBundle?.acceptedCommit).toBeUndefined();
    expect(state.analysisCards).toEqual([]); expect(state.queryHistory).toEqual([]); if (state.activeAgentTask && state.pendingClarification?.resumeContext?.piCandidateApproval) expect(state.activeAgentTask.status).toBe('awaiting_approval');
};
describe('normal Pi bounded dual-grain runtime (deterministic provider; actual QuickJS)', () => {
    it.each([42, 60, 90])('connects source width %i through exact A choice to both independent draft tables', async width => {
        const root = setup(), f = await prepare(root, { width });
        expect(root.getState().pendingClarification?.resumeContext?.piSpillMeaningChoice, f.trace.join('\n') + JSON.stringify(f.result)).toBeTruthy();
        expect(root.getState().taskInspection?.programs).toHaveLength(0);
        expect(f.result.structureRepair?.attempts).toBe(0);
        const pending = root.getState().pendingClarification!;
        await handleClarificationResponse(pending.options![0], root);
        const candidate = root.getState().taskInspection?.candidate;
        expect(candidate?.validation?.decision, f.trace.join('\n') + JSON.stringify(root.getState().taskInspection)).toBe('validated');
        expect(candidate?.tables.map(t => t.rows)).toEqual([3, 3 * f.fixture.measures]);
        expect(JSON.parse(root.getState().workspaceFiles['/intake/repair-task.json'])).toMatchObject({ state: 'awaiting_commit_approval' });
        expect(root.getState().activeAgentTask!.budget.used.providerTurns).toBeLessThan(root.getState().activeAgentTask!.budget.limits.providerTurns);
        const entities = await read(root, 'entities'), metrics = await read(root, 'metrics');
        expect(entities.rows.map(r => [r.Id, r['Cost [USD]'], r['Net [USD]']])).toEqual([['E1', 250, -250], ['E2', 30, -30], ['E3', 120, -120]]);
        expect(entities.rows[0].Metric).toBe('Label,\nα1');
        expect(metrics.rows.slice(0, 3).map(r => r['Value [USD]'])).toEqual([null, 0, -1.25]);
        expect(metrics.rows[0].Metric).toBe('Period1:Category1');
        expect(metrics.lineageSamples.find(l => l.row === 0 && l.column === 'Metric')?.origins[0]).toMatchObject({ row: 1, column: 0 });
        expect(entities.answerEvidence).toBe(false); expect(metrics.answerEvidence).toBe(false);
        unchanged(root, f.data);
    }, 30000);
    it.each([42, 60, 90])('executes distinct document-header/detail source rows at width %i without summary fanout', async width => {
        const root = setup(), f = await prepare(root, { width, layout: 'document_rows' });
        expect(root.getState().pendingClarification?.resumeContext?.piSpillMeaningChoice, JSON.stringify(f.result) + f.trace.join('\n')).toBeTruthy();
        await handleClarificationResponse(root.getState().pendingClarification!.options![0], root);
        const entities = await read(root, 'entities'), metrics = await read(root, 'metrics');
        expect(entities.rows.map(r => [r.Id, r['Cost [USD]']])).toEqual([['D1', 250], ['D2', 150]]);
        expect(metrics.rows.map(r => [r.Id, r.Metric, r['Cost [USD]']])).toEqual([['D1', 'L1', 0], ['D1', 'L2', -1.25], ['D2', 'L1', 2.5], ['D2', 'L2', 3]]);
        expect(entities.lineageSamples[0].origins[0].row).toBe(1); expect(metrics.lineageSamples[0].origins[0].row).toBe(2);
        unchanged(root, f.data);
    }, 30000);
    it('B chooses a genuinely different full alignment, not raw flattening or commit approval', async () => {
        const root = setup(), f = await prepare(root), pending = root.getState().pendingClarification!;
        await handleClarificationResponse(pending.options![1], root);
        const page = await read(root, 'metrics');
        expect(page.rows[0]).toMatchObject({ Metric: 'Period12:Category5', 'Value [USD]': null });
        expect(page.lineageSamples.find(l => l.row === 0 && l.column === 'Metric')?.origins[0]).toMatchObject({ row: 1, column: 59 });
        unchanged(root, f.data);
    });
    it('Neither stops before any program or execution and cannot be replayed', async () => {
        const root = setup(), f = await prepare(root), pending = root.getState().pendingClarification!;
        await handleClarificationResponse(pending.options![2], root);
        expect(root.getState().taskInspection?.programs).toHaveLength(0); expect(root.getState().pendingClarification).toBeNull();
        await handleClarificationResponse(pending.options![0], root);
        expect(root.getState().taskInspection?.candidate).toBeUndefined(); unchanged(root, f.data);
    });
    it.each(['question', 'option', 'selection-id', 'source', 'goal', 'relationship'] as const)('fails closed for mutated/stale %s before execution', async fault => {
        const root = setup(), f = await prepare(root), pending = structuredClone(root.getState().pendingClarification!);
        if (fault === 'question') pending.question += ' altered';
        if (fault === 'option') pending.options![0].label = 'tampered approval';
        if (fault === 'selection-id') pending.resumeContext!.piSpillMeaningChoice!.id = crypto.randomUUID();
        if (fault === 'source') { const b = root.getState().datasetBundle!; root.setState({ datasetBundle: { ...b, source: { ...b.source, inspection: { ...b.source.inspection!, sha256: '0'.repeat(64) } } } }); }
        if (fault === 'goal') root.setState({ confirmedAnalysisGoal: 'different' });
        if (fault === 'relationship') root.getState().datasetBundle!.relationshipSetId = 'mutated';
        root.setState({ pendingClarification: pending, chatHistory: [] });
        await handleClarificationResponse(pending.options![0], root);
        expect(root.getState().taskInspection?.programs).toHaveLength(0); expect(root.getState().taskInspection?.candidate).toBeUndefined(); unchanged(root, f.data);
    });
    it('selected proposal tamper does not bind meaning or grant code execution', async () => {
        const root = setup(), f = await prepare(root, { confirmedProposal: p => ({ ...p, assumptions: ['Changed after human choice'] }) });
        await handleClarificationResponse(root.getState().pendingClarification!.options![0], root);
        expect(f.trace.join('\n')).toContain('meaning_dual_grain_alternatives_required');
        expect(f.trace.join('\n')).toContain('initial_repair_source_meaning_required_before_execution');
        expect(root.getState().taskInspection?.candidate).toBeUndefined(); unchanged(root, f.data);
    });
    it('actual guest value tamper cannot create either validated draft', async () => {
        const root = setup(), f = await prepare(root, { fault: 'value' });
        await handleClarificationResponse(root.getState().pendingClarification!.options![0], root);
        expect(root.getState().taskInspection?.candidate?.validation?.decision, f.trace.join('\n')).toBe('blocked');
        await expect(read(root, 'entities')).rejects.toThrow(); await expect(read(root, 'metrics')).rejects.toThrow(); unchanged(root, f.data);
    });
    it('program revision after real execution invalidates staging, not just approval', async () => {
        const root = setup(), f = await prepare(root, { fault: 'program_revision' });
        await handleClarificationResponse(root.getState().pendingClarification!.options![0], root);
        expect(f.trace.join('\n')).toContain('workspace_conflict'); expect(root.getState().taskInspection?.candidate).toBeUndefined(); unchanged(root, f.data);
    });
    it('goal changes after meaning binding revoke execution authority', async () => {
        const root = setup(); let mutated = false;
        const f = await prepare(root, { beforeProvider: async () => {
            if (!mutated && root.getState().taskInspection?.observations.some(o => o.tool === 'candidate.infer_meaning' && o.status === 'success')) { mutated = true; root.setState({ confirmedAnalysisGoal: 'changed after binding' }); }
        } });
        await handleClarificationResponse(root.getState().pendingClarification!.options![0], root);
        expect(mutated).toBe(true); expect(root.getState().taskInspection?.observations.some(o => o.tool === 'code.run' && o.status === 'succeeded')).toBe(false);
        expect(root.getState().taskInspection?.candidate).toBeUndefined(); unchanged(root, f.data);
    });
    it('source/receipt tamper and session transition revoke detached draft reads', async () => {
        const root = setup(), f = await prepare(root);
        await handleClarificationResponse(root.getState().pendingClarification!.options![0], root);
        await read(root, 'entities');
        const candidate = root.getState().taskInspection!.candidate!, originalDigest = candidate.validation!.receiptDigest!;
        candidate.validation!.receiptDigest = '0'.repeat(64);
        await expect(read(root, 'entities')).rejects.toThrow(); candidate.validation!.receiptDigest = originalDigest;
        const b = root.getState().datasetBundle!; root.setState({ datasetBundle: { ...b, source: { ...b.source, inspection: { ...b.source.inspection!, sha256: '0'.repeat(64) } } } });
        await expect(read(root, 'entities')).rejects.toThrow();
        const taskId = root.getState().activeAgentTask!.taskId, candidateId = candidate.candidateId;
        beginSessionTransition(root); await expect(readTaskCandidateDraft(root, taskId, candidateId, 'metrics', originalDigest)).rejects.toThrow(); unchanged(root, f.data);
    });
});
