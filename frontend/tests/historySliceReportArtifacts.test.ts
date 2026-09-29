import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../store/useAppStore';
import { createHistorySlice } from '../store/slices/historySlice';

const {
    getReportMock,
    loadReportArtifactHtmlMock,
    hydrateLatestReportWorkspaceFilesMock,
    openReportArtifactMock,
    printReportArtifactMock,
} = vi.hoisted(() => ({
    getReportMock: vi.fn(),
    loadReportArtifactHtmlMock: vi.fn(),
    hydrateLatestReportWorkspaceFilesMock: vi.fn(async (workspaceFiles: Record<string, string>) => workspaceFiles),
    openReportArtifactMock: vi.fn(() => ({ closed: false })),
    printReportArtifactMock: vi.fn<() => { closed: boolean } | null>(() => ({ closed: false })),
}));

vi.mock('../services/storageService', () => ({
    getReportsList: vi.fn(async () => []),
    getReport: getReportMock,
    deleteReport: vi.fn(async () => undefined),
    saveReport: vi.fn(async () => undefined),
    CURRENT_SESSION_KEY: 'current_session',
}));

vi.mock('../services/reporting/reportArtifactViewer', () => ({
    openReportArtifact: openReportArtifactMock,
    printReportArtifact: printReportArtifactMock,
}));

vi.mock('../services/reporting/reportArtifactStorage', () => ({
    hydrateLatestReportWorkspaceFiles: hydrateLatestReportWorkspaceFilesMock,
    loadReportArtifactHtml: loadReportArtifactHtmlMock,
}));

vi.mock('../services/vectorStore', () => ({
    vectorStore: {
        clear: vi.fn(),
        schedulePersist: vi.fn(),
        loadFromStorage: vi.fn(async () => false),
    },
}));

vi.mock('../services/duckdb/queryEngine', () => ({
    disposeDuckDbQueryEngine: vi.fn(async () => undefined),
}));

vi.mock('../services/agent/memory/vectorMemorySync', () => ({
    rebuildVectorMemoryFromState: vi.fn(),
}));

const createHarness = () => {
    let state = {
        sessionId: 'session-1',
        addProgress: vi.fn(),
    } as unknown as AppStore;

    const setState = (partial: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) => {
        const next = typeof partial === 'function' ? partial(state) : partial;
        state = {
            ...state,
            ...next,
        };
    };

    const getState = () => state;
    const slice = createHistorySlice(setState as never, getState as never, {} as never);
    state = {
        ...state,
        ...slice,
    };

    return {
        getState: () => state,
    };
};

describe('historySlice report artifact actions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('loads archived report html through the artifact store when opening or printing a saved report', async () => {
        getReportMock.mockResolvedValue({
            id: 'report-1',
            filename: 'Executive Revenue Report Analyst Report',
            createdAt: new Date('2026-03-14T09:00:00.000Z'),
            updatedAt: new Date('2026-03-14T09:10:00.000Z'),
            appState: {
                workspaceFiles: {
                    '/workspace/reports/latest-analyst-report.manifest.json': JSON.stringify({
                        reportId: 'artifact-1',
                        artifactStatus: 'ready',
                    }),
                },
            },
        });
        loadReportArtifactHtmlMock.mockResolvedValue('<!DOCTYPE html><html><body>Archive</body></html>');
        const harness = createHarness();

        expect(await harness.getState().openPersistedReportArtifact('report-1')).toBe(true);
        expect(await harness.getState().exportPersistedReportPdf('report-1')).toBe(true);

        expect(loadReportArtifactHtmlMock).toHaveBeenCalledWith('artifact-1');
        expect(openReportArtifactMock).toHaveBeenCalledWith('<!DOCTYPE html><html><body>Archive</body></html>');
        expect(printReportArtifactMock).toHaveBeenCalledWith('<!DOCTYPE html><html><body>Archive</body></html>');
    });

    it('reports missing persisted artifacts safely', async () => {
        getReportMock
            .mockResolvedValueOnce({
                id: 'report-2',
                filename: 'Fallback Report',
                createdAt: new Date('2026-03-14T09:00:00.000Z'),
                updatedAt: new Date('2026-03-14T09:10:00.000Z'),
                appState: {
                    workspaceFiles: {
                        '/workspace/reports/latest-analyst-report.manifest.json': JSON.stringify({
                            reportId: 'artifact-2',
                            artifactStatus: 'ready',
                        }),
                    },
                },
            })
            .mockResolvedValueOnce(undefined);
        loadReportArtifactHtmlMock.mockResolvedValueOnce(null);
        const harness = createHarness();

        expect(await harness.getState().openPersistedReportArtifact('report-2')).toBe(false);
        expect(await harness.getState().openPersistedReportArtifact('missing-report')).toBe(false);

        expect(harness.getState().addProgress).toHaveBeenCalledWith('No saved report artifact was found for report-2.', 'error');
        expect(harness.getState().addProgress).toHaveBeenCalledWith('No saved report artifact was found for missing-report.', 'error');
    });

    it('reports a failed artifact read and a blocked PDF print view', async () => {
        getReportMock.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
        const harness = createHarness();

        await expect(harness.getState().openPersistedReportArtifact('report-1'))
            .rejects.toThrow('IndexedDB unavailable');
        expect(harness.getState().addProgress).toHaveBeenCalledWith('Failed to open the saved report for report-1.', 'error');

        getReportMock.mockResolvedValueOnce({
            id: 'report-1',
            appState: { workspaceFiles: {
                '/workspace/reports/latest-analyst-report.manifest.json': JSON.stringify({ reportId: 'artifact-1', artifactStatus: 'ready' }),
            } },
        });
        loadReportArtifactHtmlMock.mockResolvedValueOnce('<html>Report</html>');
        printReportArtifactMock.mockReturnValueOnce(null);

        expect(await harness.getState().exportPersistedReportPdf('report-1')).toBe(false);
        expect(harness.getState().addProgress).toHaveBeenCalledWith('Failed to open the saved report for PDF export: report-1.', 'error');
    });
});
