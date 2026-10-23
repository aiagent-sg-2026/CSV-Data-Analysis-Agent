// End-to-end regression for ranked additive cards (SUM/COUNT per group) whose
// evidence query returns only its top groups. Production intake and melt, the
// real DuckDB query engine (in process, like nullAggregateRentEndToEnd.test.tsx),
// the companion total query, the SQL-first card path and the rendered card.
//
// The visitor-arrivals card "Sum Value by Data Series" is limited to 10 of its
// 52 leaf markets. Shares, "Overall" and "Others" used to be relative to the sum
// of those 10 rows (179,811,161) although the card said "Full dataset"; the real
// total is 244,299,398, so Indonesia holds 17.4%, not 23.6%.

import React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
    AnalysisCardData,
    CanonicalBuildMeta,
    ColumnProfile,
    CsvData,
    CsvRow,
    SqlEvidenceQueryPlan,
    SqlPresentationPlan,
} from '../types';
import { initialAppState, useAppStore } from '../store/useAppStore';
import { profileData } from '../services/data/dataProfiler';
import { executeManagedDataQuery } from '../services/duckdb/queryEngine';
import { buildColumnTypeGate, DEFAULT_DIMENSION_NORMALIZATION } from '../services/duckdb/dimensionNormalization';
import {
    buildEvidenceResultSummary,
    executeEvidenceQuery,
    executePresentationPlanAndCreateCard,
} from '../services/agent/execution/sqlCardExecutor';
import { measureGroupCoverage } from '../services/agent/planning/groupCoverage';
import { buildExecutiveKpis } from '../services/dashboard/executiveKpis';
import { describeCardGroupCoverage } from '../utils/cardGroupTotals';
import { tableToRows } from '../services/workers/duckDbRows';
import { AnalysisCard } from '../components/analysis-card/AnalysisCard';

const duck = vi.hoisted(() => ({ db: null as any, conn: null as any }));
const exportToCsvSpy = vi.hoisted(() => vi.fn(() => ({ success: true })));

vi.mock('../utils/exportUtils', async importOriginal => ({
    ...(await importOriginal<typeof import('../utils/exportUtils')>()),
    exportToCsv: exportToCsvSpy,
}));

