// End-to-end presentation of one-series cards on melted SingStat demo tables:
// production intake and melt, the real DuckDB query engine (in process, like
// nullAggregateRentEndToEnd.test.tsx), the SQL-first card path and the
// rendered card. Periods are stored as their first day (2025-01-01) and must
// show at their grain; the card must be named after its series.

import React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnalysisCardData, CanonicalBuildMeta, ColumnProfile, CsvData, CsvRow, SqlEvidenceQueryPlan } from '../types';
import { initialAppState, useAppStore } from '../store/useAppStore';
import { profileData } from '../services/data/dataProfiler';
import { executeManagedDataQuery } from '../services/duckdb/queryEngine';
import { buildColumnTypeGate, DEFAULT_DIMENSION_NORMALIZATION } from '../services/duckdb/dimensionNormalization';
import { buildEvidenceResultSummary, executePresentationPlanAndCreateCard } from '../services/agent/execution/sqlCardExecutor';
import { tableToRows } from '../services/workers/duckDbRows';
import { AnalysisCard } from '../components/analysis-card/AnalysisCard';
import { createChartConfig } from '../utils/chartConfigFactory';
import { buildDisplayAnalysisIr } from '../services/dashboard/displayAnalysisIr';
import { buildExecutiveKpis } from '../services/dashboard/executiveKpis';
import { formatAnalysisCellValue } from '../utils/analysisCardPresentation';
import { formatTemporalDisplayValue } from '../utils/temporalDisplay';

const duck = vi.hoisted(() => ({ db: null as any, conn: null as any }));
const chartCalls = vi.hoisted(() => [] as Array<{ dataForDisplay: CsvRow[]; plan: any; displayChartType: string }>);

vi.mock('../components/analysis-card/AnalysisCardChart', () => ({
    AnalysisCardChart: (props: { dataForDisplay: CsvRow[]; plan: any; displayChartType: string }) => {
        chartCalls.push(props);
        return <canvas data-testid="card-chart" />;
    },
}));

vi.mock('../services/workers/duckDbWorkerClient', () => ({
    duckDbWorkerClient: {
        initDuckDb: async () => ({ initialized: true }),
        loadCleanDataset: async (payload: { csvText: string; csvFileName: string; loadVersion: string; tableName: string }) => {
            const table = `"${payload.tableName.replace(/"/g, '""')}"`;
            await duck.db.registerFileText(payload.csvFileName, payload.csvText);
            duck.conn.query(`DROP TABLE IF EXISTS ${table}`);
            duck.conn.query(`CREATE TABLE ${table} AS SELECT * FROM read_csv_auto('${payload.csvFileName.replace(/'/g, "''")}', header=true, all_varchar=true)`);
            return { loaded: true, tableName: payload.tableName, loadVersion: payload.loadVersion };
        },
        executeCompiledQuery: async (payload: { sql: string }) => {
            const rows = tableToRows(duck.conn.query(payload.sql));
            return { rows, totalMatchedRows: rows.length, returnedRows: rows.length };
        },
        executeRawQuery: async () => { throw new Error('not used'); },
        disposeDuckDbSession: async () => undefined,
    },
}));

vi.mock('../services/vectorStore', () => ({ vectorStore: { searchIfReady: vi.fn().mockResolvedValue([]) } }));

// jsdom replaces the global URL, so paths are resolved from the package root.
const require = createRequire(path.resolve(process.cwd(), 'package.json'));
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const wasmBase = `${path.resolve(process.cwd(), 'node_modules/@duckdb/duckdb-wasm/dist')}/`;

interface MeltedDataset {
    data: CsvData;
    profiles: ColumnProfile[];
    meta: CanonicalBuildMeta;
}

