// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataPreparationWorkflowModal } from '../components/modals/DataPreparationWorkflowModal';
import * as useAppStoreModule from '../store/useAppStore';

vi.mock('../store/useAppStore', () => ({ useAppStore: vi.fn() }));
vi.mock('../components/data-preparation/workflowStore', () => ({
    pickDataPreparationWorkflowState: (state: unknown) => state,
}));
vi.mock('../services/agent/buildDataPreparationWorkflowBundle', () => ({
    buildDataPreparationWorkflowBundle: () => ({
        summary: { fileName: 'report.csv', issueCount: 1 },
        structureReview: {
            detectedBoundary: {
                headerRowIndex: 0,
                headerLayerRowIndexes: [0],
                bodyStartIndex: 1,
                summaryStartIndex: null,
                parameterRowIndexes: [],
                repeatedHeaderRowIndexes: [],
            },
        },
    }),
}));
vi.mock('../components/data-preparation/DataPreparationWorkflowContent', async () => {
    const React = await import('react');
    return {
        DataPreparationWorkflowContent: ({ onConfirmStructureBoundary, onSaveStructureBoundaryOverride }: {
            onConfirmStructureBoundary: () => void;
            onSaveStructureBoundaryOverride: (boundary: Record<string, unknown>) => void;
        }) => React.createElement('div', null,
            React.createElement('button', { onClick: onConfirmStructureBoundary }, 'Confirm detected boundary'),
            React.createElement('button', {
                onClick: () => onSaveStructureBoundaryOverride({
                    headerRowIndex: 0,
                    headerLayerRowIndexes: [0],
                    bodyStartIndex: 1,
                    summaryStartIndex: null,
                    parameterRowIndexes: [],
                    repeatedHeaderRowIndexes: [],
                }),
            }, 'Save boundary override'),
        ),
    };
});

describe('Data Preparation Workflow boundary failure', () => {
    afterEach(cleanup);

    it.each(['Confirm detected boundary', 'Save boundary override'])(
        'shows a retryable error when %s fails', async (buttonName) => {
            const saveBoundary = vi.fn()
                .mockRejectedValueOnce(new Error('Worker unavailable'))
                .mockResolvedValueOnce(undefined);
            const state = {
                isDataPreparationModalOpen: true,
                setIsDataPreparationModalOpen: vi.fn(),
                setIsWorkspaceModalOpen: vi.fn(),
                setIsDebugLogsModalOpen: vi.fn(),
                setIsAgentModalOpen: vi.fn(),
                sessionId: 'session-test',
                currentDatasetId: 'dataset-test',
                logAgentToolUsage: vi.fn(),
                syncTelemetryToStore: vi.fn(),
                saveReportStructureBoundaryOverride: saveBoundary,
                csvData: null,
                canonicalCsvData: null,
                settings: { language: 'English' },
                datasetBundle: null,
                agentEvents: [],
            };
            (useAppStoreModule.useAppStore as unknown as ReturnType<typeof vi.fn>)
                .mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

            render(<DataPreparationWorkflowModal />);
            fireEvent.click(screen.getByRole('button', { name: buttonName }));

            expect(await screen.findByRole('alert')).toHaveTextContent('Could not finish applying this data structure');
            expect(saveBoundary).toHaveBeenCalledTimes(1);

            fireEvent.click(screen.getByRole('button', { name: buttonName }));
            await waitFor(() => expect(saveBoundary).toHaveBeenCalledTimes(2));
            await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
        },
    );
});