vi.mock('../components/analysis-card/AnalysisCardChart', () => ({
    AnalysisCardChart: () => <canvas data-testid="card-chart" />,
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
        // Mirrors services/workers/duckDbWorker.ts: a full page is counted against the unlimited query.
        executeCompiledQuery: async (payload: { sql: string; countSql: string; appliedLimit: number; selectedColumns: string[]; appliedOrderBy: unknown[] }) => {
            const rows = tableToRows(duck.conn.query(payload.sql));
            const totalMatchedRows = rows.length < payload.appliedLimit
                ? rows.length
                : Number(tableToRows(duck.conn.query(payload.countSql))[0].total);
            return {
                rows,
                totalMatchedRows,
                returnedRows: rows.length,
                truncated: totalMatchedRows > rows.length,
                selectedColumns: payload.selectedColumns,
                appliedOrderBy: payload.appliedOrderBy,
                appliedLimit: payload.appliedLimit,
            };
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

interface Dataset {
    data: CsvData;
    profiles: ColumnProfile[];
    meta: CanonicalBuildMeta | null;
}

/** The production intake: parse, resolve the report structure, melt the period columns. */
const intakeDemoDataset = async (fileName: string): Promise<Dataset> => {
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

/** 15 groups, two rows each: group N holds (16 - N) x 100, so the total is 12,000 and the top 10 hold 10,500. */
const buildPlainDataset = (): Dataset => {
    const rows: CsvRow[] = [];
    for (let group = 1; group <= 15; group += 1) {
        const label = `Region ${String(group).padStart(2, '0')}`;
        rows.push({ Region: label, Amount: (16 - group) * 60 }, { Region: label, Amount: (16 - group) * 40 });
    }
    const data: CsvData = { fileName: 'regions.csv', data: rows };
    return { data, profiles: profileData(rows).profiles, meta: null };
};

let visitors: Dataset;

beforeAll(async () => {
    duck.db = await duckdb.createDuckDB(
        { mvp: { mainModule: `${wasmBase}duckdb-mvp.wasm` }, eh: { mainModule: `${wasmBase}duckdb-eh.wasm` } },
        new duckdb.VoidLogger(),
        duckdb.NODE_RUNTIME,
    );
    await duck.db.instantiate();
    duck.db.open({ path: ':memory:', maximumThreads: 1 });
    duck.conn = duck.db.connect();
    visitors = await intakeDemoDataset('sg-visitor-arrivals.csv');
}, 60_000);
afterAll(() => duck.conn?.close());
afterEach(() => {
    cleanup();
    useAppStore.setState(initialAppState);
});

const ALIAS = 'total_value';
const LEAF_TOTAL = 244_299_398;
const TOP_10_TOTAL = 179_811_161;
const TOP_8_TOTAL = 163_114_689;

const visitorPlan = (fn: 'sum' | 'avg', limit = 10): SqlEvidenceQueryPlan => ({
    title: 'Sum Value by Data Series',
    queryMode: 'aggregate',
    intentSummary: 'Rank the leaf markets by arrivals.',
    preferredResultShape: 'ranked_aggregate',
    query: {
        select: ['DataSeries', ALIAS],
        where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] },
        groupBy: ['DataSeries'],
        aggregates: [{ function: fn, column: 'Value', as: ALIAS }],
        orderBy: [{ column: ALIAS, direction: 'desc' }],
        limit,
    },
});

const regionPlan = (limit: number): SqlEvidenceQueryPlan => ({
    title: 'Sum Amount by Region',
    queryMode: 'aggregate',
    intentSummary: 'Rank regions by amount.',
    preferredResultShape: 'ranked_aggregate',
    query: {
        select: ['Region', ALIAS],
        groupBy: ['Region'],
        aggregates: [{ function: 'sum', column: 'Amount', as: ALIAS }],
        orderBy: [{ column: ALIAS, direction: 'desc' }],
        limit,
    },
});

interface CardRun {
    card: AnalysisCardData;
    companionPlans: SqlEvidenceQueryPlan[];
    groupCoverage: AnalysisCardData['groupCoverage'];
}

/**
 * Production order of topicProcessor: the evidence query runs, the companion
 * total is measured through the same evidence executor, then the card is built.
 */
const runRankedCard = async (
    dataset: Dataset,
    evidencePlan: SqlEvidenceQueryPlan,
    groupByColumn: string,
    presentation: Partial<SqlPresentationPlan> = {},
    options: { failCompanion?: boolean; skipCoverage?: boolean } = {},
): Promise<CardRun> => {
    useAppStore.setState({
        ...initialAppState,
        settings: { ...initialAppState.settings, language: 'English', enableVisualEvaluation: false },
        columnProfiles: dataset.profiles,
        csvData: dataset.data,
        canonicalCsvData: dataset.data,
        canonicalBuildMeta: dataset.meta,
    });
    const columns = Object.keys(dataset.data.data[0]);
    const execution = await executeManagedDataQuery(dataset.data, evidencePlan.query, columns, {
        allowNativeFallback: false,
        bypassCache: true,
        dimensionNormalization: { ...DEFAULT_DIMENSION_NORMALIZATION, shouldNormalize: buildColumnTypeGate(dataset.profiles) },
    });
    expect(execution.engine).toBe('duckdb');
    const result = execution.result;

    const companionPlans: SqlEvidenceQueryPlan[] = [];
    const groupCoverage = options.skipCoverage ? null : await measureGroupCoverage(evidencePlan, result, async checkPlan => {
        companionPlans.push(checkPlan);
        if (options.failCompanion) throw new Error('companion query failed');
        return executeEvidenceQuery(checkPlan, useAppStore, null, { dataset: dataset.data, suppressQueryStateUpdates: true });
    }, { valueColumn: ALIAS });

    const queryTrace = {
        id: 'trace-ranked',
        phase: 'analysis',
        origin: 'analysis',
        explanation: evidencePlan.title,
        plan: evidencePlan.query,
        engine: 'duckdb',
        sqlPreview: null,
        tableName: null,
        loadVersion: null,
        appliedAt: new Date(),
    };
    const created = await executePresentationPlanAndCreateCard(evidencePlan, {
        title: evidencePlan.title,
        description: `${evidencePlan.title}.`,
        presentationMode: 'chart',
        chartType: 'bar',
        bindings: { groupByColumn, valueColumn: ALIAS },
        ...presentation,
    }, useAppStore, buildEvidenceResultSummary(evidencePlan, result, dataset.profiles), {
        result,
        execution: { engine: 'duckdb', sqlPreview: null, tableName: null, loadVersion: null, fallbackReason: null, fallbackStage: null },
        activeDataQuery: { result },
        queryTrace,
        binding: null,
        allowedColumns: columns,
    } as never, { groupCoverage });
    return { card: created.card!, companionPlans, groupCoverage };
};

const renderCard = (card: AnalysisCardData, overrides: Partial<AnalysisCardData> = {}) => {
    useAppStore.setState({ analysisCards: [{ ...card, isDataVisible: true, ...overrides }] });
    render(<AnalysisCard cardId={card.id} isSpotlighted />);
    const tableRows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
        .map(row => within(row).getAllByRole('cell').map(cell => cell.textContent ?? ''));
    const legend = screen.getAllByRole('button')
        .map(button => button.textContent ?? '')
        .filter(text => /\(\d+\.\d%\)|\d[\d,]*\.\d{2}$/.test(text));
    return { tableRows, legend, text: document.body.textContent ?? '' };
};

describe('visitor arrivals: top 10 of 52 leaf markets (melted, real DuckDB)', () => {
    it('measures the real leaf total and the number of groups through the evidence path', async () => {
        const { card, companionPlans, groupCoverage } = await runRankedCard(visitors, visitorPlan('sum'), 'DataSeries');

        expect(card.aggregatedData).toHaveLength(10);
        expect(card.aggregatedData.reduce((sum, row) => sum + Number(row[ALIAS]), 0)).toBe(TOP_10_TOTAL);
        expect(groupCoverage).toEqual({ status: 'partial', groupCount: 52, overallTotal: LEAF_TOTAL });
        expect(card.groupCoverage).toEqual(groupCoverage);

        // One ungrouped, unlimited aggregate over the same filters.
        expect(companionPlans).toHaveLength(1);
        expect(companionPlans[0].query).toEqual({
            select: ['group_coverage_total'],
            where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] },
            aggregates: [{ function: 'sum', column: 'Value', as: 'group_coverage_total' }],
            limit: 1,
        });
    }, 60_000);

    it('shows shares of the real total: Indonesia 17.4%, not 23.6%', async () => {
        const { card } = await runRankedCard(visitors, visitorPlan('sum'), 'DataSeries');
        const { legend, text } = renderCard(card);

        const indonesia = legend.find(entry => entry.startsWith('Indonesia'));
        expect(indonesia).toContain('42,399,967.00');
        expect(indonesia).toContain('(17.4%)');
        expect(text).not.toContain('23.6%');
        expect(legend.find(entry => entry.startsWith('China'))).toContain('(15.0%)');
        // Indonesia / the sum of the 10 returned rows would have been 23.6%.
        expect((42_399_967 / TOP_10_TOTAL * 100).toFixed(1)).toBe('23.6');
        expect((42_399_967 / LEAF_TOTAL * 100).toFixed(1)).toBe('17.4');
    }, 60_000);

    it('states the real "Overall", the real group count and an honest scope, never "Full dataset"', async () => {
        const { card } = await runRankedCard(visitors, visitorPlan('sum'), 'DataSeries', { defaultTopN: 8, defaultHideOthers: true });
        expect(card.topN).toBe(8);
        expect(card.hideOthers).toBe(true);
        const { text } = renderCard(card);

        expect(text).toContain('Showing: 163,114,689.00');
        expect(text).toContain('Overall: 244,299,398.00');
        expect(text).toContain('Current view shows 8 of 52 entries and 163,114,689.00 of 244,299,398.00.');
        expect(text).toContain('Top 8 of 52 groups');
        expect(text).not.toContain('Full dataset');
        expect(text).not.toContain('179,811,161');
    }, 60_000);

    it('makes "Others" the real total minus the groups shown, including the 42 groups the query cut off', async () => {
        const { card } = await runRankedCard(visitors, visitorPlan('sum'), 'DataSeries', { defaultTopN: 8, defaultHideOthers: false });
        const { tableRows, legend } = renderCard(card);

        const others = tableRows.find(row => row[0] === 'Others');
        expect(LEAF_TOTAL - TOP_8_TOTAL).toBe(81_184_709);
        expect(others).toEqual(['Others', '81,184,709.00']);
        // Rows 9-10 of the returned groups alone were 16,696,472.
        expect(TOP_10_TOTAL - TOP_8_TOTAL).toBe(16_696_472);
        expect(tableRows).toHaveLength(9);
        expect(legend.find(entry => entry.startsWith('Others'))).toContain('(33.2%)');
        // Every row of the table adds up to the real total.
        expect(tableRows.reduce((sum, row) => sum + Number(row[1].replace(/,/g, '')), 0)).toBe(LEAF_TOTAL);
    }, 60_000);

    it('keeps the cut-off view honest when the user shows all returned groups (no top-N fold)', async () => {
        const { card } = await runRankedCard(visitors, visitorPlan('sum'), 'DataSeries');
        expect(card.topN).toBeNull();
        const { text, legend } = renderCard(card);

        expect(text).toContain('Top 10 of 52 groups');
        expect(text).toContain('Overall: 244,299,398.00');
        expect(text).not.toContain('Full dataset');
        expect(legend.find(entry => entry.startsWith('Indonesia'))).toContain('(17.4%)');
    }, 60_000);

    it('does not export a cut-off ranking as the full card aggregation', async () => {
        const { card } = await runRankedCard(visitors, visitorPlan('sum'), 'DataSeries');
        renderCard(card);
        fireEvent.click(screen.getAllByRole('button', { name: /export/i })[0]);
        fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));

        const metadata = (exportToCsvSpy.mock.calls[0] as unknown as [unknown, string, { scope: string; completeness: string }])[2];
        expect(metadata.scope).toBe('10 of 52 groups returned');
        expect(metadata.completeness).toBe('visible_subset');
    }, 60_000);

    it('falls back honestly when the companion query fails: no share, no overall, no "Full dataset"', async () => {
        const { card, groupCoverage, companionPlans } = await runRankedCard(
            visitors, visitorPlan('sum'), 'DataSeries', { defaultTopN: 8, defaultHideOthers: false }, { failCompanion: true },
        );
        expect(companionPlans).toHaveLength(1);
        expect(groupCoverage).toEqual({ status: 'partial', groupCount: 52, overallTotal: null });
        const { legend, text } = renderCard(card);

        expect(text).toContain('Top 8 of the groups returned');
        expect(text).not.toContain('Full dataset');
        expect(text).not.toContain('Overall:');
        expect(text).toContain('The total over all groups could not be measured, so no overall total or share is shown.');
        expect(legend.some(entry => entry.includes('%'))).toBe(false);
        expect(text).not.toMatch(/\d+\.\d%\)/);
    }, 60_000);

    it('keeps an average without shares, totals or an Others bucket, and runs no companion query', async () => {
        const { card, companionPlans, groupCoverage } = await runRankedCard(
            visitors, visitorPlan('avg'), 'DataSeries', { defaultTopN: 8 },
        );
        expect(companionPlans).toHaveLength(0);
        expect(groupCoverage).toBeNull();
        expect(card.groupCoverage).toBeUndefined();
        const { text, tableRows } = renderCard(card);

        expect(text).toContain('these measures cannot be added together');
        expect(text).not.toContain('Overall');
        expect(text).not.toContain('Others');
        expect(text).not.toMatch(/\(\d+\.\d%\)/);
        expect(tableRows).toHaveLength(8);
    }, 60_000);

    it('uses the real total for the executive share and the group count', async () => {
        const { card } = await runRankedCard(visitors, visitorPlan('sum'), 'DataSeries');
        const trusted: AnalysisCardData = {
            ...card,
            autoAnalysisEvaluation: { verdict: 'trusted', reasonCodes: [], detail: 'trusted', evaluatedAt: new Date().toISOString(), source: 'auto_analysis_evaluator_v1' },
        };
        const kpis = buildExecutiveKpis({
            cards: [trusted], columnProfiles: visitors.profiles, csvData: visitors.data, language: 'English', seriesMeasure: visitors.meta?.seriesMeasure,
        });

        const byId = Object.fromEntries(kpis.map(kpi => [kpi.id, kpi]));
        // The KPI rounds shares to whole percents: 17.4% of the real total, where 23.6% of the rows would read 24%.
        expect(byId['top-group'].detail).toBe('Indonesia holds 17% of total value.');
        // Top 3 of the real total: 97,398,048 / 244,299,398 = 40%, where the 10 returned rows would give 54%.
        expect(byId['top-share'].value).toBe('40%');
        expect(byId['group-count'].value).toBe('52');
        expect(byId['total-metric'].value).toContain('244');
    }, 60_000);

    it('tells the summary model the real total and that the rows are only the top of the ranking', async () => {
        const { card } = await runRankedCard(visitors, visitorPlan('sum'), 'DataSeries');
        const note = describeCardGroupCoverage(card)!;

        expect(note).toContain('top of a ranking of 52 groups');
        expect(note).toContain('179,811,161');
        expect(note).toContain('244,299,398');
        expect(note).toContain('never against the rows shown');
    }, 60_000);
});

