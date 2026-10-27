// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { preparePiLargeCoordinatorSmoke } from '../services/agent/runtime/pi/piLargeCoordinatorQualification';
import { beginRun, beginSessionTransition, finishRun, scopeRunStore } from '../services/session/sessionOwnership';
import { handleClarificationResponse } from '../services/agent/orchestration/chatOrchestrator';
import { reserveRepairRun, type RepairBudgetCheckpoint } from '../services/agent/runtime/pi/piRepairReservation';
import { createTaskBudget } from '../services/agent/runtime/pi/piTaskBudget';
import { recoverPiInitialAnalysisIfNeeded } from '../services/agent/runtime/pi/piInitialAnalysisRuntimeService';
import { captureCheckpointSource, checkpointLineageSignature, writePiInitialCheckpoint } from '../services/agent/runtime/pi/piInitialCheckpoint';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import { getCsvDatasetVersion } from '../utils/datasetId';
import { SOURCE_STREAM_LIMITS } from '../services/agent/execution/codeSourceRecordStream';
import { inspectPiCandidateReview } from '../services/agent/runtime/pi/piCandidateReviewState';
import type { StoreApi } from '../services/agent/types';
import type { PiInitialAnalysisOptions } from '../services/agent/runtime/pi/piInitialAnalysisRuntimeService';
import { repairReservationStorage } from './helpers/repairReservationStorage';

// Only persistence/transport are deterministic adapters; runtime, Agent, lease, reservation,
// public tools, source scan/compiler and QuickJS execution remain the application code.
const io = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../services/storageService', async original => ({ ...await original<typeof import('../services/storageService')>(), getStorageDatabase: async () => io.db }));
vi.mock('../services/persistence/currentSessionPersistence', () => ({ persistCurrentAppSessionSnapshot: vi.fn(async (state: ReturnType<StoreApi['getState']>) =>
    Boolean(state.candidateRecovery || state.datasetBundle?.acceptedCommit || state.csvData?.data.length)) }));
const wasm = newQuickJSWASMModuleFromVariant(variant);
const guest = { run: (code: string, inputJson: string, options: { limits?: Parameters<typeof resolveGuestLimits>[0]; onStarted?: () => void }) =>
    executeQuickJsGuest({ generation: 1, code, inputJson, limits: resolveGuestLimits(options?.limits) }, () => wasm, options?.onStarted), cancel() {}, dispose() {} };
const roots: StoreApi[] = [];
let storage: ReturnType<typeof repairReservationStorage>;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
    const local = new Map<string, string>(), tab = new Map<string, string>([['csv_agent_repair_budget_session_id', 'expiry-qualification']]);
    const adapter = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v), removeItem: (k: string) => m.delete(k) });
    vi.stubGlobal('localStorage', adapter(local)); vi.stubGlobal('sessionStorage', adapter(tab));
    storage = repairReservationStorage(); io.db = storage.db;
});
afterEach(() => { roots.splice(0).forEach(beginSessionTransition); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const setup = () => {
    let state = { sessionId: crypto.randomUUID(), settings: {}, workspaceFiles: {}, analysisCards: [], columnProfiles: [], chatHistory: [], agentEvents: [], agentToolLogs: [], runtimeEvents: [], telemetryEvents: [], progressMessages: [], queryHistory: [],
        logAgentToolUsage() {}, addProgress() {}, clearActiveTurnCancellation() {}, ensureDatasetSemanticSnapshot: async () => null } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: p => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; } }; roots.push(root);
    const coding: NonNullable<PiInitialAnalysisOptions['codingPreparation']> = { enabled: true, qualified: true, guest,
        spillFactory: async () => { const chunks = new Map<string, string>(); return { put: async (n, t) => { chunks.set(n, t); }, get: async n => chunks.get(n)!, remove: async () => { chunks.clear(); } }; } };
    return { root, coding };
};
const file = (semantic = false, name = 'fictional-expiry.csv') => new File([`key,payload,value${semantic ? '' : ' [count]'}\n0,alpha,0\n1,beta,-1\n2,gamma,1,,\n`], name);
const columns = ['key', 'payload', 'value [count]'];
const account = () => ([...storage.values.values()][0] as { coordinatorBudget: RepairBudgetCheckpoint }).coordinatorBudget.accounts[0];
const fullPending = () => {
    expect(account().pending?.reserved.task.used).toEqual(createTaskBudget().limits);
    expect(account().pending?.reserved.stream).toEqual({ attempts: SOURCE_STREAM_LIMITS.attempts, meaningAttempts: SOURCE_STREAM_LIMITS.attempts,
        steps: SOURCE_STREAM_LIMITS.steps, activeMs: SOURCE_STREAM_LIMITS.activeMs, readBytes: SOURCE_STREAM_LIMITS.cumulativeReadBytes });
};
const noPublication = (root: StoreApi) => {
    expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined();
    expect(root.getState().canonicalCsvData).toBeNull();
    expect(root.getState().analysisCards).toEqual([]);
    expect(root.getState().pendingClarification).toBeNull();
    expect(inspectPiCandidateReview(root).available).toBe(false);
};
const reselect = async (semantic = false) => {
    const prior = structuredClone(account()), fresh = setup(), beforeProvider = vi.fn(async () => {}), runGuest = vi.spyOn(fresh.coding.guest!, 'run');
    const result = await preparePiLargeCoordinatorSmoke(fresh.root, file(semantic, 'renamed-same-bytes.csv'), { numeric: true, columns: semantic ? undefined : columns, coding: fresh.coding, goal: 'Changed goal cannot reset expiry accounting', beforeProvider });
    expect(result.result.structureRepair?.reason).toBe('reservation_pending_uncertain_work');
    expect(result.trace).toEqual([]); expect(beforeProvider).not.toHaveBeenCalled(); expect(runGuest).not.toHaveBeenCalled();
    runGuest.mockRestore(); noPublication(fresh.root);
    expect(account()).toEqual(prior);
    const source = result.source;
    expect(JSON.stringify([source.sha256, source.byteSize, source.recordCount, source.dialect])).toBe(prior.sourceKey);
};

