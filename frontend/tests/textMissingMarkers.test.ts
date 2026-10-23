// @vitest-environment node
//
// Missing markers (`na`, `-`) mean "no value" only in numeric columns. In a
// text column they are real values: `NA` is North America in a Region column,
// and a column of `-` is still a column of values. These tests run the same
// table through the profilers and all three query engines (DuckDB with a real
// in-process database, the in-process executor and Arquero).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CsvData, QueryPlan } from '../types';
import { profileData, profileDataLightweight } from '../services/data/dataProfiler';
import { executeManagedDataQuery } from '../services/duckdb/queryEngine';
import { buildColumnTypeGate, DEFAULT_DIMENSION_NORMALIZATION } from '../services/duckdb/dimensionNormalization';
import { executeDataQuery } from '../services/agent/execution/dataQueryExecutor';
import { executeArqueroQuery } from '../services/data/arqueroEngine';
import { tableToRows } from '../services/workers/duckDbRows';

const duck = vi.hoisted(() => ({ db: null as any, conn: null as any }));

vi.mock('../services/workers/duckDbWorkerClient', () => ({
    duckDbWorkerClient: {
        initDuckDb: async () => ({ initialized: true }),
        loadCleanDataset: async (payload: { csvText: string; csvFileName: string; loadVersion: string; tableName: string }) => {
            const table = `"${payload.tableName.replace(/"/g, '""')}"`;
            await duck.db.registerFileText(payload.csvFileName, payload.csvText);
            duck.conn.query(`DROP TABLE IF EXISTS ${table}`);
            // Same load statement as the production worker.
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

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const wasmBase = fileURLToPath(new URL('../node_modules/@duckdb/duckdb-wasm/dist/', import.meta.url));

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

const SALES: CsvData = {
    fileName: 'regional-sales.csv',
    data: [
        { Region: 'NA', Revenue: '100', Returns: '-', Note: '' },
        { Region: 'EU', Revenue: '200', Returns: '-', Note: 'x' },
        { Region: 'APAC', Revenue: '300', Returns: '-', Note: '' },
        { Region: 'NA', Revenue: 'na', Returns: '-', Note: '' },
        { Region: 'LATAM', Revenue: '10', Returns: '-', Note: '' },
        { Region: 'NA', Revenue: '70', Returns: '-', Note: '' },
        { Region: 'EU', Revenue: '40', Returns: '-', Note: '' },
    ],
};
const COLUMNS = ['Region', 'Revenue', 'Returns', 'Note'];

const COUNT_PLAN: QueryPlan = {
    aggregates: [
        { function: 'count', column: 'Region', as: 'regions' },
        { function: 'count_distinct', column: 'Region', as: 'distinct_regions' },
        { function: 'count', column: 'Returns', as: 'returns' },
        { function: 'count_distinct', column: 'Returns', as: 'distinct_returns' },
        { function: 'count', column: 'Revenue', as: 'revenues' },
        { function: 'count_distinct', column: 'Revenue', as: 'distinct_revenues' },
        { function: 'count', column: 'Note', as: 'notes' },
        { function: 'avg', column: 'Revenue', as: 'avg_revenue' },
    ],
    limit: 10,
};

const EXPECTED_COUNTS = {
    regions: 7,
    distinct_regions: 4,
    returns: 7,
    distinct_returns: 1,
    // The numeric column still skips its `na`.
    revenues: 6,
    distinct_revenues: 6,
    notes: 1,
};

const normalize = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : Number(value)]));

describe('missing markers in text columns', () => {
    it('counts NA and - as values in text columns on every query engine', async () => {
        const { profiles } = profileData(SALES.data);
        const duckRows = (await executeManagedDataQuery(SALES, COUNT_PLAN, COLUMNS, {
            allowNativeFallback: false,
            bypassCache: true,
            dimensionNormalization: { ...DEFAULT_DIMENSION_NORMALIZATION, shouldNormalize: buildColumnTypeGate(profiles) },
        })).result.rows;
        const nativeRows = executeDataQuery(SALES.data, COUNT_PLAN, { allowedColumns: COLUMNS }).rows;
        const arquero = executeArqueroQuery(SALES.data, COUNT_PLAN, { allowedColumns: COLUMNS });
        expect(arquero.unsupportedReason).toBeNull();

        for (const rows of [duckRows, nativeRows, arquero.result!.rows]) {
            expect(rows).toHaveLength(1);
            const row = normalize(rows[0] as Record<string, unknown>);
            expect(row).toMatchObject(EXPECTED_COUNTS);
            expect(row.avg_revenue).toBeCloseTo(720 / 6, 9);
        }
    });

    it('profiles a text column of markers as values, not missing cells', () => {
        for (const { profiles } of [profileData(SALES.data), profileDataLightweight(SALES.data)]) {
            const byName = new Map(profiles.map(profile => [profile.name, profile]));
            expect(byName.get('Region')).toMatchObject({ type: 'categorical', uniqueValues: 4, missingPercentage: 0 });
            // An all-marker column would otherwise be 100% missing and dropped by cleaning.
            expect(byName.get('Returns')).toMatchObject({ type: 'categorical', uniqueValues: 1, missingPercentage: 0 });
            expect(byName.get('Revenue')?.type).toBe('numerical');
            expect(byName.get('Revenue')?.missingPercentage).toBeCloseTo(100 / 7, 6);
            expect(byName.get('Note')?.missingPercentage).toBeCloseTo(600 / 7, 6);
        }
    });

    it('still treats an all-blank column as completely missing', () => {
        const rows = [{ A: '1', B: '' }, { A: '2', B: '  ' }];
        for (const { profiles } of [profileData(rows), profileDataLightweight(rows)]) {
            expect(profiles.find(profile => profile.name === 'B')?.missingPercentage).toBe(100);
        }
    });
});