describe('plain dataset: top 10 of 15 groups', () => {
    const plain = buildPlainDataset();

    it('shares of the real 12,000 total, not of the 10,500 in the returned rows', async () => {
        const { card, groupCoverage, companionPlans } = await runRankedCard(plain, regionPlan(10), 'Region');
        expect(groupCoverage).toEqual({ status: 'partial', groupCount: 15, overallTotal: 12_000 });
        expect(companionPlans[0].query.groupBy).toBeUndefined();
        const { legend, text } = renderCard(card);

        // Region 01 holds 1,500 of 12,000.
        expect(legend.find(entry => entry.startsWith('Region 01'))).toContain('(12.5%)');
        expect(text).toContain('Top 10 of 15 groups');
        expect(text).toContain('Overall: 12,000.00');
        expect(text).not.toContain('Full dataset');
    }, 60_000);

    it('folds Others as the total minus the shown groups when top 8 is selected', async () => {
        const { card } = await runRankedCard(plain, regionPlan(10), 'Region', { defaultTopN: 8 });
        const { tableRows, text } = renderCard(card);

        // Groups 1-8 hold 9,200 of 12,000; groups 9-15 hold the other 2,800.
        expect(tableRows.find(row => row[0] === 'Others')).toEqual(['Others', '2,800.00']);
        expect(text).toContain('Current view shows 9 of 15 entries and 12,000.00 of 12,000.00.');
    }, 60_000);

    it('measures nothing and says "Full dataset" when the query returned every group', async () => {
        const { card, groupCoverage, companionPlans } = await runRankedCard(plain, regionPlan(50), 'Region');
        expect(companionPlans).toHaveLength(0);
        expect(groupCoverage).toEqual({ status: 'complete', groupCount: 15, overallTotal: 12_000 });
        const { legend, text } = renderCard(card);

        expect(text).toContain('Full dataset');
        expect(text).not.toMatch(/Top \d+ of/);
        expect(legend.find(entry => entry.startsWith('Region 01'))).toContain('(12.5%)');
        expect(text).toContain('Overall: 12,000.00');
    }, 60_000);

    it('keeps the old behaviour for a card without recorded coverage (legacy or client-aggregated)', async () => {
        const { card } = await runRankedCard(plain, regionPlan(50), 'Region', {}, { skipCoverage: true });
        expect(card.groupCoverage).toBeUndefined();
        const { text } = renderCard(card);

        expect(text).toContain('Full dataset');
        expect(text).toContain('Overall: 12,000.00');
    }, 60_000);

    it('counts rows per group (COUNT) against the real row total', async () => {
        const countPlan: SqlEvidenceQueryPlan = {
            title: 'Count by Region',
            queryMode: 'aggregate',
            intentSummary: 'Rank regions by record count.',
            preferredResultShape: 'ranked_aggregate',
            query: {
                select: ['Region', 'record_count'],
                groupBy: ['Region'],
                aggregates: [{ function: 'count', as: 'record_count' }],
                orderBy: [{ column: 'record_count', direction: 'desc' }, { column: 'Region', direction: 'asc' }],
                limit: 10,
            },
        };
        useAppStore.setState({ ...initialAppState, csvData: plain.data, columnProfiles: plain.profiles });
        const columns = Object.keys(plain.data.data[0]);
        const execution = await executeManagedDataQuery(plain.data, countPlan.query, columns, {
            allowNativeFallback: false,
            bypassCache: true,
            dimensionNormalization: { ...DEFAULT_DIMENSION_NORMALIZATION, shouldNormalize: buildColumnTypeGate(plain.profiles) },
        });
        const coverage = await measureGroupCoverage(countPlan, execution.result, checkPlan =>
            executeEvidenceQuery(checkPlan, useAppStore, null, { dataset: plain.data, suppressQueryStateUpdates: true }),
        { valueColumn: 'record_count' });

        expect(coverage).toEqual({ status: 'partial', groupCount: 15, overallTotal: 30 });
    }, 60_000);
});
