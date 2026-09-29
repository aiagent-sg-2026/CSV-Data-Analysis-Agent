import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceModal } from '../components/modals/WorkspaceModal';
import { HistoryPanel } from '../components/modals/HistoryPanel';
import { StorageBreakdown } from '../components/modals/StorageBreakdown';

const { useAppStoreMock, buildWorkspaceBundleMock, getStorageBreakdownMock, clearStoreMock, clearAllCacheStorageMock } = vi.hoisted(() => ({
    useAppStoreMock: vi.fn(),
    buildWorkspaceBundleMock: vi.fn(),
    getStorageBreakdownMock: vi.fn(),
    clearStoreMock: vi.fn(async () => 1),
    clearAllCacheStorageMock: vi.fn(async () => undefined),
}));

vi.mock('../store/useAppStore', () => ({
    useAppStore: useAppStoreMock,
}));

vi.mock('../services/agent/buildWorkspaceBundle', () => ({
    buildWorkspaceBundle: buildWorkspaceBundleMock,
}));

vi.mock('../services/storageService', () => ({
    CURRENT_SESSION_KEY: 'current_session',
    getStorageBreakdown: getStorageBreakdownMock,
    clearStore: clearStoreMock,
    clearAllCacheStorage: clearAllCacheStorageMock,
}));

vi.mock('../components/modals/WorkspaceModalEditor', () => ({
    WorkspaceModalEditor: () => <div data-testid="workspace-editor" />,
}));

