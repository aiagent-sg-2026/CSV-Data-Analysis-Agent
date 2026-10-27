// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reserveRepairRun } from '../services/agent/runtime/pi/piRepairReservation';
import { createTaskBudget, chargeTaskBudget } from '../services/agent/runtime/pi/piTaskBudget';
import { beginRun, scopeRunStore, beginSessionTransition } from '../services/session/sessionOwnership';
import type { StoreApi } from '../services/agent/types';
import { repairReservationStorage } from './helpers/repairReservationStorage';
const io = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../services/storageService', async original => ({ ...await original<typeof import('../services/storageService')>(), getStorageDatabase: async () => io.db }));
let storage: ReturnType<typeof repairReservationStorage>, local: Map<string, string>;
const roots: StoreApi[] = [];
beforeEach(() => {
    storage = repairReservationStorage(); io.db = storage.db; local = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => local.set(k, v) });
    const tab = new Map<string, string>([['csv_agent_repair_budget_session_id', 'deliberate-session']]);
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => tab.get(k) ?? null, setItem: (k: string, v: string) => tab.set(k, v) });
});
afterEach(() => { roots.splice(0).forEach(beginSessionTransition); vi.unstubAllGlobals(); });
const fixture = (sha256 = 'a'.repeat(64)) => {
    let state = { sessionId: crypto.randomUUID(), datasetBundle: { source: { inspection: { sourceId: crypto.randomUUID(), sha256, byteSize: 20, recordCount: 3, dialect: { delimiter: ',', quote: '"' } } } } } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: p => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; } }; roots.push(root);
    return { root, store: scopeRunStore(root, beginRun(root, 'initial_analysis', crypto.randomUUID())) };
};
it('writes the complete conservative envelope before any work; same-source uncertain replay is denied but unrelated source is independent', async () => {
    const a = fixture(), live = await reserveRepairRun(a.store, 'A');
    const saved = [...storage.values.values()][0] as { coordinatorBudget: { accounts: Array<{ pending: { reserved: { task: ReturnType<typeof createTaskBudget>; stream: { meaningAttempts: number } } } }> } };
    expect(saved.coordinatorBudget.accounts[0].pending.reserved.task.used).toEqual(createTaskBudget().limits);
    expect(saved.coordinatorBudget.accounts[0].pending.reserved.stream.meaningAttempts).toBe(3);
    await expect(reserveRepairRun(fixture().store, 'B')).rejects.toThrow('reservation_pending_uncertain_work');
    await expect(reserveRepairRun(fixture('b'.repeat(64)).store, 'A')).resolves.toBeTruthy();
    // Another valid account advanced the shared checkpoint. A stale live owner
    // must not overwrite it or release the pending original reservation.
    await expect(live.settle(createTaskBudget())).rejects.toThrow('reservation_conflict');
    beginSessionTransition(a.root);
    await expect(reserveRepairRun(fixture().store, 'A')).rejects.toThrow('reservation_pending_uncertain_work');
});
it('settles once, restores floors, retains A/B/A identities, and rejects a stale settlement', async () => {
    const a = fixture(), reservation = await reserveRepairRun(a.store, 'A');
    const charge = chargeTaskBudget(createTaskBudget(), { toolCalls: 5, providerTurns: 3, transformationAttempts: 1, activeMs: 40 });
    await reservation.settle(charge.budget); const once = structuredClone([...storage.values]);
    await reservation.settle(createTaskBudget()); expect([...storage.values]).toEqual(once);
    beginSessionTransition(a.root);
    const b = fixture(), next = await reserveRepairRun(b.store, 'B'); expect(next.floor.task.used).toEqual(charge.budget.used);
    beginSessionTransition(b.root); await expect(next.settle(createTaskBudget())).rejects.toThrow();
    await expect(reserveRepairRun(fixture().store, 'A')).rejects.toThrow('reservation_pending_uncertain_work');
});
it.each(['missing-idb', 'missing-witness', 'both-removed', 'bad-json', 'bad-version', 'bad-digest'])('fails closed on incomplete/corrupt persistence: %s', async bad => {
    const a = fixture(), reservation = await reserveRepairRun(a.store, 'A'); await reservation.settle(createTaskBudget()); beginSessionTransition(a.root);
    const [key, entry] = [...storage.values][0] as [string, { coordinatorBudget: { version: number; digest: string } }];
    if (bad === 'missing-idb') storage.values.clear();
    if (bad === 'missing-witness') local.clear();
    if (bad === 'both-removed') { local.clear(); storage.values.clear(); }
    if (bad === 'bad-json') storage.values.set(key, { coordinatorBudget: 'not an object' });
    if (bad === 'bad-version') { entry.coordinatorBudget.version = 2; storage.values.set(key, entry); }
    if (bad === 'bad-digest') { entry.coordinatorBudget.digest = 'f'.repeat(64); storage.values.set(key, entry); }
    await expect(reserveRepairRun(fixture().store, 'B')).rejects.toThrow('initial_repair_reservation_');
});
it('retains repair/meaning/task failure floors and target digests after reload and rejects lower task budget snapshots', async () => {
    const a = fixture(), reservation = await reserveRepairRun(a.store, 'A');
    const budget = chargeTaskBudget(createTaskBudget(), { toolCalls: 9, providerTurns: 6, skillReads: 2, transformationAttempts: 2 }).budget;
    const counter = { attempts: 2, failures: 1, repetitions: 1, failureKey: 'validation_failed', budget };
    const repair = { ...counter, targets: [['a'.repeat(64), counter]] as Array<[string, typeof counter]> };
    const progress = { taskFailure: { failureKey: 'c'.repeat(64), repetitions: 1 }, meaning: { rejections: 2, consecutive: 1, stopReason: '', skipGuidance: '', guidanceTurn: 0, providerTurns: 6 } };
    await reservation.settle(budget, repair, progress); beginSessionTransition(a.root);
    const b = fixture(), next = await reserveRepairRun(b.store, 'B');
    expect(next.floor.repair).toEqual(repair); expect(next.floor.taskFailure).toEqual(progress.taskFailure); expect(next.floor.meaning).toEqual(progress.meaning);
    await next.settle(createTaskBudget()); beginSessionTransition(b.root);
    const final = await reserveRepairRun(fixture().store, 'A');
    for (const k of ['toolCalls', 'providerTurns', 'skillReads', 'transformationAttempts'] as const) expect(final.floor.task.used[k]).toBe(budget.used[k]);
    expect(final.floor.taskFailure).toEqual(progress.taskFailure); expect(final.floor.meaning).toEqual(progress.meaning);
    const saved = [...storage.values.values()][0] as { coordinatorBudget: { accounts: Array<{ goalDigests: string[] }> } };
    expect(saved.coordinatorBudget.accounts[0].goalDigests).toHaveLength(2);
});
it('never releases a reservation if settlement persistence is denied', async () => {
    const a = fixture(), reservation = await reserveRepairRun(a.store, 'A'); storage.deny();
    await expect(reservation.settle(createTaskBudget())).rejects.toThrow(); beginSessionTransition(a.root);
    await expect(reserveRepairRun(fixture().store, 'B')).rejects.toThrow('reservation_pending_uncertain_work');
});
it('only an explicitly fresh tab session separates a deliberate new session, not a changed runtime sessionId', async () => {
    await reserveRepairRun(fixture().store, 'A');
    await expect(reserveRepairRun(fixture().store, 'A')).rejects.toThrow('reservation_pending_uncertain_work');
    const fresh = new Map<string, string>([['csv_agent_repair_budget_session_id', 'explicitly-new-session']]);
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => fresh.get(k) ?? null, setItem: (k: string, v: string) => fresh.set(k, v) });
    await expect(reserveRepairRun(fixture().store, 'A')).resolves.toMatchObject({ floor: { task: { used: createTaskBudget().used } } });
});
