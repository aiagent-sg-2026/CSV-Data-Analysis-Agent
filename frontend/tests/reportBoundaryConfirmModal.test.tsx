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
    blockingReasons?: string[];
    language?: string;
}) => {
    const blockingReasons = overrides.blockingReasons ?? ['detail_series_coverage_rate'];
    const decisionReason = `Structure needs review: ${blockingReasons.join(', ')}.`;
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
            blockingReasons,
            requiresHumanReview: true,
            decision: {
                targetShape: 'row_table',
                shouldCanonicalize: false,
                reason: decisionReason,
            },
        },
        rawIntakeIr: { normalizedRows: overrides.normalizedRows },
        saveReportStructureBoundaryOverride: overrides.saveBoundary ?? vi.fn(async () => undefined),
        isBusy: false,
        settings: { language: overrides.language ?? 'English' },
        pipelineOutcome: {
            status: 'needs_structure_review',
            canAutoAnalyze: false,
            severity: 'warning',
            reasonCode: blockingReasons[0],
            message: `Structure review is required before automatic analysis. ${decisionReason}`,
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

    it('explains structure review reasons in plain language and keeps codes in technical details', () => {
        const codes = ['hierarchy_depth_retention_rate', 'structure_proposal_verification_failed', 'complex_report_requires_confirmation'];
        mockStore({
            summaryStartIndex: null,
            normalizedRows: [['Section', 'Item', 'Amount'], ['A', 'One', '10'], ['A', 'Two', '20']],
            blockingReasons: codes,
        });

        render(<ReportBoundaryConfirmModal />);

        const dialog = screen.getByRole('dialog', { name: 'Review and repair data structure' });
        const details = within(dialog).getByText('Technical details').closest('details');
        expect(details).not.toBeNull();
        const visibleText = (dialog.textContent ?? '').replace(details!.textContent ?? '', '');
        for (const code of codes) {
            expect(visibleText).not.toContain(code);
            expect(details!.textContent).toContain(code);
        }
        expect(screen.getByText('The rows look grouped into levels, such as sections and items, and that grouping would be lost.')).toBeInTheDocument();
        expect(screen.getByText('The suggested table layout did not pass the data checks.')).toBeInTheDocument();
        expect(screen.getByText('This looks like a complex report layout, so please confirm it before analysis.')).toBeInTheDocument();
        expect(screen.getByText('Automatic analysis is paused until you confirm the table structure.')).toBeInTheDocument();
        expect(within(details!).getByText('Technical details')).toBeInTheDocument();
    });

    it('shows the plain-language reason in the selected language', () => {
        mockStore({
            summaryStartIndex: null,
            normalizedRows: [['DataSeries', '2026Aug', '2026Jul'], ['Total', '100', '90']],
            blockingReasons: ['detail_series_coverage_rate'],
            language: 'Mandarin',
        });

        render(<ReportBoundaryConfirmModal />);

        expect(screen.getByText('表格仍是宽表格式（例如每月一列），可能需要转换。')).toBeInTheDocument();
        expect(screen.getByText('技术详情')).toBeInTheDocument();
    });
});
