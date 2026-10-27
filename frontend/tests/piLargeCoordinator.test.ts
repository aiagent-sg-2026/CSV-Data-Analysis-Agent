// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { preparePiLargeCoordinatorSmoke } from '../services/agent/runtime/pi/piLargeCoordinatorQualification';
import { beginSessionTransition, cancelOwnedRun } from '../services/session/sessionOwnership';
import { handleClarificationResponse } from '../services/agent/orchestration/chatOrchestrator';
import { inspectPiCandidateReview } from '../services/agent/runtime/pi/piCandidateReviewState';
import { isSpillMeaningProposal } from '../services/data/spillMeaningProposal';
import { createCandidateMeaningManifest } from '../services/agent/tools/manifests/candidateMeaningManifest';
import type { StoreApi } from '../services/agent/types';
import type { CandidateSpillFactory } from '../services/data/candidateSpill';
vi.mock('../services/persistence/currentSessionPersistence', () => ({ persistCurrentAppSessionSnapshot: vi.fn(async (state: ReturnType<StoreApi['getState']>) => Boolean(state.candidateRecovery || state.datasetBundle?.acceptedCommit || state.csvData?.data.length)) }));
const wasm = newQuickJSWASMModuleFromVariant(variant);
const guest = { run: (code: string, inputJson: string, options: { limits?: Parameters<typeof resolveGuestLimits>[0]; onStarted?: () => void }) =>
    executeQuickJsGuest({ generation: 1, code, inputJson, limits: resolveGuestLimits(options?.limits) }, () => wasm, options?.onStarted), cancel() {}, dispose() {} };
const roots: StoreApi[] = [], dirs: string[] = [];
beforeEach(() => { const values = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) }); });
afterEach(async () => { roots.splice(0).forEach(beginSessionTransition); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); vi.unstubAllGlobals(); });
const setup = async () => {
    let state = { sessionId: crypto.randomUUID(), settings: {}, workspaceFiles: {}, analysisCards: [], columnProfiles: [], chatHistory: [], agentEvents: [], agentToolLogs: [], runtimeEvents: [], telemetryEvents: [], progressMessages: [], queryHistory: [],
        logAgentToolUsage() {}, addProgress() {}, clearActiveTurnCancellation() {}, ensureDatasetSemanticSnapshot: async () => null } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: p => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; } }; roots.push(root);
    const dir = await mkdtemp(join(tmpdir(), 'pi-large-coordinator-')); dirs.push(dir);
    const spillFactory: CandidateSpillFactory = async (_session, generation) => { const path = join(dir, generation); await mkdir(path);
        return { put: (n, t) => writeFile(join(path, n), t, { flag: 'wx' }), get: n => readFile(join(path, n), 'utf8'), remove: () => rm(path, { recursive: true, force: true }) }; };
    return { root, coding: { enabled: true as const, qualified: true, guest, spillFactory } };
};
const file = (rows = 2100, columns = ['key', 'payload', 'value [count]'], payload = 32) => new File([columns.join(',') + '\r\n' + Array.from({ length: rows }, (_, i) => `${i},"${'x'.repeat(payload)}${i === rows - 1 ? 'α\r\n末尾' : ''}",${i % 2 ? '-1' : '0'}${i === rows - 1 ? ',,' : ''}\r\n`).join('')], 'fictional-stream.csv');