/** The production intake: parse, resolve the report structure, melt the period columns. */
const intakeDemoDataset = async (fileName: string): Promise<MeltedDataset> => {
    const { processCsvWithIntakeIr } = await import('../services/data/csvParser');
    const { buildCsvDataFromIntakeIr } = await import('../services/data/reportCsvIntake');
    const { resolveReportStructureArtifactsWithProposal } = await import('../services/agent/orchestration/reportStructureOrchestrator');
    const { createTestSettings } = await import('./testSettings');
    const text = readFileSync(path.resolve(process.cwd(), '../demo-data', fileName), 'utf8');
    const file = ({ name: fileName, size: text.length, text: async () => text }) as unknown as File;
    const { csvData, intakeIr } = await processCsvWithIntakeIr(file);
    const artifacts = await resolveReportStructureArtifactsWithProposal({
        rawCsvData: buildCsvDataFromIntakeIr(intakeIr),
        csvData,
        rawIntakeIr: intakeIr,
        cleaningRun: null,
        dataPreparationPlan: { explanation: '', operations: [], outputColumns: [], planStatus: 'schema_only', consistencyIssues: [] },
        columnProfiles: profileData(csvData.data).profiles,
        settings: createTestSettings(),
    });
    const data = artifacts.canonicalCsvData!;
    return { data, profiles: profileData(data.data).profiles, meta: artifacts.canonicalBuildMeta! };
};

const TRANSPORT_MRT = 'Average Daily Ridership - MRT';
const TRANSPORT_LRT = 'Average Daily Ridership - LRT';

let transport: MeltedDataset;
let visitors: MeltedDataset;

beforeAll(async () => {
    duck.db = await duckdb.createDuckDB(
        { mvp: { mainModule: `${wasmBase}duckdb-mvp.wasm` }, eh: { mainModule: `${wasmBase}duckdb-eh.wasm` } },
        new duckdb.VoidLogger(),
        duckdb.NODE_RUNTIME,
    );
    await duck.db.instantiate();
    duck.db.open({ path: ':memory:', maximumThreads: 1 });
    duck.conn = duck.db.connect();
    transport = await intakeDemoDataset('sg-public-transport-ridership.csv');
    visitors = await intakeDemoDataset('sg-visitor-arrivals.csv');
}, 60_000);
afterAll(() => duck.conn?.close());
afterEach(() => {
    cleanup();
    chartCalls.length = 0;
    useAppStore.setState(initialAppState);
});

const ALIAS = 'avg_value';

const seriesTrendPlan = (title: string, series: string): SqlEvidenceQueryPlan => ({
    title,
    queryMode: 'aggregate',
    intentSummary: title,
    preferredResultShape: 'time_series',
    query: {
        select: ['Period', ALIAS],
        groupBy: ['Period'],
        aggregates: [{ function: 'avg', column: 'Value', as: ALIAS }],
        where: { predicates: [{ column: 'DataSeries', operator: 'eq', value: series }] },
        orderBy: [{ column: 'Period', direction: 'asc' }],
        limit: 500,
    },
});

/** Loads the melted dataset into the store and runs a one-series trend through DuckDB into a card. */
const createSeriesCard = async (dataset: MeltedDataset, series: string, title: string, options: { keepCards?: boolean } = {}) => {
    if (!options.keepCards) {
        useAppStore.setState({
            ...initialAppState,
            settings: { ...initialAppState.settings, language: 'English', enableVisualEvaluation: false },
            columnProfiles: dataset.profiles,
            csvData: dataset.data,
            canonicalCsvData: dataset.data,
            canonicalBuildMeta: dataset.meta,
        });
    }
    const evidencePlan = seriesTrendPlan(title, series);
    const columns = Object.keys(dataset.data.data[0]);
    const execution = await executeManagedDataQuery(dataset.data, evidencePlan.query, columns, {
        allowNativeFallback: false,
        bypassCache: true,
        dimensionNormalization: { ...DEFAULT_DIMENSION_NORMALIZATION, shouldNormalize: buildColumnTypeGate(dataset.profiles) },
    });
    expect(execution.engine).toBe('duckdb');
    const result = execution.result;
    const queryTrace = {
        id: `trace-${series}`,
        phase: 'analysis',
        origin: 'analysis',
        explanation: title,
        plan: evidencePlan.query,
        engine: 'duckdb',
        sqlPreview: null,
        tableName: null,
        loadVersion: null,
        appliedAt: new Date(),
    };
    const created = await executePresentationPlanAndCreateCard(evidencePlan, {
        title,
        description: `${title}.`,
        presentationMode: 'chart',
        chartType: 'line',
        bindings: { groupByColumn: 'Period', valueColumn: ALIAS },
    }, useAppStore, buildEvidenceResultSummary(evidencePlan, result, dataset.profiles), {
        result,
        execution: { engine: 'duckdb', sqlPreview: null, tableName: null, loadVersion: null, fallbackReason: null, fallbackStage: null },
        activeDataQuery: { result },
        queryTrace,
        binding: null,
        allowedColumns: columns,
    } as never);
    return created.card!;
};