it.each(['provider', 'guest'] as const)('expires the actual initial runtime at 240s with held %s; late return never settles or renews work', async effect => {
    const { root, coding } = setup(), entered = deferred(), release = deferred(), returned = deferred(), guestFinished = deferred();
    let providerCalls = 0, guestCalls = 0, effectReturned = false;
    const hold = async () => { entered.resolve(); await release.promise; effectReturned = true; returned.resolve(); };
    coding.guest = { ...guest, run: async (...args: Parameters<typeof guest.run>) => {
        guestCalls++; await hold();
        try { return await guest.run(...args); } finally { guestFinished.resolve(); }
    } };
    const running = preparePiLargeCoordinatorSmoke(root, file(), { numeric: true, columns, coding, beforeProvider: async () => {
        providerCalls++; if (effect === 'provider' && providerCalls === 1) await hold();
    } });
    await entered.promise;
    // beginRun publishes the real run ID; source work is already durably reserved.
    expect(root.getState().activeExecution?.kind).toBe('initial_analysis');
    fullPending(); const pending = structuredClone(account().pending);
    let completed = false; void running.then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(239_999);
    expect(completed).toBe(false); expect(account().pending).toEqual(pending);
    await vi.advanceTimersByTimeAsync(1);
    const result = await running;
    expect(result.result.status).toBe('failed');
    expect(result.result.error?.message).toBe('The Pi initial-analysis time budget expired.');
    expect(effectReturned).toBe(false);
    fullPending(); expect(account().pending).toEqual(pending); noPublication(root);
    const calls = [providerCalls, guestCalls];
    await reselect(); fullPending();
    release.resolve(); await returned.promise;
    if (effect === 'guest') await guestFinished.promise;
    await vi.advanceTimersByTimeAsync(0); expect(effectReturned).toBe(true);
    expect([providerCalls, guestCalls]).toEqual(calls); expect(account().pending).toEqual(pending); noPublication(root);
    beginSessionTransition(root); await reselect(); fullPending();
}, 30_000);

const seedTimeFloor = async (activeMs: number) => {
    // Establish a real source identity and a legitimately settled semantic boundary first.
    const seed = setup(); await preparePiLargeCoordinatorSmoke(seed.root, file(true), { numeric: true, coding: seed.coding });
    expect(account().pending).toBeNull();
    const lease = beginRun(seed.root, 'initial_analysis', crypto.randomUUID());
    const reservation = await reserveRepairRun(scopeRunStore(seed.root, lease), 'Restored time floor');
    const budget = structuredClone(reservation.floor.task); budget.used.activeMs = activeMs;
    await reservation.settle(budget); finishRun(seed.root, lease); beginSessionTransition(seed.root);
};

it.each([239_998, 239_999, 240_000, 240_001])('restores %ims and enforces the Math.max(1, remaining) runtime deadline', async activeMs => {
    await seedTimeFloor(activeMs);
    const { root, coding } = setup(), entered = deferred(), release = deferred(), returned = deferred();
    let calls = 0;
    const running = preparePiLargeCoordinatorSmoke(root, file(true), { numeric: true, coding, beforeProvider: async () => { calls++; entered.resolve(); await release.promise; returned.resolve(); } });
    await entered.promise; fullPending();
    let completed = false; void running.then(() => { completed = true; });
    const remaining = Math.max(1, 240_000 - activeMs);
    await vi.advanceTimersByTimeAsync(remaining - 1); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await running;
    expect(result.result.error?.message).toBe('The Pi initial-analysis time budget expired.');
    expect(calls).toBe(1); fullPending(); noPublication(root);
    release.resolve(); await returned.promise; await vi.advanceTimersByTimeAsync(0);
    beginSessionTransition(root); await reselect(true); fullPending();
}, 30_000);

