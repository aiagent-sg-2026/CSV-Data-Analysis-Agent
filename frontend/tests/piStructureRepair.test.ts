// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import { beginRun, beginSessionTransition, scopeRunStore, finishRun } from '../services/session/sessionOwnership';
import { prepareStructureRepair, STRUCTURE_REPAIR_SOURCE_BYTES } from '../services/agent/runtime/pi/piStructureRepair';
import type { CandidateValidationReceipt } from '../services/data/candidateStaging';
import { DEFAULT_TASK_LIMITS, createTaskBudget } from '../services/agent/runtime/pi/piTaskBudget';

const fixture = async (text = 'Key,Amount\na,1\n') => {
    const data = { fileName: 'synthetic.csv', data: [{ Key: 'a', Amount: 1 }] }, file = new File([text], data.fileName);
    let state = { sessionId: crypto.randomUUID(), settings: {}, workspaceFiles: {}, csvData: data, canonicalCsvData: null, addProgress() {} } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    const source = await captureCsvSource(root, file), bundle = createSingleTableDatasetBundle({ datasetId: 'synthetic', sourceFingerprint: source.sha256, file, data });
    root.setState({ datasetBundle: { ...bundle, source: { ...bundle.source, inspection: source } } });
    const lease = beginRun(root, 'initial_analysis', crypto.randomUUID()), store = scopeRunStore(root, lease);
    store.candidateStaging = { validationRequirements: () => ({ configured: true }) } as never;
    return { root, store, source, lease, code: { sources: [{ name: 'original', sourceId: source.sourceId, sha256: source.sha256, offset: 0, length: source.byteSize }] } };
};
const failed = { decision: 'invalid', reasonCodes: ['validation_value_mismatch'] } as unknown as CandidateValidationReceipt;

describe('owned bounded original-source repair phase', () => {
    it('refuses analysis, table meaning, partial source execution and execution before host meaning', async () => {
        const f = await fixture(); try {
            const repair = await prepareStructureRepair(f.store, 'repair');
            expect(repair.prompt).toContain('/intake/source-scan.json');
            expect(() => repair.beforeTool('data_query', {})).toThrow('analysis_locked');
            expect(() => repair.beforeTool('candidate_infer_meaning', { input: { kind: 'table' } })).toThrow('original_source');
            expect(() => repair.beforeTool('code_run', { sources: [{ ...f.code.sources[0], length: 1 }] })).toThrow('complete_original_source');
            expect(() => repair.beforeTool('code_run', { ...f.code, tables: [{}] })).toThrow('complete_original_source');
            f.store.candidateStaging = undefined;
            expect(() => repair.beforeTool('code_run', f.code)).toThrow('source_meaning_required');
            expect(repair.progress.attempts).toBe(0);
            expect(f.root.getState().canonicalCsvData).toBeNull();
        } finally { beginSessionTransition(f.root); }
    });
    it('allows validation of the third execution but never grants a fourth execution', async () => {
        const f = await fixture(); try {
            const repair = await prepareStructureRepair(f.store, 'repair');
            for (let i = 0; i < 3; i++) repair.beforeTool('code_run', f.code);
            repair.beforeTool('candidate_stage', {}); repair.beforeTool('candidate_validate', {});
            repair.afterTool('candidate_validate', { decision: 'validated' } as CandidateValidationReceipt);
            expect(repair.progress).toMatchObject({ state: 'validated_draft', attempts: 3, commitAllowed: false });
            repair.beforeTool('candidate_read', {}); repair.beforeTool('candidate_request_approval', {});
            expect(() => repair.beforeTool('code_run', f.code)).toThrow('exhausted');
        } finally { beginSessionTransition(f.root); }
    });
    it('retains attempts, independent failure signatures and task budgets across a fresh lease', async () => {
        const f = await fixture(); try {
            const repair = await prepareStructureRepair(f.store, 'repair');
            repair.beforeTool('code_run', f.code); repair.afterTool('candidate_validate', failed);
            const budget = { ...createTaskBudget(DEFAULT_TASK_LIMITS), used: { toolCalls: 7, skillReads: 1, providerTurns: 8, transformationAttempts: 1, activeMs: 100 } };
            repair.saveBudget(budget); finishRun(f.root, f.lease);
            const lease = beginRun(f.root, 'initial_analysis', crypto.randomUUID()), next = scopeRunStore(f.root, lease);
            next.candidateStaging = f.store.candidateStaging;
            const resumed = await prepareStructureRepair(next, 'repair');
            expect(resumed.recoveryBudget).toEqual(budget); expect(resumed.progress.attempts).toBe(1);
            resumed.beforeTool('code_run', f.code); resumed.afterTool('candidate_validate', failed);
            expect(resumed.progress).toMatchObject({ state: 'exhausted', validationFailures: 2, attempts: 2, resumable: false });
        } finally { beginSessionTransition(f.root); }
    });
    it('fences source replacement and in-place source metadata changes without publishing over replacement', async () => {
        const f = await fixture(); try {
            const repair = await prepareStructureRepair(f.store, 'repair');
            const inspection = { ...f.source }; f.root.setState(state => ({ datasetBundle: { ...state.datasetBundle!, source: { ...state.datasetBundle!.source, inspection } } }));
            expect(() => repair.current()).toThrow('source_range_stale');
            expect(() => repair.beforeTool('workspace_write', {})).toThrow('source_range_stale');
        } finally { beginSessionTransition(f.root); }
        const g = await fixture(); try {
            const inspection = { ...g.source }; g.root.setState(state => ({ datasetBundle: { ...state.datasetBundle!, source: { ...state.datasetBundle!.source, inspection } } }));
            const repair = await prepareStructureRepair(g.store, 'repair'); inspection.sha256 = '0'.repeat(64);
            expect(() => repair.current()).toThrow('source_range_stale');
        } finally { beginSessionTransition(g.root); }
    });
    it('revokes every continuation when the session changes', async () => {
        const f = await fixture(), repair = await prepareStructureRepair(f.store, 'repair');
        beginSessionTransition(f.root);
        expect(() => repair.current()).toThrow(); expect(() => repair.beforeTool('candidate_request_approval', {})).toThrow();
    });
    it('reports resource continuation, not a semantic question, for input outside this lane', async () => {
        const f = await fixture('Key,Amount\n' + 'a,1\n'.repeat(17000)); try {
            expect(f.source.byteSize).toBeGreaterThan(STRUCTURE_REPAIR_SOURCE_BYTES);
            await expect(prepareStructureRepair(f.store, 'repair')).rejects.toThrow('source_record_stream_and_spill_required');
            expect(JSON.parse(f.root.getState().workspaceFiles!['/intake/repair-task.json'])).toMatchObject({ state: 'unavailable', reason: 'source_record_stream_and_spill_required', commitAllowed: false });
            expect(f.root.getState().canonicalCsvData).toBeNull();
        } finally { beginSessionTransition(f.root); }
    });
});