describe('normal large-source initial Pi coordinator', () => {
    it.each([['key', 'payload', 'value [count]'], ['record', 'memo', 'quantity [count]']])('compiles public model meaning and obtains isolated draft/exact review with unrelated columns %j', async (a, b, c) => {
        const columns = [a, b, c];
        const { root, coding } = await setup(), f = await preparePiLargeCoordinatorSmoke(root, file(2100, columns), { columns, numeric: true, coding });
        expect(f.result.structureRepair, JSON.stringify(f.result) + f.trace.join('\n')).toMatchObject({ state: 'awaiting_commit_approval', attempts: 1, validationFailures: 0 });
        expect(f.trace.join('\n')).toContain('draft_uncommitted'); expect(f.trace.join('\n')).toContain('"decision":"validated"');
        expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined(); expect(root.getState().canonicalCsvData).toBeNull();
        expect(root.getState().activeDataQuery).toBeUndefined(); expect(root.getState().analysisCards).toEqual([]);
        expect(root.getState().pendingClarification?.resumeContext?.piCandidateApproval).toBeTruthy(); expect(inspectPiCandidateReview(root).available).toBe(true);
        expect(f.reads.fullReads).toBe(0); expect(f.reads.maxBytes).toBeLessThanOrEqual(65536);
    }, 60000);
    it('executes >25MiB actual QuickJS/disk using normal initial runtime, never full original arrays', async () => {
        const { root, coding } = await setup(), f = await preparePiLargeCoordinatorSmoke(root, file(27000, undefined, 1000), { columns: ['key', 'payload', 'value [count]'], numeric: true, coding });
        expect(f.source.byteSize).toBeGreaterThan(25 * 1024 * 1024);
        expect(f.result.structureRepair, f.trace.join('\n')).toMatchObject({ state: 'awaiting_commit_approval', attempts: 1 });
        expect(f.reads.fullReads).toBe(0); expect(f.reads.maxBytes).toBe(65536);
        expect(f.reads.bytes).toBeLessThan(f.source.byteSize * 6);
        console.log(JSON.stringify({ qualification: 'normal-large-coordinator-draft', bytes: f.source.byteSize, reads: f.reads, budget: root.getState().activeAgentTask?.budget }));
    }, 180000);
    it.each(['retry', 'exhaust'] as const)('autonomously handles model code failure: %s without legacy fallback', async mode => {
        const { root, coding } = await setup(), f = await preparePiLargeCoordinatorSmoke(root, file(), { numeric: true, columns: ['key', 'payload', 'value [count]'], coding, mode });
        expect(f.result.structureRepair, f.trace.join('\n')).toMatchObject(mode === 'retry' ? { state: 'awaiting_commit_approval', attempts: 2 } : { state: 'exhausted', attempts: 2 });
        expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined(); expect(root.getState().canonicalCsvData).toBeNull();
    }, 60000);
    it.each(['A', 'B', 'neither'])('asks precise unit meaning and resumes public compilation for %s, never commit', async selected => {
        const { root, coding } = await setup(), f = await preparePiLargeCoordinatorSmoke(root, file(2100, ['key', 'payload', 'value']), { numeric: true, coding });
        const pending = root.getState().pendingClarification;
        expect(pending?.resumeContext?.piSpillMeaningChoice, f.trace.join('\n')).toBeTruthy(); expect(pending?.interactionKind).not.toBe('approval');
        expect(root.getState().activeAgentTask?.budget.used.transformationAttempts).toBe(0);
        await handleClarificationResponse(pending!.options!.find(o => o.value === selected)!, root);
        expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined(); expect(root.getState().canonicalCsvData).toBeNull();
        if (selected !== 'neither') {
            expect(root.getState().pendingClarification?.resumeContext?.piCandidateApproval, f.trace.join('\n')).toBeTruthy();
            expect(root.getState().activeAgentTask?.budget.used.toolCalls).toBeGreaterThan(4);
        } else expect(root.getState().pendingClarification).toBeNull();
    }, 60000);
    it('rejects stale semantic choice after replacing original source metadata', async () => {
        const { root, coding } = await setup(); await preparePiLargeCoordinatorSmoke(root, file(2100, ['key', 'payload', 'value']), { numeric: true, coding });
        const pending = root.getState().pendingClarification!;
        root.setState(s => ({ datasetBundle: { ...s.datasetBundle!, source: { ...s.datasetBundle!.source, inspection: { ...s.datasetBundle!.source.inspection!, sha256: 'f'.repeat(64) } } } }));
        await handleClarificationResponse(pending.options![0], root);
        expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined(); expect(root.getState().pendingClarification?.resumeContext?.piCandidateApproval).toBeUndefined();
    });
    it('cancels normal streamed work and resumes the same source with cumulative task/attempt budgets', async () => {
        const { root, coding } = await setup();
        let enter!: () => void, release!: () => void, first = true;
        const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
        coding.guest = { ...guest, run: async (...args: Parameters<typeof guest.run>) => {
            if (first) { first = false; enter(); await gate; } return guest.run(...args);
        } };
        const running = preparePiLargeCoordinatorSmoke(root, file(), { columns: ['key', 'payload', 'value [count]'], numeric: true, coding });
        await entered; cancelOwnedRun(root); release(); const f = await running;
        expect(f.result.status).toBe('cancelled'); expect(f.result.structureRepair?.attempts).toBe(1);
        const used = root.getState().activeAgentTask!.budget.used;
        const resumed = await f.retrySameSource('A different goal cannot reset the source budget.');
        expect(resumed.structureRepair, JSON.stringify(resumed) + f.trace.join('\n')).toMatchObject({ state: 'awaiting_commit_approval', attempts: 2 });
        expect(root.getState().activeAgentTask!.budget.used.toolCalls).toBeGreaterThan(used.toolCalls);
        expect(root.getState().activeAgentTask!.budget.used.transformationAttempts).toBe(2);
        expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined(); expect(f.reads.fullReads).toBe(0);
    }, 60000);
    it('streams a small Blob-only original based on actual capability, not a size rejection', async () => {
        const { root, coding } = await setup(), f = await preparePiLargeCoordinatorSmoke(root, file(3), { columns: ['key', 'payload', 'value [count]'], numeric: true, coding });
        expect(f.source.byteSize).toBeLessThan(65536);
        expect(f.result.structureRepair, JSON.stringify(f.result) + f.trace.join('\n')).toMatchObject({ state: 'awaiting_commit_approval', attempts: 1 });
    });
    it.each([true, false])('requires precise footer role confirmation even when totals agree: %s', async reconciles => {
        const { root, coding } = await setup();
        const text = 'key,payload,value [count]\n' + Array.from({ length: 2100 }, (_, i) => `${i},memo,1\n`).join('') + `ordinary-looking-record,memo,${reconciles ? 2100 : 2099}\n`;
        const f = await preparePiLargeCoordinatorSmoke(root, new File([text], 'fictional-footer.csv'), { columns: ['key', 'payload', 'value [count]'], numeric: true, summary: true, coding });
        const pending = root.getState().pendingClarification!;
        expect(pending.resumeContext?.piSpillMeaningChoice, f.trace.join('\n')).toBeTruthy();
        expect(root.getState().activeAgentTask?.budget.used.transformationAttempts).toBe(0);
        await handleClarificationResponse(pending.options![0], root);
        expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined();
        if (reconciles) expect(root.getState().pendingClarification?.resumeContext?.piCandidateApproval).toBeTruthy();
        else { expect(root.getState().pendingClarification?.resumeContext?.piCandidateApproval).toBeUndefined(); expect(f.trace.join('\n')).toContain('validation_summary_reconciliation_failed'); }
    }, 60000);
    it.each(['sha', 'dialect', 'header', 'missing', 'transform', 'PASS'])('refuses false source evidence or unsupported proposal %s without human structural handoff', async bad => {
        const { root, coding } = await setup(), f = await preparePiLargeCoordinatorSmoke(root, file(), { columns: ['key', 'payload', 'value [count]'], numeric: true, coding,
            proposal: original => {
                const p = structuredClone(original);
                if (bad === 'sha') p.stream.sha256 = 'f'.repeat(64);
                if (bad === 'dialect') p.stream.dialect.delimiter = ';';
                if (bad === 'header') p.stream.meaning.columns[0].name = 'fabricated';
                if (bad === 'missing') p.stream.meaning.columns.pop();
                if (bad === 'transform') return { ...p, transform: 'invented aggregation' };
                if (bad === 'PASS') return { ...p, decision: 'validated' };
                return p;
            } });
        expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined(); expect(root.getState().canonicalCsvData).toBeNull();
        expect(root.getState().pendingClarification).toBeNull(); expect(f.trace.join('\n')).not.toContain('"decision":"validated"');
    }, 60000);
    it('rejects forged PASS and duplicate/missing columns in the public schema, not just the compiler', async () => {
        const { root, coding } = await setup(), f = await preparePiLargeCoordinatorSmoke(root, file(), { numeric: true, columns: ['key', 'payload', 'value [count]'], coding });
        const manifest = createCandidateMeaningManifest();
        expect(isSpillMeaningProposal(f.proposal)).toBe(true); expect(manifest.validate?.(f.proposal, {} as never)).toEqual([]);
        for (const p of [{ ...f.proposal, decision: 'validated' }, { ...f.proposal, stream: { ...f.proposal.stream, meaning: { ...f.proposal.stream.meaning, columns: [f.proposal.stream.meaning.columns[0], f.proposal.stream.meaning.columns[0]] } } }]) {
            expect(isSpillMeaningProposal(p)).toBe(false); expect(manifest.validate?.(p, {} as never)?.length).toBeGreaterThan(0);
        }
    }, 60000);
});
