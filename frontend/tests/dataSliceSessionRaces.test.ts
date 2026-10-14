import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataSlice } from '../store/slices/dataSlice';
import { beginRun, beginSessionTransition, finishRun } from '../services/session/sessionOwnership';
import { buildSemanticDatasetVersion, sanitizeDatasetSemanticSnapshot } from '../services/agent/datasetSemantics';
const annotate = vi.hoisted(() => vi.fn());
const resolveStructure = vi.hoisted(() => vi.fn());
vi.mock('../services/ai/datasetSemanticAnnotator', () => ({ annotateDatasetSemantics: annotate }));
vi.mock('../services/agent/orchestration/reportStructureOrchestrator', () => ({ resolveReportStructureArtifactsWithProposal: resolveStructure }));

describe('semantic snapshot ownership', () => {
    beforeEach(() => { annotate.mockReset(); resolveStructure.mockReset(); });
    it.each(['ready', 'cached', 'unbound', 'dimension', 'wrong_version', 'wrong_count'])(
        'preserves exact accepted fact membership only for a current bound commit: %s', async mode => {
            const dataset = { fileName: 'facts.csv', data: [{ Name: 'Total Solutions', Amount: 0 }, { Name: 'Detail', Amount: -5 }] };
            const version = buildSemanticDatasetVersion(dataset);
            const snapshot = sanitizeDatasetSemanticSnapshot({}, dataset, 'mock', version);
            expect(snapshot.recommendedAnalysisView.excludedRowIndices).toEqual([0]);
            let state: any = { sessionId: `accepted-${mode}`, csvData: dataset, canonicalCsvData: dataset, rawCsvData: dataset,
                columnProfiles: [{ name: 'Name', type: 'categorical' }, { name: 'Amount', type: 'numerical' }],
                settings: { language: 'English', provider: 'default' }, progressMessages: [], addProgress: vi.fn(),
                datasetBundle: { primaryTableId: 'facts', datasetVersion: mode === 'wrong_version' ? 'old' : version,
                    acceptedCommit: { commitId: 'exact' }, tables: [{ tableId: 'facts', datasetVersion: version,
                        role: mode === 'dimension' ? 'dimension' : 'fact', rowCount: mode === 'wrong_count' ? 1 : 2 }] },
                datasetCommitBindingStatus: mode === 'unbound' ? 'awaiting_source' : 'ready',
                semanticStatus: mode === 'cached' ? 'ready' : 'idle', semanticDatasetVersion: mode === 'cached' ? version : null,
                datasetSemanticSnapshot: mode === 'cached' ? snapshot : null };
            const get = () => state;
            const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
            Object.assign(state, createDataSlice(set as never, get as never, {} as never));
            annotate.mockResolvedValue(snapshot);
            const result = await state.ensureDatasetSemanticSnapshot(dataset);
            expect(result.recommendedAnalysisView.excludedRowIndices).toEqual(['ready', 'cached'].includes(mode) ? [] : [0]);
            expect(state.csvData).toBe(dataset);
            expect(snapshot.recommendedAnalysisView.excludedRowIndices).toEqual([0]);
        },
    );
    it('fences a cancelled nested structure rebuild from a later run in the same session', async () => {
        const dataset = { fileName: 'synthetic.csv', data: [{ Amount: 10 }] };
        let state: any = { sessionId: 'same', csvData: dataset, rawCsvData: dataset, canonicalCsvData: null,
            columnProfiles: [{ name: 'Amount', type: 'numerical' }], columnRegistry: null, settings: { provider: 'default' } };
        const get = () => state;
        const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
        const store = { getState: get, setState: set };
        Object.assign(state, createDataSlice(set as never, get as never, {} as never));
        let entered!: () => void, release!: (value: unknown) => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        resolveStructure.mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
        const old = beginRun(store as never, 'follow_up', 'old', 'old-turn');
        const rebuilding = state.saveReportStructureBoundaryOverride({});
        await started;
        finishRun(store as never, old);
        const current = beginRun(store as never, 'follow_up', 'new', 'new-turn');
        const replacement = { ...dataset, data: [{ Amount: 20 }] };
        set({ csvData: replacement, canonicalCsvData: replacement });
        release({ canonicalCsvData: dataset });
        await rebuilding;
        expect(state.canonicalCsvData).toBe(replacement);
        expect(state.activeExecution.runId).toBe('new');
        finishRun(store as never, current);
    });

    it('keeps identical files in separate session epochs and preserves the new in-flight entry', async () => {
        const dataset = { fileName: 'synthetic.csv', data: [{ Town: 'A', Amount: 10 }] };
        let state: any = { sessionId: 'old', csvData: dataset, canonicalCsvData: null, rawCsvData: dataset,
            columnProfiles: [{ name: 'Town', type: 'categorical', missingCount: 0 }, { name: 'Amount', type: 'numerical', missingCount: 0 }],
            columnRegistry: null, semanticStatus: 'idle', semanticDatasetVersion: null, datasetSemanticSnapshot: null,
            settings: { language: 'English', provider: 'default' }, progressMessages: [], addProgress: vi.fn() };
        const get = () => state;
        const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
        const store = { getState: get, setState: set };
        Object.assign(state, createDataSlice(set as never, get as never, {} as never));
        let oldStarted!: () => void, newStarted!: () => void;
        let oldResolve!: (value: unknown) => void, newResolve!: (value: unknown) => void;
        const enteredOld = new Promise<void>(resolve => { oldStarted = resolve; });
        const enteredNew = new Promise<void>(resolve => { newStarted = resolve; });
        const oldPending = new Promise(resolve => { oldResolve = resolve; });
        const newPending = new Promise(resolve => { newResolve = resolve; });
        annotate.mockImplementationOnce(() => { oldStarted(); return oldPending; })
            .mockImplementationOnce(() => { newStarted(); return newPending; });
        const old = state.ensureDatasetSemanticSnapshot();
        await enteredOld;
        beginSessionTransition(store as never);
        set({ sessionId: 'new', semanticStatus: 'idle', semanticDatasetVersion: null });
        const current = state.ensureDatasetSemanticSnapshot();
        await enteredNew;
        const snapshot = { sourceDatasetVersion: buildSemanticDatasetVersion(dataset), modelId: 'mock',
            datasetRole: 'detail', rowAnnotations: [], columnAnnotations: [], recommendedAnalysisView: { excludedRowIndices: [], excludedColumns: [] }, summary: 'synthetic' };
        oldResolve({ ...snapshot, summary: 'old' });
        await old;
        expect(state.datasetSemanticSnapshot).toBeNull();
        const reused = state.ensureDatasetSemanticSnapshot();
        newResolve(snapshot);
        await Promise.all([current, reused]);
        expect(annotate).toHaveBeenCalledTimes(2);
        expect(state.datasetSemanticSnapshot.summary).toBe('synthetic');
        expect(state.semanticStatus).toBe('ready');
    });
});