it.each([240_000, 240_001])('also expires the recovered checkpoint timer after 1ms with %ims restored, without the repair timer reset', async activeMs => {
    const { root } = setup(), data = { fileName: 'fictional-checkpoint.csv', data: [{ key: 'a', value: 1 }] };
    const bundle = createSingleTableDatasetBundle({ datasetId: 'checkpoint-expiry', sourceFingerprint: 'fictional', file: new File(['key,value\na,1\n'], data.fileName), data });
    const version = getCsvDatasetVersion(data), budget = structuredClone(createTaskBudget()); budget.used.activeMs = activeMs;
    root.setState({ csvData: data, rawCsvData: data, canonicalCsvData: null, datasetBundle: bundle, currentDatasetId: 'checkpoint-expiry',
        confirmedAnalysisGoal: 'Checkpoint expiry qualification', pendingClarification: null,
        settings: { provider: 'default', complexModel: 'mock', language: 'English' } as never });
    writePiInitialCheckpoint({ schemaVersion: 2, sessionId: root.getState().sessionId, datasetVersion: version, preparedDatasetVersion: version,
        initialDatasetVersion: version, source: captureCheckpointSource(root.getState())!, sourceBoundary: null, lineageSignature: checkpointLineageSignature(root.getState()),
        stageReceipts: [], receiptStartIndex: 0, researchGoal: root.getState().confirmedAnalysisGoal!, nextStageIndex: 0, pendingStageIndex: null,
        committedTransformationIds: [], cardFingerprints: [], warnings: [], coding: { version: 1, budget } });
    beginSessionTransition(root);
    const entered = deferred(), release = deferred(), returned = deferred(); let calls = 0;
    const running = recoverPiInitialAnalysisIfNeeded(root, async () => {
        calls++; entered.resolve(); await release.promise; returned.resolve(); throw new Error('Late synthetic provider completion');
    });
    await entered.promise;
    expect(storage.values.size).toBe(0); // This exercises the initial checkpoint timer, not source-repair reset.
    let completed = false; void running.then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await running;
    expect(result?.error?.message).toBe('The Pi initial-analysis time budget expired.');
    expect(result?.status).toBe('failed'); expect(calls).toBe(1); noPublication(root);
    release.resolve(); await returned.promise; await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1); noPublication(root);
}, 30_000);

it('denies provider/tool work before admission when the restored active budget is exhausted', async () => {
    await seedTimeFloor(createTaskBudget().limits.activeMs);
    const { root, coding } = setup(), beforeProvider = vi.fn(async () => {}), runGuest = vi.spyOn(guest, 'run');
    try {
        const result = await preparePiLargeCoordinatorSmoke(root, file(true, 'exhausted-renamed.csv'), { numeric: true, coding, beforeProvider });
        expect(result.result.structureRepair).toMatchObject({ state: 'exhausted', reason: 'reservation_budget_exhausted' });
        expect(beforeProvider).not.toHaveBeenCalled(); expect(runGuest).not.toHaveBeenCalled(); expect(result.trace).toEqual([]);
        expect(account().pending).toBeNull(); expect(account().floor.task.used.activeMs).toBe(createTaskBudget().limits.activeMs);
        noPublication(root);
    } finally { runGuest.mockRestore(); }
});

it('excludes a long semantic human wait, permits a real resume, then expires its held provider at the remaining active deadline', async () => {
    const { root, coding } = setup(), entered = deferred(), release = deferred(); let resumed = false, calls = 0;
    const f = await preparePiLargeCoordinatorSmoke(root, file(true), { numeric: true, coding, beforeProvider: async () => {
        calls++;
        if (!resumed && calls === 3) await vi.advanceTimersByTimeAsync(37);
        if (resumed) { entered.resolve(); await release.promise; }
    } });
    const pending = root.getState().pendingClarification!;
    expect(pending.resumeContext?.piSpillMeaningChoice).toBeTruthy();
    expect(root.getState().activeExecution).toBeNull(); expect(account().pending).toBeNull();
    const settled = structuredClone(account().floor), before = calls;
    expect(settled.task.used.activeMs).toBe(37);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(account().floor).toEqual(settled); expect(account().pending).toBeNull(); expect(calls).toBe(before);
    expect(root.getState().pendingClarification).toEqual(pending);
    resumed = true;
    const resuming = handleClarificationResponse(pending.options![0], root);
    await entered.promise; expect(calls).toBe(before + 1); fullPending();
    const active = settled.task.used.activeMs;
    await vi.advanceTimersByTimeAsync(240_000 - active - 1);
    expect(root.getState().activeExecution).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1); await resuming;
    fullPending(); noPublication(root);
    release.resolve(); await vi.advanceTimersByTimeAsync(0);
    beginSessionTransition(root); await reselect(true); fullPending();
    expect(f.trace.join('\n')).not.toContain('candidate_stage:');
}, 30_000);
