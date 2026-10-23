import type { ReactNode } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisPanel } from '../components/AnalysisPanel';
import * as useAppStoreModule from '../store/useAppStore';
import { getCurrentAnalysisDatasetVersion } from '../services/agent/artifactProvenance';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { resolveReportStructureArtifacts } from '../services/agent/reportStructureState';
import type { CsvData, ReportIntakeIr } from '../types';

vi.mock('../store/useAppStore', () => ({
    useAppStore: vi.fn(),
}));

vi.mock('react-masonry-css', () => ({
    default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../components/analysis-card/AnalysisCard', () => ({
    AnalysisCard: ({ cardId }: { cardId: string }) => <div>Analysis Card {cardId}</div>,
}));

class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
}

type Verdict = 'trusted' | 'caveated';

const CSV_ROWS = [{ Customer: 'A', Amount: 100, UOM: 'PCS', Quantity: 10 }, { Customer: 'B', Amount: 50, UOM: 'BOX', Quantity: 4 }];
const csvData = { fileName: 'sales.csv', data: CSV_ROWS, metadataRows: [], summaryRows: [], headerDepth: 1 };
const datasetVersion = getCurrentAnalysisDatasetVersion({ canonicalCsvData: null, csvData: csvData as never });

const buildCard = (id: string, verdict: Verdict, options: { helper?: boolean } = {}) => ({
    id,
    // A record-count card is verified evidence but never counts as a business conclusion,
    // so the simple view has nothing to list while the banner still counts it as verified.
    plan: options.helper
        ? { chartType: 'bar', title: 'Count rows by UOM', groupByColumn: 'UOM', valueColumn: 'count', aggregation: 'count' }
        : { chartType: 'bar', title: `Amount by ${id}`, groupByColumn: 'Customer', valueColumn: 'Amount', aggregation: 'sum' },
    aggregatedData: options.helper ? [{ UOM: 'PCS', count: 1 }, { UOM: 'BOX', count: 1 }] : CSV_ROWS,
    summary: 'Summary',
    displayChartType: 'bar',
    isDataVisible: false,
    topN: null,
    hideOthers: false,
    hiddenLabels: [],
    provenance: {
        schemaVersion: 1,
        datasetId: 'dataset-test',
        datasetVersion,
        evidenceStatus: 'verified',
        evidenceReasons: [],
        method: {
            operation: 'bar',
            groupByColumns: ['Customer'],
            aggregations: [{ function: 'sum', column: 'Amount', alias: 'Amount' }],
            sourceColumns: ['Customer', 'Amount'],
            filterCount: 0,
            pivotRows: [],
            pivotColumns: [],
        },
        queryEvidence: null,
        queryEvidenceRequired: false,
        evidenceRefs: [],
        createdAt: '2026-07-25T00:00:00.000Z',
    },
    evidenceValueGate: { decision: options.helper ? 'table_only' : 'pass' },
    autoAnalysisEvaluation: {
        verdict,
        reasonCodes: [],
        detail: verdict,
        evaluatedAt: '2026-07-25T00:00:00.000Z',
        source: 'auto_analysis_evaluator_v1',
    },
});

const question = (id: string, status: string, priority: number) => ({
    id: `question-${id}`,
    hypothesisId: `hyp-${id}`,
    question: `Question ${id}`,
    priority,
    status,
});

const session = (statuses: string[]) => ({
    status: 'completed',
    stopReason: null,
    researchBrief: {
        goal: 'Summarize key patterns',
        datasetVersionId: null,
        questions: statuses.map((status, index) => question(String(index + 1), status, statuses.length - index)),
        stopConditions: [],
        clarification: null,
        createdAt: new Date('2026-07-25T00:00:00Z'),
    },
    // The internal finding of the unanswered question reads "hypothesis": it must not leak into the strip.
    researchFindings: statuses.map((status, index) => ({
        id: `finding-${index + 1}`,
        questionId: `question-${index + 1}`,
        hypothesisId: `hyp-${index + 1}`,
        claim: `Claim ${index + 1}`,
        status: status === 'supported' ? 'supported' : 'hypothesis',
        evidenceRefs: [],
        reasonCodes: [],
    })),
});