describe('report artifact action surfaces', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buildWorkspaceBundleMock.mockReturnValue({
            files: [
                {
                    path: '/workspace/reports/latest-analyst-report.html',
                    label: 'latest-analyst-report.html',
                    content: '<!DOCTYPE html><html><body>Report</body></html>',
                    language: 'markdown',
                    group: 'reports',
                },
            ],
            primaryFiles: [
                {
                    path: '/workspace/reports/latest-analyst-report.html',
                    label: 'latest-analyst-report.html',
                    content: '<!DOCTYPE html><html><body>Report</body></html>',
                    language: 'markdown',
                    group: 'reports',
                },
            ],
            debugFiles: [],
            editableFiles: [],
        });
        getStorageBreakdownMock.mockResolvedValue({
            stores: [],
            cacheStorage: { cacheCount: 0, estimatedBytes: 0 },
            totalIdbBytes: 1024,
            totalWithCacheBytes: 1024,
            rawOriginBytes: 1024,
        });
    });

    afterEach(() => {
        cleanup();
    });

    it('renders workspace modal report actions and wires them to the store', () => {
        const openLatestAnalystReport = vi.fn();
        const exportLatestAnalystReportPdf = vi.fn();
        const state = {
            isWorkspaceModalOpen: true,
            setIsWorkspaceModalOpen: vi.fn(),
            logAgentToolUsage: vi.fn(),
            openLatestAnalystReport,
            exportLatestAnalystReportPdf,
            workspaceFiles: {
                '/workspace/reports/latest-analyst-report.manifest.json': JSON.stringify({
                    reportId: 'report-1',
                    title: 'Executive Revenue Report Analyst Report',
                    generatedAt: '2026-03-14T09:00:00.000Z',
                    artifactStatus: 'ready',
                    generationGate: 'allowed',
                    reportReadiness: 'ready',
                    reportReadinessReason: 'Ready',
                    trustedCardsCount: 1,
                    excludedEvidenceCount: 0,
                    gateReasons: [],
                    llmUsed: true,
                    fallbacksUsed: [],
                    latestFiles: {
                        html: '/workspace/reports/latest-analyst-report.html',
                        manifest: '/workspace/reports/latest-analyst-report.manifest.json',
                        readiness: '/workspace/reports/latest-analyst-report.readiness.json',
                    },
                    archiveFiles: {
                        html: '/workspace/reports/report-1.html',
                        manifest: '/workspace/reports/report-1.manifest.json',
                        readiness: '/workspace/reports/report-1.readiness.json',
                    },
                }),
                '/workspace/reports/latest-analyst-report.html': '<!DOCTYPE html><html><body>Report</body></html>',
            },
            sessionId: 'session-1',
            currentDatasetId: 'dataset-1',
            confirmedAnalysisGoal: null,
            settings: { language: 'English' },
            csvData: null,
            rawCsvData: null,
            initialDataSample: null,
            columnProfiles: [],
            analysisCards: [],
            chatHistory: [],
            dataPreparationPlan: null,
            spreadsheetFilterFunction: null,
            activeSpreadsheetFilter: null,
            aiFilterExplanation: null,
            activeDataQuery: null,
            dataQualityIssues: null,
            finalSummary: null,
            agentEvents: [],
            agentToolLogs: [],
            telemetryEvents: [],
            workspaceActionHistory: [],
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<WorkspaceModal />);

        fireEvent.click(screen.getByRole('button', { name: 'Open Report' }));
        fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));

        expect(openLatestAnalystReport).toHaveBeenCalledTimes(1);
        expect(exportLatestAnalystReportPdf).toHaveBeenCalledTimes(1);
    });

    it('renders history panel report actions and wires them to the store', async () => {
        const openPersistedReportArtifact = vi.fn(async () => undefined);
        const exportPersistedReportPdf = vi.fn(async () => undefined);
        const handleLoadReport = vi.fn(async () => undefined);
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [
                {
                    id: 'report-1',
                    filename: 'Executive Revenue Report Analyst Report',
                    createdAt: new Date('2026-03-14T09:00:00.000Z'),
                    updatedAt: new Date('2026-03-14T09:10:00.000Z'),
                },
            ],
            handleLoadReport,
            handleDeleteReport: vi.fn(async () => undefined),
            openPersistedReportArtifact,
            exportPersistedReportPdf,
            sessionId: 'session-2',
            settings: { language: 'English' },
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);

        fireEvent.click(screen.getByRole('button', { name: 'Resume analysis' }));
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open Report' })));
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Export PDF' })));

        expect(handleLoadReport).toHaveBeenCalledWith('report-1');
        expect(openPersistedReportArtifact).toHaveBeenCalledWith('report-1');
        expect(exportPersistedReportPdf).toHaveBeenCalledWith('report-1');
    });

    it('keeps History open with a retry when a saved report cannot be loaded', async () => {
        const handleLoadReport = vi.fn()
            .mockRejectedValueOnce(new Error('IndexedDB unavailable'))
            .mockResolvedValueOnce(undefined);
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [{
                id: 'report-1', filename: 'sample.csv',
                createdAt: new Date('2026-03-14T09:00:00.000Z'),
                updatedAt: new Date('2026-03-14T09:10:00.000Z'),
            }],
            handleLoadReport,
            handleDeleteReport: vi.fn(async () => undefined),
            handlePurgeStorage: vi.fn(async () => ({ deletedReports: 0, freedMB: 0 })),
            openPersistedReportArtifact: vi.fn(async () => undefined),
            exportPersistedReportPdf: vi.fn(async () => undefined),
            sessionId: 'session-2',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Resume analysis' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the saved analysis');
        fireEvent.click(screen.getByRole('button', { name: 'Retry loading report' }));
        await waitFor(() => expect(handleLoadReport).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByText(/Could not load the saved analysis/)).not.toBeInTheDocument());
    });

    it('offers a retry when opening a saved report fails', async () => {
        const openPersistedReportArtifact = vi.fn()
            .mockRejectedValueOnce(new Error('artifact read unavailable'))
            .mockResolvedValueOnce(true);
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [{
                id: 'report-1', filename: 'sample.csv',
                createdAt: new Date('2026-03-14T09:00:00.000Z'),
                updatedAt: new Date('2026-03-14T09:10:00.000Z'),
            }],
            handleLoadReport: vi.fn(async () => undefined),
            handleDeleteReport: vi.fn(async () => undefined),
            handlePurgeStorage: vi.fn(async () => ({ deletedReports: 0, freedMB: 0 })),
            openPersistedReportArtifact,
            exportPersistedReportPdf: vi.fn(async () => true),
            sessionId: 'report-1',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Open Report' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not open the saved report');
        fireEvent.click(screen.getByRole('button', { name: 'Retry opening report' }));
        await waitFor(() => expect(openPersistedReportArtifact).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByText(/Could not open the saved report/)).not.toBeInTheDocument());
    });

    it('does not show an old report-action failure after History closes and reopens', async () => {
        let settleOpen!: (succeeded: boolean) => void;
        const openPersistedReportArtifact = vi.fn(() => new Promise<boolean>(resolve => {
            settleOpen = resolve;
        }));
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [{
                id: 'report-1', filename: 'sample.csv',
                createdAt: new Date('2026-03-14T09:00:00.000Z'),
                updatedAt: new Date('2026-03-14T09:10:00.000Z'),
            }],
            handleLoadReport: vi.fn(async () => undefined),
            handleDeleteReport: vi.fn(async () => undefined),
            handlePurgeStorage: vi.fn(async () => ({ deletedReports: 0, freedMB: 0 })),
            openPersistedReportArtifact,
            exportPersistedReportPdf: vi.fn(async () => true),
            sessionId: 'report-1',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        const { rerender } = render(<HistoryPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Open Report' }));
        expect(openPersistedReportArtifact).toHaveBeenCalledTimes(1);

        state.isHistoryPanelOpen = false;
        rerender(<HistoryPanel />);
        await act(async () => settleOpen(false));
        state.isHistoryPanelOpen = true;
        rerender(<HistoryPanel />);

        expect(screen.queryByText(/Could not open the saved report/)).not.toBeInTheDocument();
    });

    it('does not carry a late saved-analysis load failure into a new History opening', async () => {
        let rejectLoad!: (reason: Error) => void;
        const handleLoadReport = vi.fn(() => new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
        }));
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [{
                id: 'report-1', filename: 'sample.csv',
                createdAt: new Date('2026-03-14T09:00:00.000Z'),
                updatedAt: new Date('2026-03-14T09:10:00.000Z'),
            }],
            handleLoadReport,
            handleDeleteReport: vi.fn(async () => undefined),
            handlePurgeStorage: vi.fn(async () => ({ deletedReports: 0, freedMB: 0 })),
            openPersistedReportArtifact: vi.fn(async () => true),
            exportPersistedReportPdf: vi.fn(async () => true),
            sessionId: 'session-2',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        const { rerender } = render(<HistoryPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Resume analysis' }));
        expect(handleLoadReport).toHaveBeenCalledTimes(1);

        state.isHistoryPanelOpen = false;
        rerender(<HistoryPanel />);
        await act(async () => rejectLoad(new Error('IndexedDB unavailable')));
        state.isHistoryPanelOpen = true;
        rerender(<HistoryPanel />);

        expect(screen.queryByText(/Could not load the saved analysis/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Resume analysis' })).toBeEnabled();
    });

    it('shows a retry when PDF export cannot open a print view', async () => {
        const exportPersistedReportPdf = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [{
                id: 'report-1', filename: 'sample.csv',
                createdAt: new Date('2026-03-14T09:00:00.000Z'),
                updatedAt: new Date('2026-03-14T09:10:00.000Z'),
            }],
            handleLoadReport: vi.fn(async () => undefined),
            handleDeleteReport: vi.fn(async () => undefined),
            handlePurgeStorage: vi.fn(async () => ({ deletedReports: 0, freedMB: 0 })),
            openPersistedReportArtifact: vi.fn(async () => true),
            exportPersistedReportPdf,
            sessionId: 'session-2',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not start PDF export');
        fireEvent.click(screen.getByRole('button', { name: 'Retry PDF export' }));
        await waitFor(() => expect(exportPersistedReportPdf).toHaveBeenCalledTimes(2));
    });

    it('confirms report deletion inside History before calling the store', async () => {
        const handleDeleteReport = vi.fn(async () => undefined);
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [{
                id: 'report-1', filename: 'sample.csv',
                createdAt: new Date('2026-03-14T09:00:00.000Z'),
                updatedAt: new Date('2026-03-14T09:10:00.000Z'),
            }],
            handleLoadReport: vi.fn(async () => undefined),
            handleDeleteReport,
            handlePurgeStorage: vi.fn(async () => ({ deletedReports: 1, freedMB: 1 })),
            openPersistedReportArtifact: vi.fn(async () => undefined),
            exportPersistedReportPdf: vi.fn(async () => undefined),
            sessionId: 'session-2',
            settings: { language: 'English' },
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));
        render(<HistoryPanel />);

        fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(handleDeleteReport).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog')).toHaveTextContent('sample.csv');
        const cancel = screen.getByRole('button', { name: 'Cancel' });
        const confirm = screen.getByRole('button', { name: 'Delete report' });
        expect(cancel).toHaveFocus();
        fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
        expect(confirm).toHaveFocus();
        fireEvent.keyDown(confirm, { key: 'Tab' });
        expect(cancel).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(handleDeleteReport).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete report' }));
        await waitFor(() => expect(handleDeleteReport).toHaveBeenCalledExactlyOnceWith('report-1'));
    });

    it('keeps History data when the Clear all confirmation is cancelled', async () => {
        const handlePurgeStorage = vi.fn(async () => ({ deletedReports: 1, freedMB: 1 }));
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [{
                id: 'report-1', filename: 'sample.csv',
                createdAt: new Date('2026-03-14T09:00:00.000Z'),
                updatedAt: new Date('2026-03-14T09:10:00.000Z'),
            }],
            handleLoadReport: vi.fn(async () => undefined),
            handleDeleteReport: vi.fn(async () => undefined),
            handlePurgeStorage,
            openPersistedReportArtifact: vi.fn(async () => undefined),
            exportPersistedReportPdf: vi.fn(async () => undefined),
            sessionId: 'session-2',
            settings: { language: 'English' },
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));
        render(<HistoryPanel />);

        fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
        expect(handlePurgeStorage).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog')).toHaveTextContent('1 history record');
        fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(handlePurgeStorage).not.toHaveBeenCalled();
        expect(state.setIsHistoryPanelOpen).not.toHaveBeenCalled();

        handlePurgeStorage.mockRejectedValueOnce(new Error('storage unavailable'));
        fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
        fireEvent.click(screen.getByRole('button', { name: 'Clear history now' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not complete deletion');
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Clear history now' }));
        await waitFor(() => expect(handlePurgeStorage).toHaveBeenCalledTimes(2));
    });

    it('hides delete actions for protected current-session aliases in grouped history rows', () => {
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [
                {
                    id: 'session-2',
                    filename: 'Executive Revenue Report Analyst Report',
                    createdAt: new Date('2026-03-14T09:00:00.000Z'),
                    updatedAt: new Date('2026-03-14T09:10:00.000Z'),
                },
                {
                    id: 'current_session',
                    filename: 'Executive Revenue Report Analyst Report',
                    createdAt: new Date('2026-03-14T09:00:00.000Z'),
                    updatedAt: new Date('2026-03-14T09:09:00.000Z'),
                },
                {
                    id: 'report-1',
                    filename: 'Executive Revenue Report Analyst Report',
                    createdAt: new Date('2026-03-14T08:00:00.000Z'),
                    updatedAt: new Date('2026-03-14T08:10:00.000Z'),
                },
            ],
            handleLoadReport: vi.fn(async () => undefined),
            handleDeleteReport: vi.fn(async () => undefined),
            openPersistedReportArtifact: vi.fn(async () => undefined),
            exportPersistedReportPdf: vi.fn(async () => undefined),
            sessionId: 'session-2',
            settings: { language: 'English' },
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);

        fireEvent.click(screen.getByRole('button', { name: '+2 previous version(s)' }));
        fireEvent.click(screen.getAllByTitle('More actions')[1]);

        expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

        fireEvent.click(screen.getAllByTitle('More actions')[2]);

        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('finds a previous version by its title and reveals that version', () => {
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [
                { id: 'new', filename: 'sample.csv', reportTitle: 'Latest overview', createdAt: new Date('2026-03-14T09:00:00.000Z'), updatedAt: new Date('2026-03-14T09:10:00.000Z') },
                { id: 'old', filename: 'sample.csv', reportTitle: 'Regional trends', createdAt: new Date('2026-03-13T09:00:00.000Z'), updatedAt: new Date('2026-03-13T09:10:00.000Z') },
                { id: 'other', filename: 'other.csv', reportTitle: 'Other analysis', createdAt: new Date('2026-03-12T09:00:00.000Z'), updatedAt: new Date('2026-03-12T09:10:00.000Z') },
            ],
            handleLoadReport: vi.fn(async () => undefined),
            handleDeleteReport: vi.fn(async () => undefined),
            handlePurgeStorage: vi.fn(async () => undefined),
            openPersistedReportArtifact: vi.fn(async () => undefined),
            exportPersistedReportPdf: vi.fn(async () => undefined),
            sessionId: 'session-2',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);
        fireEvent.change(screen.getByPlaceholderText('Search by title or file name...'), { target: { value: 'regional' } });

        expect(screen.getByText('Regional trends')).toBeInTheDocument();
        expect(screen.getByText('Previous version')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '+1 previous version(s)' })).toHaveAttribute('aria-expanded', 'true');
        expect(screen.queryByText('Other analysis')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '+1 previous version(s)' }));
        expect(screen.queryByText('Regional trends')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: '+1 previous version(s)' })).toHaveAttribute('aria-expanded', 'false');

        fireEvent.click(screen.getByRole('button', { name: '+1 previous version(s)' }));
        expect(screen.getByText('Regional trends')).toBeInTheDocument();
    });

    it('shows a visible retry state when history storage cannot be read', async () => {
        getStorageBreakdownMock.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [],
            handleLoadReport: vi.fn(),
            handleDeleteReport: vi.fn(),
            handlePurgeStorage: vi.fn(),
            openPersistedReportArtifact: vi.fn(),
            exportPersistedReportPdf: vi.fn(),
            sessionId: 'session-2',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Storage is temporarily unavailable');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(getStorageBreakdownMock).toHaveBeenCalledTimes(2));
        expect(screen.queryByText('0 B')).not.toBeInTheDocument();
    });

    it('shows a retry instead of an empty history when the saved-report list fails to load', async () => {
        const loadReportsListIfNeeded = vi.fn().mockRejectedValueOnce(new Error('IndexedDB unavailable'));
        const loadReportsList = vi.fn().mockResolvedValueOnce(undefined);
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [],
            loadReportsListIfNeeded,
            loadReportsList,
            handleLoadReport: vi.fn(async () => undefined),
            handleDeleteReport: vi.fn(async () => undefined),
            handlePurgeStorage: vi.fn(async () => ({ deletedReports: 0, freedMB: 0 })),
            openPersistedReportArtifact: vi.fn(async () => true),
            exportPersistedReportPdf: vi.fn(async () => true),
            sessionId: 'session-2',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not load analysis history');
        expect(screen.queryByText('No past reports found. Upload a CSV to start.')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Retry history list' }));
        await waitFor(() => expect(loadReportsList).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByText(/Could not load analysis history/)).not.toBeInTheDocument());
    });

    it('keeps already listed reports visible when refreshing History fails', async () => {
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [{
                id: 'report-1', filename: 'sample.csv',
                createdAt: new Date('2026-03-14T09:00:00.000Z'),
                updatedAt: new Date('2026-03-14T09:10:00.000Z'),
            }],
            loadReportsListIfNeeded: vi.fn().mockRejectedValueOnce(new Error('IndexedDB unavailable')),
            loadReportsList: vi.fn(async () => undefined),
            handleLoadReport: vi.fn(async () => undefined),
            handleDeleteReport: vi.fn(async () => undefined),
            handlePurgeStorage: vi.fn(async () => ({ deletedReports: 0, freedMB: 0 })),
            openPersistedReportArtifact: vi.fn(async () => true),
            exportPersistedReportPdf: vi.fn(async () => true),
            sessionId: 'session-2',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not load analysis history');
        expect(screen.getByText('sample.csv')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Resume analysis' })).toBeEnabled();
    });

    it('labels local storage without implying a fixed capacity limit', async () => {
        getStorageBreakdownMock.mockResolvedValueOnce({
            stores: [],
            cacheStorage: { cacheCount: 0, estimatedBytes: 0 },
            totalIdbBytes: 97_097_728,
            totalWithCacheBytes: 97_097_728,
            rawOriginBytes: 97_097_728,
        });
        const state = {
            isHistoryPanelOpen: true,
            setIsHistoryPanelOpen: vi.fn(),
            reportsList: [],
            handleLoadReport: vi.fn(),
            handleDeleteReport: vi.fn(),
            handlePurgeStorage: vi.fn(),
            openPersistedReportArtifact: vi.fn(),
            exportPersistedReportPdf: vi.fn(),
            sessionId: 'session-2',
            settings: { language: 'English' },
            csvData: null,
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<HistoryPanel />);

        const storageButton = await screen.findByRole('button', { name: /Local data\s+92\.6 MB/ });
        expect(storageButton).toHaveAttribute('title', 'Local browser data uses 92.6 MB. View details.');
        expect(storageButton.querySelector('[class*="bg-amber"]')).not.toBeInTheDocument();
    });

    it('separates the scanned storage total from the browser origin estimate', async () => {
        const mib = 1024 * 1024;
        getStorageBreakdownMock.mockResolvedValueOnce({
            stores: [{ storeName: 'reports', label: 'Reports (sessions)', recordCount: 1, estimatedBytes: 17 * mib }],
            cacheStorage: { cacheCount: 2, estimatedBytes: 39 * mib },
            totalIdbBytes: 17 * mib,
            totalWithCacheBytes: 56 * mib,
            rawOriginBytes: 48 * mib,
        });

        render(<StorageBreakdown activeSessionId={null} />);

        expect(await screen.findByRole('group', { name: 'Scanned total: 56.0 MB' })).toBeInTheDocument();
        expect(screen.getByText(/Browser origin estimate: 48\.0 MB/)).toBeInTheDocument();
        expect(screen.queryByText('Total (with cache): 48.0 MB')).not.toBeInTheDocument();
        const reportShare = parseFloat(screen.getByTitle('Reports (sessions): 17.0 MB').style.width);
        const cacheShare = parseFloat(screen.getByTitle('Cache Storage: 39.0 MB').style.width);
        expect(reportShare).toBeCloseTo((17 / 56) * 100);
        expect(reportShare + cacheShare).toBeCloseTo(100);
    });

    it('requires an explicit second action before clearing a storage category or browser caches', async () => {
        getStorageBreakdownMock.mockResolvedValue({
            stores: [{ storeName: 'agent_memory_runs', label: 'Agent Memory Runs', recordCount: 1, estimatedBytes: 1024 }],
            cacheStorage: { cacheCount: 1, estimatedBytes: 2048 },
            totalIdbBytes: 1024,
            totalWithCacheBytes: 3072,
            rawOriginBytes: 3072,
        });
        render(<StorageBreakdown activeSessionId={null} />);
        const clearMemory = await screen.findByRole('button', { name: 'Clear Agent Memory Runs' });
        const clearCache = screen.getByRole('button', { name: 'Clear Cache Storage' });

        fireEvent.click(clearMemory);
        let confirmation = screen.getByRole('alertdialog');
        expect(confirmation).toHaveTextContent('Clear Agent Memory Runs?');
        expect(clearStoreMock).not.toHaveBeenCalled();
        await waitFor(() => expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus());
        fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(clearStoreMock).not.toHaveBeenCalled();

        fireEvent.click(clearCache);
        confirmation = screen.getByRole('alertdialog');
        expect(confirmation).toHaveTextContent('Offline app assets and models may need to be downloaded again.');
        const parentEscapeHandler = vi.fn();
        document.addEventListener('keydown', parentEscapeHandler);
        try {
            fireEvent.keyDown(confirmation, { key: 'Escape' });
        } finally {
            document.removeEventListener('keydown', parentEscapeHandler);
        }
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(parentEscapeHandler).not.toHaveBeenCalled();
        expect(clearAllCacheStorageMock).not.toHaveBeenCalled();

        fireEvent.click(clearMemory);
        confirmation = screen.getByRole('alertdialog');
        fireEvent.click(within(confirmation).getByRole('button', { name: 'Clear now' }));
        await waitFor(() => expect(clearStoreMock).toHaveBeenCalledWith('agent_memory_runs', undefined));

        fireEvent.click(clearCache);
        confirmation = screen.getByRole('alertdialog');
        fireEvent.click(within(confirmation).getByRole('button', { name: 'Clear now' }));
        await waitFor(() => expect(clearAllCacheStorageMock).toHaveBeenCalledTimes(1));
    });

    it('shows a retry path when the storage inspector scan fails', async () => {
        getStorageBreakdownMock.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
        getStorageBreakdownMock.mockResolvedValueOnce({
            stores: [],
            cacheStorage: { cacheCount: 0, estimatedBytes: 0 },
            totalIdbBytes: 0,
            totalWithCacheBytes: 0,
            rawOriginBytes: 0,
        });

        render(<StorageBreakdown activeSessionId={null} />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Could not read storage details');
        fireEvent.click(screen.getByRole('button', { name: 'Retry storage scan' }));
        expect(await screen.findByRole('group', { name: 'Scanned total: 0 B' })).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('reports a failed clear while keeping the category visible for review', async () => {
        getStorageBreakdownMock.mockResolvedValue({
            stores: [{ storeName: 'agent_memory_runs', label: 'Agent Memory Runs', recordCount: 1, estimatedBytes: 1024 }],
            cacheStorage: { cacheCount: 0, estimatedBytes: 0 },
            totalIdbBytes: 1024,
            totalWithCacheBytes: 1024,
            rawOriginBytes: 1024,
        });
        clearStoreMock.mockRejectedValueOnce(new Error('write failed'));

        render(<StorageBreakdown activeSessionId={null} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Clear Agent Memory Runs' }));
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear now' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Could not clear this category');
        expect(screen.getByRole('button', { name: 'Clear Agent Memory Runs' })).toBeInTheDocument();
    });
});