const renderCard = (card: AnalysisCardData, overrides: Partial<AnalysisCardData> = {}) => {
    useAppStore.setState({ analysisCards: [{ ...card, isDataVisible: true, ...overrides }] });
    render(<AnalysisCard cardId={card.id} isSpotlighted />);
    const table = screen.getByRole('table');
    // Sortable headers carry a sort glyph (⇅ ▲ ▼) after the label.
    const headers = within(table).getAllByRole('columnheader').map(cell => (cell.textContent ?? '').replace(/[⇅▲▼]/g, '').trim());
    const rows = within(table).getAllByRole('row').slice(1)
        .map(row => within(row).getAllByRole('cell').map(cell => cell.textContent ?? ''));
    return { headers, rows };
};

const lastChartLabels = (): string[] => {
    const chart = chartCalls[chartCalls.length - 1];
    const config = createChartConfig({
        chartType: chart.displayChartType as never,
        data: chart.dataForDisplay,
        plan: chart.plan,
        selectedIndices: [],
        onElementClick: () => undefined,
        onZoomChange: () => undefined,
    });
    return (config.data.labels ?? []).map(String);
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthIndex = (label: string) => {
    const [month, year] = label.split(' ');
    return Number(year) * 12 + MONTHS.indexOf(month);
};

describe('period grain on one-series cards of a melted table', () => {
    it('records the intake grain and the selected series on the card plan', async () => {
        expect(transport.meta.seriesMeasure?.periodGrain).toBe('year');
        expect(visitors.meta.seriesMeasure?.periodGrain).toBe('month');
        const card = await createSeriesCard(transport, TRANSPORT_MRT, 'Avg Value by Period');
        expect(card.plan.periodSeries).toEqual({ periodColumn: 'Period', periodGrain: 'year', seriesName: TRANSPORT_MRT });
        // The stored ISO period start is untouched; only the display changes.
        expect(card.aggregatedData[0].Period).toMatch(/^\d{4}-01-01$/);
    }, 60_000);

    it('shows yearly periods as years in the table, chart and fallback summary, in chronological order', async () => {
        const card = await createSeriesCard(transport, TRANSPORT_MRT, 'Avg Value by Period');
        const { headers, rows } = renderCard(card);

        expect(headers[0]).toBe('Year');
        const periods = rows.map(row => row[0]);
        expect(periods.length).toBeGreaterThan(10);
        expect(periods.every(label => /^\d{4}$/.test(label))).toBe(true);
        expect(periods).toContain('2025');
        expect(periods).toEqual([...periods].sort());

        const labels = lastChartLabels();
        expect(labels).toEqual(periods);
        expect(card.summary.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(card.summary.text).toMatch(/^- \d{4}: /m);
    }, 60_000);

    it('shows monthly periods as month and year and sorts them chronologically', async () => {
        const series = visitors.meta.seriesMeasure!.series.find(entry => entry.rowClass === 'total' || entry.parent === null)!.name;
        const card = await createSeriesCard(visitors, series, 'Avg Value by Period');
        expect(card.plan.periodSeries?.periodGrain).toBe('month');

        const ascending = renderCard(card);
        expect(ascending.headers[0]).toBe('Month');
        const periods = ascending.rows.map(row => row[0]);
        expect(periods.every(label => /^[A-Z][a-z]{2} \d{4}$/.test(label))).toBe(true);
        expect(periods).toContain('Aug 2026');
        expect(lastChartLabels()).toEqual(periods);
        cleanup();

        const descending = renderCard(card, { tableSort: { column: 'Period', direction: 'desc' } });
        const sorted = descending.rows.map(row => row[0]);
        expect(sorted[0]).toBe('Aug 2026');
        expect(sorted.map(monthIndex)).toEqual([...sorted.map(monthIndex)].sort((left, right) => right - left));
    }, 60_000);

    it('names the top year of a series in the executive KPI', async () => {
        const created = await createSeriesCard(transport, TRANSPORT_MRT, 'Avg Value by Period');
        const card: AnalysisCardData = {
            ...created,
            autoAnalysisEvaluation: { verdict: 'trusted', reasonCodes: [], detail: 'trusted', evaluatedAt: new Date().toISOString(), source: 'auto_analysis_evaluator_v1' },
        };
        const kpis = buildExecutiveKpis({
            cards: [card],
            columnProfiles: transport.profiles,
            csvData: transport.data,
            language: 'English',
            seriesMeasure: transport.meta.seriesMeasure,
        });
        const topGroup = kpis.find(kpi => kpi.id === 'top-group');
        expect(topGroup?.label).toBe('Top Year');
        expect(topGroup?.detail).toMatch(/^\d{4} leads this view\.$/);
    }, 60_000);

    it('keeps ordinary date columns in day/month/year form', () => {
        expect(formatAnalysisCellValue('Date', '2026-08-01')).toBe('01/08/2026');
        expect(formatTemporalDisplayValue('Period', '2026-08-01')).toBe('01/08/2026');
        // A period context only applies to its own column.
        expect(formatTemporalDisplayValue('Date', '2026-08-01', { periodColumn: 'Period', periodGrain: 'month' })).toBe('01/08/2026');
    });

    it('formats each grain and stays idempotent on formatted labels', () => {
        const year = { periodColumn: 'Period', periodGrain: 'year' } as const;
        const quarter = { periodColumn: 'Period', periodGrain: 'quarter' } as const;
        const month = { periodColumn: 'Period', periodGrain: 'month' } as const;
        expect(formatTemporalDisplayValue('Period', '2025-01-01', year)).toBe('2025');
        expect(formatTemporalDisplayValue('Period', '2024-04-01', quarter)).toBe('2024 Q2');
        expect(formatTemporalDisplayValue('Period', '2026-08-01', month)).toBe('Aug 2026');
        expect(formatTemporalDisplayValue('Period', 'Aug 2026', month)).toBe('Aug 2026');
        expect(formatTemporalDisplayValue('Period', '2024 Q2', quarter)).toBe('2024 Q2');
        expect(formatAnalysisCellValue('Period', '2025', 2, year)).toBe('2025');
    });
});

describe('series names on one-series cards of a melted table', () => {
    it('names a card with a generic AI title after its series', async () => {
        const card = await createSeriesCard(transport, TRANSPORT_MRT, 'Avg Value by Period');
        const display = buildDisplayAnalysisIr(card, [card], transport.profiles);
        expect(display.displayTitle).toBe(`${TRANSPORT_MRT} by year`);
        expect(display.displayMetricLabel).toBe(TRANSPORT_MRT);

        const { headers } = renderCard(card);
        expect(headers[1]).toBe(TRANSPORT_MRT);
        expect(screen.getAllByText(`${TRANSPORT_MRT} by year`).length).toBeGreaterThan(0);
        expect(screen.queryByText('Avg Value by Period')).toBeNull();
    }, 60_000);

    it('keeps a specific AI title that already names the series', async () => {
        const title = 'Average daily MRT ridership trend by year';
        const card = await createSeriesCard(transport, TRANSPORT_MRT, title);
        expect(buildDisplayAnalysisIr(card, [card], transport.profiles).displayTitle).toBe(title);
    }, 60_000);

    it('keeps a separate card for each series instead of reusing the first one', async () => {
        const mrt = await createSeriesCard(transport, TRANSPORT_MRT, 'Avg Value by Period');
        const lrt = await createSeriesCard(transport, TRANSPORT_LRT, 'Avg Value by Period', { keepCards: true });
        expect(lrt.id).not.toBe(mrt.id);
        expect(useAppStore.getState().analysisCards).toHaveLength(2);
        expect(buildDisplayAnalysisIr(lrt, [lrt]).displayTitle).toBe(`${TRANSPORT_LRT} by year`);
    }, 60_000);
});