const buildStore = (overrides: Record<string, unknown> = {}) => ({
    analysisCards: [] as Array<ReturnType<typeof buildCard>>,
    initialAnalysisStatus: 'ready',
    finalSummary: null as { language: string; text: string } | null,
    finalSummaryProvenance: null,
    isGeneratingReport: false,
    isSpreadsheetVisible: false,
    settings: { language: 'English' },
    reportGenerationProgress: null,
    aiTaskStatus: null,
    dataQualityIssues: [],
    agentMemoryRun: null,
    cleaningRun: null,
    resumeCleaningRun: vi.fn(),
    restartCleaningRun: vi.fn(),
    generateAnalystReport: vi.fn(),
    handleShowCardFromChat: vi.fn(),
    rawCsvData: null,
    rawIntakeIr: null,
    reportContextResolution: null,
    reportStructureResolution: null,
    csvData,
    columnProfiles: [
        { name: 'Customer', type: 'categorical', uniqueValues: 2, missingPercentage: 0 },
        { name: 'UOM', type: 'categorical', uniqueValues: 2, missingPercentage: 0 },
        { name: 'Amount', type: 'numerical', missingPercentage: 0 },
        { name: 'Quantity', type: 'numerical', missingPercentage: 0 },
    ],
    resultsViewMode: 'explore',
    latestAnalysisSession: null as ReturnType<typeof session> | null,
    ...overrides,
});

const renderPanel = (store: ReturnType<typeof buildStore>) => {
    (useAppStoreModule.useAppStore as unknown as ReturnType<typeof vi.fn>)
        .mockImplementation((selector: (value: typeof store) => unknown) => selector(store));
    return render(<AnalysisPanel />);
};

