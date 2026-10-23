import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportBoundaryConfirmModal } from '../components/modals/ReportBoundaryConfirmModal';
import * as useAppStoreModule from '../store/useAppStore';

vi.mock('../store/useAppStore', () => ({
    useAppStore: vi.fn(),
}));

const mockStore = (overrides: {
    summaryStartIndex: number | null;
    normalizedRows: string[][];
    saveBoundary?: ReturnType<typeof vi.fn>;
}) => {
    const store = {
        isReportBoundaryConfirmModalOpen: true,
        setIsReportBoundaryConfirmModalOpen: vi.fn(),
        reportStructureResolution: {
            headerRowIndex: 0,
            headerLayerRowIndexes: [],
            bodyStartIndex: 1,
            summaryStartIndex: overrides.summaryStartIndex,
            parameterRowIndexes: [],
            repeatedHeaderRowIndexes: [],
            blockingReasons: ['detail_series_coverage_rate'],
            requiresHumanReview: true,
            decision: {
                targetShape: 'row_table',
                shouldCanonicalize: false,
                reason: 'Structure needs review: detail_series_coverage_rate.',
            },
        },
        rawIntakeIr: { normalizedRows: overrides.normalizedRows },
        saveReportStructureBoundaryOverride: overrides.saveBoundary ?? vi.fn(async () => undefined),
        isBusy: false,
        settings: { language: 'English' },
        pipelineOutcome: {
            status: 'needs_structure_review',
            canAutoAnalyze: false,
            severity: 'warning',
            reasonCode: 'detail_series_coverage_rate',
            message: 'Structure review is required before automatic analysis. Structure needs review: detail_series_coverage_rate.',
        },
        cleaningRun: null,
        columnProfiles: [],
        userColumnAnnotations: {},
        setColumnAnnotation: vi.fn(),
    };
    (useAppStoreModule.useAppStore as unknown as ReturnType<typeof vi.fn>)
        .mockImplementation((selector: (value: typeof store) => unknown) => selector(store));
    return store;
};

const getSummaryCard = () => screen.getByText('Summary Rows').parentElement as HTMLElement;

describe('ReportBoundaryConfirmModal guided repair', () => {
    afterEach(() => cleanup());

    it('explains the block, allows field-role correction, and waits for explicit confirmation', async () => {
        const saveBoundary = vi.fn(async () => undefined);
        const setColumnAnnotation = vi.fn();
        const store = {
            isReportBoundaryConfirmModalOpen: true,
            setIsReportBoundaryConfirmModalOpen: vi.fn(),
            reportStructureResolution: {
                headerRowIndex: 0,
                headerLayerRowIndexes: [0],
                bodyStartIndex: 1,
                summaryStartIndex: null,
                parameterRowIndexes: [],
                repeatedHeaderRowIndexes: [],
                decision: {
                    targetShape: 'row_table',
                    shouldCanonicalize: true,
                    reason: 'The header boundary is uncertain.',
                },
            },
            rawIntakeIr: {
                normalizedRows: [
                    ['Project', 'Amount'],
                    ['Alpha', '1200'],
                    ['Beta', '900'],
                ],
            },
            saveReportStructureBoundaryOverride: saveBoundary,
            isBusy: false,
            settings: { language: 'English' },
            pipelineOutcome: {
                status: 'needs_structure_review',
                canAutoAnalyze: false,
                severity: 'warning',
                reasonCode: 'header_shape_drift',
                message: 'Structure review is required before automatic analysis.',
            },
            cleaningRun: { loopCount: 2 },
            columnProfiles: [
                { name: 'Project', type: 'categorical' },
                { name: 'Amount', type: 'numerical' },
            ],
            userColumnAnnotations: {},
            setColumnAnnotation,
        };

        (useAppStoreModule.useAppStore as unknown as ReturnType<typeof vi.fn>)
            .mockImplementation((selector: (value: typeof store) => unknown) => selector(store));

        render(<ReportBoundaryConfirmModal />);

        expect(screen.getByRole('dialog', { name: 'Review and repair data structure' })).toBeInTheDocument();
        expect(screen.getByText('Why continuing is unsafe')).toBeInTheDocument();
        expect(screen.queryByText(/Auto-confirm/i)).not.toBeInTheDocument();

        fireEvent.change(screen.getByRole('combobox', { name: 'Business role for Project' }), {
            target: { value: 'dimension' },
        });
        expect(setColumnAnnotation).toHaveBeenCalledWith({
            columnName: 'Project',
            businessLabel: 'Project',
            description: '',
            businessRole: 'dimension',
        });

        fireEvent.click(screen.getByRole('button', { name: 'Confirm & Start Analysis' }));
        await waitFor(() => expect(saveBoundary).toHaveBeenCalledWith(expect.objectContaining({
            bodyStartIndex: 1,
            summaryStartIndex: null,
        })));
    });

    it('shows no summary rows when the boundary only covers the trailing blank line', async () => {
        const saveBoundary = vi.fn(async () => undefined);
        // A file ending with a newline parses to a final empty row; intake
        // places summaryStartIndex on it (index 3 of 4 rows).
        mockStore({
            summaryStartIndex: 3,
            normalizedRows: [
                ['month', 'quota', 'premium'],
                ['2024-01', '1000', '90000'],
                ['2024-02', '1010', '91000'],
                [''],
            ],
            saveBoundary,
        });

        render(<ReportBoundaryConfirmModal />);

        const summaryCard = getSummaryCard();
        expect(within(summaryCard).getByText('0')).toBeInTheDocument();
        expect(within(summaryCard).getByText('None detected')).toBeInTheDocument();
        expect(within(summaryCard).queryByText(/from row/)).not.toBeInTheDocument();
        expect(screen.getByPlaceholderText('None detected')).toHaveValue(null);

        fireEvent.click(screen.getByRole('button', { name: 'Confirm & Start Analysis' }));
        await waitFor(() => expect(saveBoundary).toHaveBeenCalledWith(expect.objectContaining({
            summaryStartIndex: null,
        })));
    });

    it('still shows a real summary row with its one-based start row', () => {
        mockStore({
            summaryStartIndex: 3,
            normalizedRows: [
                ['Project', 'Amount', 'Cost'],
                ['Alpha', '1200', '700'],
                ['Beta', '900', '400'],
                ['Total', '2100', '1100'],
                [''],
            ],
        });

        render(<ReportBoundaryConfirmModal />);

        const summaryCard = getSummaryCard();
        expect(within(summaryCard).getByText('1')).toBeInTheDocument();
        expect(within(summaryCard).getByText('from row 4')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('None detected')).toHaveValue(4);
    });
});
