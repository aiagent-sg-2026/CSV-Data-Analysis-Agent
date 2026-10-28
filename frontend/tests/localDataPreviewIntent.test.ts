import { describe, expect, it, vi } from 'vitest';
import { createUISlice } from '../store/slices/uiSlice';
import { createLocalPreviewDraft } from '../services/agent/execution/workspaceDataQuery';
import type { AppStore } from '../store/useAppStore';
const setup = (overrides: Partial<AppStore> = {}) => {
    let state = { sessionId: 'local', csvData: { fileName: 'synthetic.csv', data: [{ Id: 'A', Amount: 123.45 }] },
        initialAnalysisFailureKind: 'cloud_consent_declined', isBusy: false, ...overrides } as AppStore;
    const set = (p: Partial<AppStore>) => { state = { ...state, ...p }; };
    state = { ...state, ...createUISlice(set as never, (() => state) as never, {} as never) };
    return { get: () => state };
};
describe('explicit local preview intent', () => {
    it('opens the existing explorer with a live source/session intent without changing data or dispatching AI', () => {
        const ai = vi.fn(), root = setup({ handleInitialAnalysis: ai }), before = root.get();
        before.openLocalDataPreview();
        expect(root.get().isDatabaseModalOpen).toBe(true);
        expect(root.get().localDataPreviewRequest).toEqual({ dataset: before.csvData, sessionId: 'local' });
        expect(root.get().csvData).toBe(before.csvData);
        expect(ai).not.toHaveBeenCalled();
        root.get().setIsDatabaseModalOpen(false);
        expect(root.get().localDataPreviewRequest).toBeNull();
        root.get().setIsDatabaseModalOpen(true);
        expect(root.get().localDataPreviewRequest).toBeNull();
    });
    it.each([{ csvData: null }, { csvData: { fileName: 'empty.csv', data: [] } }, { initialAnalysisFailureKind: 'provider' },
        { isBusy: true }, { datasetCommitBindingStatus: 'binding' }])('does not create intent for unavailable import %j', override => {
        const root = setup(override as Partial<AppStore>);
        root.get().openLocalDataPreview();
        expect(root.get().isDatabaseModalOpen).toBe(false);
        expect(root.get().localDataPreviewRequest).toBeNull();
    });
    it.each([5, 12, 40, 90])('bounds initial preview to 25 rows and at most 12 of %i columns', width => {
        const columns = Array.from({ length: width }, (_, i) => `Field${i}`), draft = createLocalPreviewDraft(columns);
        expect(draft.columns).toEqual(columns.slice(0, 12));
        expect(draft.limit).toBe(25);
        expect(draft.orderBy).toBeNull();
    });
});