describe('results trust signals agree with each other', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.sessionStorage.removeItem('csv_agent_results_view');
        (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock;
    });
    afterEach(() => {
        cleanup();
        window.sessionStorage.removeItem('csv_agent_results_view');
    });

    it('does not show the green banner or a zero pill when one question was not supported', () => {
        renderPanel(buildStore({
            analysisCards: [buildCard('a', 'trusted'), buildCard('b', 'trusted'), buildCard('c', 'trusted')],
            latestAnalysisSession: session(['supported', 'supported', 'unsupported', 'supported']),
        }));

        const strip = screen.getByRole('region', { name: 'Research run' });
        expect(within(strip).getByText('3 supported')).toBeInTheDocument();
        expect(within(strip).getByText('1 not supported')).toBeInTheDocument();
        expect(within(strip).queryByText(/need review/)).not.toBeInTheDocument();
        expect(within(strip).queryByText(/^0 /)).not.toBeInTheDocument();
        // One line says why, on the question that is not supported.
        expect(within(strip).getAllByText('The data did not allow this calculation.')).toHaveLength(1);

        const banner = screen.getByRole('status');
        expect(within(banner).getByText('3 of 4 questions answered')).toBeInTheDocument();
        expect(within(banner).getByText(/1 could not be calculated/)).toBeInTheDocument();
        expect(banner.textContent).not.toMatch(/All cards passed quality checks/i);
        expect(banner.textContent).not.toMatch(/use these findings directly/i);
    });

    it('keeps the green banner and hides every zero pill when all questions were supported', () => {
        renderPanel(buildStore({
            analysisCards: [buildCard('a', 'trusted'), buildCard('b', 'trusted')],
            latestAnalysisSession: session(['supported', 'supported', 'supported', 'supported']),
        }));

        const strip = screen.getByRole('region', { name: 'Research run' });
        expect(within(strip).getByText('4 supported')).toBeInTheDocument();
        expect(within(strip).queryByText(/not supported|need review|not answered/)).not.toBeInTheDocument();
        expect(within(strip).queryByText('The data did not allow this calculation.')).not.toBeInTheDocument();
        expect(within(screen.getByRole('status')).getByText('Results ready to use')).toBeInTheDocument();
    });

    it('states the gap in the simple view too, where the research strip is not shown', () => {
        renderPanel(buildStore({
            resultsViewMode: 'simple',
            analysisCards: [buildCard('a', 'trusted'), buildCard('b', 'trusted'), buildCard('c', 'trusted')],
            latestAnalysisSession: session(['supported', 'supported', 'unsupported', 'supported']),
        }));

        expect(screen.queryByRole('region', { name: 'Research run' })).not.toBeInTheDocument();
        expect(screen.getByText('3 of 4 questions answered')).toBeInTheDocument();
    });

    it('counts only the cards under review on the review button, and styles it as the main control', () => {
        // The simple view lists no card: the one verified card is a helper table, four more need review.
        const store = buildStore({
            resultsViewMode: 'simple',
            analysisCards: [
                buildCard('helper', 'trusted', { helper: true }),
                buildCard('r1', 'caveated'), buildCard('r2', 'caveated'), buildCard('r3', 'caveated'), buildCard('r4', 'caveated'),
            ],
        });
        renderPanel(store);

        expect(screen.getByText('1 verified, 4 need review — start with verified cards.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /5 cards/ })).not.toBeInTheDocument();
        const button = screen.getByRole('button', { name: 'Review the 4 cards' });
        expect(button.className).toContain('text-white');
        fireEvent.click(button);
        expect(screen.getByRole('button', { name: 'Explore in depth' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('uses the singular button label for one card under review', () => {
        renderPanel(buildStore({
            resultsViewMode: 'simple',
            analysisCards: [buildCard('helper', 'trusted', { helper: true }), buildCard('r1', 'caveated')],
        }));

        expect(screen.getByRole('button', { name: 'Review the card' })).toBeInTheDocument();
    });

    it('shows a neutral badge on the overall insights when the text was built from the verified cards', () => {
        const provenance = (narrativeSource?: string) => ({
            schemaVersion: 1, datasetId: 'dataset-test', datasetVersion, evidenceStatus: 'verified', evidenceReasons: [],
            method: { operation: 'bar', groupByColumns: [], aggregations: [], sourceColumns: [], filterCount: 0, pivotRows: [], pivotColumns: [] },
            queryEvidence: null, evidenceRefs: [], createdAt: '2026-07-25T00:00:00.000Z',
            ...(narrativeSource ? { narrativeSource } : {}),
        });
        const cards = [buildCard('a', 'trusted')];
        const summary = { language: 'English', text: 'The AI summary could not be generated, so these points are read directly from 1 evidence card(s).' };

        const { unmount } = renderPanel(buildStore({ analysisCards: cards, finalSummary: summary, finalSummaryProvenance: provenance('evidence_fallback') }));
        expect(screen.getByText('Built from the verified cards')).toBeInTheDocument();
        expect(screen.queryByText('Verified evidence')).not.toBeInTheDocument();
        unmount();

        renderPanel(buildStore({ analysisCards: cards, finalSummary: summary, finalSummaryProvenance: provenance('ai_summary') }));
        expect(screen.getByText('Verified evidence')).toBeInTheDocument();
    });
});

describe('stacked tables stay visible after the structure was confirmed (w3)', () => {
    let fixture: { csvData: CsvData; intakeIr: ReportIntakeIr; creditRows: number; paymentRows: number };

    beforeAll(async () => {
        const dir = path.resolve(process.cwd(), 'tests/fixtures/weird-reports');
        const text = fs.readFileSync(path.join(dir, 'w3_three_sections.csv'), 'utf8');
        const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8')) as { f3: { rows: number[] } };
        const file = { name: 'w3_three_sections.csv', size: text.length, text: async () => text } as unknown as File;
        const { csvData: parsed, intakeIr } = await processCsvWithIntakeIr(file);
        fixture = { csvData: parsed, intakeIr, creditRows: truth.f3.rows[1], paymentRows: truth.f3.rows[2] };
    });

    beforeEach(() => {
        vi.clearAllMocks();
        window.sessionStorage.removeItem('csv_agent_results_view');
        (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock;
    });
    afterEach(() => cleanup());

    const reportContextResolution = (title: string) => ({
        effectiveContext: { reportTitle: title, reportDescription: null, parameterLines: [] },
        verification: { aiConfidence: 'high', usedFallback: false },
        aiExtracted: null,
    });

    const panelStore = (extra: Record<string, unknown> = {}) => {
        const resolved = resolveReportStructureArtifacts({
            rawCsvData: fixture.csvData, csvData: fixture.csvData, rawIntakeIr: fixture.intakeIr, cleaningRun: null,
            dataPreparationPlan: { explanation: '', operations: [], outputColumns: [], planStatus: 'schema_only', consistencyIssues: [] },
        });
        return buildStore({
            csvData: fixture.csvData,
            rawCsvData: fixture.csvData,
            rawIntakeIr: fixture.intakeIr,
            reportStructureResolution: resolved.reportStructureResolution,
            reportContextResolution: reportContextResolution('Section A: Sales Invoices'),
            ...extra,
        });
    };

    it('says how many other tables were set aside, with their row counts', () => {
        renderPanel(panelStore());

        expect(screen.getByText(`2 other tables in the file were set aside (${fixture.creditRows} and ${fixture.paymentRows} rows)`)).toBeInTheDocument();
    });

    it('does not claim a set-aside table that a later confirmed boundary has taken back as data', () => {
        const store = panelStore();
        const resolution = store.reportStructureResolution as unknown as Record<string, unknown>;
        store.reportStructureResolution = {
            ...resolution,
            source: 'human_confirmed',
            humanBoundary: { ...(resolution.rawIntakeBoundary as object), summaryStartIndex: null },
        } as never;
        renderPanel(store);

        expect(screen.queryByText(/set aside/)).not.toBeInTheDocument();
    });

    it('says nothing for a file without stacked tables', () => {
        renderPanel(panelStore({ rawIntakeIr: { ...fixture.intakeIr, diagnostics: { ...fixture.intakeIr.diagnostics, setAsideSections: undefined } } }));

        expect(screen.queryByText(/set aside/)).not.toBeInTheDocument();
    });
});
