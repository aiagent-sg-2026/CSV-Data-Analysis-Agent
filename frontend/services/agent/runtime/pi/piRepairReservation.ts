import type { StoreApi } from '../../types';
import { getStorageDatabase } from '../../../storageService';
import { codeDigest } from '../../execution/codeTableInputs';
import { seedRecoveredSourceStreamBudget, sourceStreamBudgetFloor, SOURCE_STREAM_LIMITS, type SourceStreamBudget } from '../../execution/codeSourceRecordStream';
import { createTaskBudget, DEFAULT_TASK_LIMITS, restoreTaskBudget, type TaskBudget, type TaskBudgetDimension } from './piTaskBudget';
import { StructureRepairPreparationError, STRUCTURE_REPAIR_LEDGER_SOURCES, STRUCTURE_REPAIR_LEDGER_TARGETS, type RepairCounterFloor } from './piStructureRepair';
import { assertRunActive } from '../../../session/sessionOwnership';
import { REPAIR_BUDGET_SESSION_STORAGE_KEY, TAB_SESSION_STORAGE_KEY } from '../../../../store/sessionLifecycle';

export interface RepairMeaningProgress { rejections: number; consecutive: number; stopReason: string; skipGuidance: string; guidanceTurn: number; providerTurns: number }
interface Floor { stream: SourceStreamBudget; repair?: RepairCounterFloor; task: TaskBudget;
    taskFailure?: { failureKey: string; repetitions: number }; meaning?: RepairMeaningProgress }
