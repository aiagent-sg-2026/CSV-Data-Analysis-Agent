// End-to-end regression: the real sg-hdb-median-rent.csv runs through the
// DuckDB query engine (the worker transport is replaced by an in-process
// DuckDB that loads the CSV like services/workers/duckDbWorker.ts), the
// SQL-first card path and the rendered card. Flat type 1-RM has only `na`/`-`
// rent cells, so its median is NULL and the card must show "No data", not 0.00.

import React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CsvData, CsvRow, SqlEvidenceQueryPlan } from '../types';
import { initialAppState, useAppStore } from '../store/useAppStore';
import { profileData } from '../services/data/dataProfiler';
import { executeManagedDataQuery } from '../services/duckdb/queryEngine';
import { buildColumnTypeGate, DEFAULT_DIMENSION_NORMALIZATION } from '../services/duckdb/dimensionNormalization';
import { buildEvidenceResultSummary, executePresentationPlanAndCreateCard } from '../services/agent/execution/sqlCardExecutor';
import { tableToRows } from '../services/workers/duckDbRows';
import { AnalysisCard } from '../components/analysis-card/AnalysisCard';
import { createChartConfig } from '../utils/chartConfigFactory';

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

// jsdom replaces the global URL, so paths are resolved from the package root.
const require = createRequire(path.resolve(process.cwd(), 'package.json'));
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const wasmBase = `${path.resolve(process.cwd(), 'node_modules/@duckdb/duckdb-wasm/dist')}/`;

beforeAll(async () => {
    duck.db = await duckdb.createDuckDB(
        { mvp: { mainModule: `${wasmBase}duckdb-mvp.wasm` }, eh: { mainModule: `${wasmBase}duckdb-eh.wasm` } },
        new duckdb.VoidLogger(),
        duckdb.NODE_RUNTIME,
    );
    await duck.db.instantiate();
    duck.db.open({ path: ':memory:', maximumThreads: 1 });
    duck.conn = duck.db.connect();
}, 30_000);
afterAll(() => duck.conn?.close());
afterEach(() => {
    cleanup();
    useAppStore.setState(initialAppState);
});

// The file has no quoted fields; splitting directly keeps this test independent of intake detection.
const loadRentCsv = (): CsvData => {
    const [header, ...lines] = readFileSync(path.resolve(process.cwd(), '../demo-data/sg-hdb-median-rent.csv'), 'utf8')
        .split(/\r?\n/)
        .filter(line => line.length > 0)
        .map(line => line.split(','));
    return { fileName: 'sg-hdb-median-rent.csv', data: lines.map(cells => Object.fromEntries(header.map((column, index) => [column, cells[index] ?? '']))) };
};

const ALIAS = 'typical_rent';
const evidencePlan: SqlEvidenceQueryPlan = {
    title: 'Flat types with the highest typical rent',
    queryMode: 'aggregate',
    intentSummary: 'Rank flat types by median rent; highest first.',
    preferredResultShape: 'ranked_aggregate',
    query: {
        select: ['flat_type', ALIAS],
        groupBy: ['flat_type'],
        aggregates: [{ function: 'median', column: 'median_rent', as: ALIAS }],
        orderBy: [{ column: ALIAS, direction: 'desc' }],
        limit: 50,
    },
};

describe('NULL median rent from DuckDB to the rendered card (real demo CSV)', () => {
    it('shows 1-RM as "No data", last, with no chart bar, and keeps the real medians', async () => {
        const data = loadRentCsv();
        const columns = Object.keys(data.data[0]);
        const { profiles } = profileData(data.data);
        const execution = await executeManagedDataQuery(data, evidencePlan.query, columns, {
            allowNativeFallback: false,
            bypassCache: true,
            dimensionNormalization: { ...DEFAULT_DIMENSION_NORMALIZATION, shouldNormalize: buildColumnTypeGate(profiles) },
        });
        expect(execution.engine).toBe('duckdb');
        const result = execution.result;
        expect(result.rows.find(row => row.flat_type === '1-RM')?.[ALIAS]).toBeNull();

        useAppStore.setState({
            ...initialAppState,
            settings: { ...initialAppState.settings, language: 'English', enableVisualEvaluation: false },
            columnProfiles: profiles,
            csvData: data,
        });
        const created = await executePresentationPlanAndCreateCard(evidencePlan, {
            title: 'Flat types with the highest typical rent',
            description: 'Median rent by flat type; highest first.',
            presentationMode: 'chart',
            chartType: 'bar',
            bindings: { groupByColumn: 'flat_type', valueColumn: ALIAS },
        }, useAppStore, buildEvidenceResultSummary(evidencePlan, result, profiles), {
            result,
            execution: { engine: 'duckdb', sqlPreview: null, tableName: null, loadVersion: null, fallbackReason: null, fallbackStage: null },
            activeDataQuery: { result },
            queryTrace: undefined,
            binding: null,
            allowedColumns: columns,
        } as never);
        const card = created.card!;
        expect(card.summary.text).not.toMatch(/1-RM: 0/);

        useAppStore.setState({ analysisCards: [{ ...card, isDataVisible: true }] });
        render(<AnalysisCard cardId={card.id} isSpotlighted />);

        const tableRows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
            .map(row => within(row).getAllByRole('cell').map(cell => cell.textContent));
        expect(tableRows).toEqual([
            ['5-RM', '2,600.00'],
            ['EXEC', '2,500.00'],
            ['4-RM', '2,400.00'],
            ['2-RM', '2,200.00'],
            ['3-RM', '2,000.00'],
            ['1-RM', 'No data'],
        ]);
        expect(document.body.textContent).not.toContain('1-RM0.00');

        const chart = chartCalls[chartCalls.length - 1];
        const config = createChartConfig({
            chartType: chart.displayChartType as never,
            data: chart.dataForDisplay,
            plan: chart.plan,
            selectedIndices: [],
            onElementClick: () => undefined,
            onZoomChange: () => undefined,
        });
        expect(config.data.labels).toEqual(['5-RM', 'EXEC', '4-RM', '2-RM', '3-RM', '1-RM']);
        expect(config.data.datasets[0].data).toEqual([2600, 2500, 2400, 2200, 2000, null]);
    }, 60_000);
});