interface Account { sourceKey: string; goalDigests: string[]; floor: Floor; pending: null | { runId: string; goalDigest: string; reserved: Floor } }
export interface RepairBudgetCheckpoint { version: 1; session: string; revision: number; accounts: Account[]; digest: string }
const prefix = 'pi-repair-reservation-v1:';
const dimensions = Object.keys(DEFAULT_TASK_LIMITS) as TaskBudgetDimension[];
const checksum = ({ digest: _digest, ...body }: RepairBudgetCheckpoint) => codeDigest(body);
const maxTask = (a: TaskBudget, b: TaskBudget): TaskBudget => {
    const next = structuredClone(restoreTaskBudget(a)); restoreTaskBudget(b);
    for (const key of dimensions) { next.used[key] = Math.max(next.used[key], b.used[key]); next.limits[key] = Math.min(next.limits[key], b.limits[key]); }
    next.pausedForUser = false;
    return structuredClone(restoreTaskBudget(next));
};
export const mergeRepairTaskBudget = (a?: TaskBudget, b?: TaskBudget) => a && b ? maxTask(a, b) : a ?? b;
const validCounter = (c: NonNullable<Floor['repair']> | NonNullable<Floor['repair']>['targets'][number][1]) => {
    if (['attempts', 'failures', 'repetitions'].some(k => !Number.isSafeInteger(c[k]) || c[k] < 0)
        || typeof c.failureKey !== 'string' || c.blockedReason !== undefined && typeof c.blockedReason !== 'string') throw new Error('invalid');
    if (c.budget) restoreTaskBudget(c.budget);
};
const validFloor = (f: Floor) => {
    restoreTaskBudget(f.task);
    if (dimensions.some(k => f.task.limits[k] > DEFAULT_TASK_LIMITS[k])
        || !f.stream || !['attempts', 'steps', 'activeMs', 'readBytes', 'meaningAttempts'].every(k => Number.isSafeInteger(f.stream[k]) && f.stream[k] >= 0)) throw new Error('invalid');
    if (f.taskFailure && (!/^$|^[a-f0-9]{64}$/.test(f.taskFailure.failureKey) || !Number.isSafeInteger(f.taskFailure.repetitions) || f.taskFailure.repetitions < 0)) throw new Error('invalid');
    if (f.meaning && (['rejections', 'consecutive', 'guidanceTurn', 'providerTurns'].some(k => !Number.isSafeInteger(f.meaning![k]) || f.meaning![k] < 0)
        || typeof f.meaning.stopReason !== 'string' || typeof f.meaning.skipGuidance !== 'string')) throw new Error('invalid');
    if (f.repair) {
        validCounter(f.repair);
        if (!Array.isArray(f.repair.targets) || f.repair.targets.length > STRUCTURE_REPAIR_LEDGER_TARGETS
            || new Set(f.repair.targets.map(t => t[0])).size !== f.repair.targets.length) throw new Error('invalid');
        for (const [key, value] of f.repair.targets) { if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid'); validCounter(value); }
    }
};

/** Whole-run write-ahead reservation. Only this live host owner can settle it after all work
 * has returned. A crash keeps the full envelope, never an executable cursor or approval.
 * The digest detects corruption, NOT a same-origin storage attacker with rewrite access. */
export const reserveRepairRun = async (store: StoreApi, goal: string) => {
    const started = Date.now(), lease = store.executionContext!.lease, source = store.getState().datasetBundle?.source.inspection;
    const signature = JSON.stringify(source);
    const current = () => {
        assertRunActive(store, lease);
        if (JSON.stringify(store.getState().datasetBundle?.source.inspection) !== signature) throw new Error('source_range_stale');
    };
    let priorRepair: RepairCounterFloor | undefined;
    const fail = (reason: string): never => { throw new StructureRepairPreparationError(`initial_repair_${reason}`, {
        state: reason.includes('exhausted') ? 'exhausted' : 'unavailable', sourceSha256: source?.sha256 ?? null,
        attempts: priorRepair?.attempts ?? 0, validationFailures: priorRepair?.failures ?? 0, reason, resumable: false, commitAllowed: false,
    }); };
    if (!source) return fail('reservation_source_required');
    if (goal.length > 16_384) return fail('reservation_target_size_limit');
    const sourceKey = JSON.stringify([source.sha256, source.byteSize, source.recordCount, source.dialect]);
    try {
        // New Session explicitly rotates this existing tab identity. Upload locators, goals,
        // filenames, dataset IDs and runtime epochs cannot rotate the accounting namespace.
        let session = lease.scope.sessionId;
        if (typeof sessionStorage !== 'undefined') {
            session = sessionStorage.getItem(REPAIR_BUDGET_SESSION_STORAGE_KEY) ?? '';
            if (!session) {
                session = sessionStorage.getItem(TAB_SESSION_STORAGE_KEY) ?? lease.scope.sessionId;
                sessionStorage.setItem(REPAIR_BUDGET_SESSION_STORAGE_KEY, session);
                if (sessionStorage.getItem(REPAIR_BUDGET_SESSION_STORAGE_KEY) !== session) return fail('reservation_unavailable');
            }
        }
        const key = prefix + session, witness = localStorage.getItem(key),
            tabWitness = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(key), db = await getStorageDatabase(); current();
        const saved = (await db.get('settings', key))?.coordinatorBudget; current();
        if (Boolean(saved) !== Boolean(witness) || witness && witness !== '1'
            || typeof sessionStorage !== 'undefined' && (Boolean(saved) !== Boolean(tabWitness) || tabWitness && tabWitness !== '1')) return fail('reservation_incomplete');
        let checkpoint: RepairBudgetCheckpoint = saved ?? { version: 1, session, revision: 0, accounts: [], digest: '' };
        if (saved) {
            if (saved.version !== 1 || saved.session !== session || !Number.isSafeInteger(saved.revision) || saved.revision < 1
                || await checksum(saved) !== saved.digest || !Array.isArray(saved.accounts) || saved.accounts.length > STRUCTURE_REPAIR_LEDGER_SOURCES
                || new Set(saved.accounts.map(a => a.sourceKey)).size !== saved.accounts.length) return fail('reservation_corrupt');
            for (const a of saved.accounts) {
                if (typeof a.sourceKey !== 'string' || !Array.isArray(a.goalDigests) || a.goalDigests.length > STRUCTURE_REPAIR_LEDGER_TARGETS
                    || a.goalDigests.some(g => !/^[a-f0-9]{64}$/.test(g))) return fail('reservation_corrupt');
                validFloor(a.floor);
                if (a.pending) { if (typeof a.pending.runId !== 'string' || !a.goalDigests.includes(a.pending.goalDigest)) return fail('reservation_corrupt'); validFloor(a.pending.reserved); }
            }
        }
        current();
        const goalDigest = await codeDigest(goal); current();
        let account = checkpoint.accounts.find(a => a.sourceKey === sourceKey);
        priorRepair = account?.floor.repair;
        if (account?.pending) return fail('reservation_pending_uncertain_work');
        if (!account) {
            if (checkpoint.accounts.length >= STRUCTURE_REPAIR_LEDGER_SOURCES) return fail('reservation_source_capacity');
            account = { sourceKey, goalDigests: [], floor: { stream: { attempts: 0, steps: 0, activeMs: 0, readBytes: 0, meaningAttempts: 0 }, task: structuredClone(createTaskBudget()) }, pending: null };
        }
        if (!account.goalDigests.includes(goalDigest) && account.goalDigests.length >= STRUCTURE_REPAIR_LEDGER_TARGETS) return fail('reservation_goal_capacity');
        const floor = structuredClone(account.floor), s = floor.stream;
        if (s.attempts >= SOURCE_STREAM_LIMITS.attempts || s.meaningAttempts! >= SOURCE_STREAM_LIMITS.attempts
            || s.steps >= SOURCE_STREAM_LIMITS.steps || s.activeMs >= SOURCE_STREAM_LIMITS.activeMs || s.readBytes >= SOURCE_STREAM_LIMITS.cumulativeReadBytes
            || dimensions.some(k => floor.task.used[k] >= floor.task.limits[k]) || floor.repair?.blockedReason) return fail('reservation_budget_exhausted');
        const envelope: Floor = { task: { ...structuredClone(floor.task), used: { ...floor.task.limits } },
            stream: { attempts: SOURCE_STREAM_LIMITS.attempts, meaningAttempts: SOURCE_STREAM_LIMITS.attempts, steps: SOURCE_STREAM_LIMITS.steps,
                activeMs: SOURCE_STREAM_LIMITS.activeMs, readBytes: SOURCE_STREAM_LIMITS.cumulativeReadBytes } };
        const reserved: Account = { ...account, goalDigests: [...new Set([...account.goalDigests, goalDigest])], pending: { runId: lease.runId, goalDigest, reserved: envelope } };
        const revision = checkpoint.revision;
        const persist = async (next: RepairBudgetCheckpoint, expected: number) => {
            next.digest = await checksum(next); current();
            // Witness first: loss of IDB (or interruption before its first commit) cannot
            // masquerade as a new zero-budget session on the next attempt.
            localStorage.setItem(key, '1');
            if (localStorage.getItem(key) !== '1') return fail('reservation_unavailable');
            if (typeof sessionStorage !== 'undefined') {
                // A retained tab must also detect simultaneous IDB + localStorage loss.
                sessionStorage.setItem(key, '1');
                if (sessionStorage.getItem(key) !== '1') return fail('reservation_unavailable');
            }
            const tx = db.transaction('settings', 'readwrite'), prior = (await tx.store.get(key))?.coordinatorBudget;
            if ((prior?.revision ?? 0) !== expected || prior && prior.digest !== checkpoint.digest) { tx.abort(); await tx.done.catch(() => {}); return fail('reservation_conflict'); }
            await tx.store.put({ key, coordinatorBudget: next }); await tx.done;
            if ((await db.get('settings', key))?.coordinatorBudget?.digest !== next.digest) return fail('reservation_unavailable');
        };
        const next = { ...checkpoint, revision: revision + 1, accounts: [...checkpoint.accounts.filter(a => a.sourceKey !== sourceKey), reserved], digest: '' };
        await persist(next, revision); checkpoint = next; current();
        seedRecoveredSourceStreamBudget(store, source, floor.stream);
        let settled = false;
        return {
            floor,
            async settle(task: TaskBudget, repair?: RepairCounterFloor, progress?: Pick<Floor, 'taskFailure' | 'meaning'>) {
                if (settled) return;
                // No settlement after cancellation/replacement: an adapter may still own an
                // in-flight read/write. Retain the envelope rather than guess its frontier.
                current();
                const stream = sourceStreamBudgetFloor(store);
                for (const k of Object.keys(floor.stream) as Array<keyof SourceStreamBudget>) stream[k] = Math.max(stream[k] ?? 0, floor.stream[k] ?? 0);
                const chargedTask = maxTask(floor.task, task), elapsed = Math.max(0, Date.now() - started);
                chargedTask.used.activeMs = Math.min(chargedTask.limits.activeMs, Math.max(chargedTask.used.activeMs, floor.task.used.activeMs + elapsed));
                stream.activeMs = Math.min(SOURCE_STREAM_LIMITS.activeMs, Math.max(stream.activeMs, floor.stream.activeMs + elapsed));
                const consumed: Floor = { taskFailure: progress?.taskFailure ?? floor.taskFailure, meaning: progress?.meaning ?? floor.meaning,
                    stream, task: chargedTask, ...(repair ? { repair } : floor.repair ? { repair: floor.repair } : {}) };
                validFloor(consumed);
                const result = { ...checkpoint, revision: checkpoint.revision + 1, digest: '', accounts: checkpoint.accounts.map(a => a.sourceKey === sourceKey ? { ...a, floor: consumed, pending: null } : a) };
                await persist(result, checkpoint.revision); checkpoint = result; settled = true;
            },
        };
    } catch (error) {
        if (error instanceof StructureRepairPreparationError) throw error;
        return fail('reservation_unavailable_or_corrupt');
    }
};
