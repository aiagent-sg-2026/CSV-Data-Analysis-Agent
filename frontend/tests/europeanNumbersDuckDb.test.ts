// @vitest-environment node
//
// European number formats through the real query path: intake parser, the
// DuckDB serialization step, the query compiler and an in-process DuckDB that
// loads the CSV like services/workers/duckDbWorker.ts does.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CsvData, QueryPlan } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { robustParseFloat } from '../services/data/dataProfiler';
import { executeManagedDataQuery } from '../services/duckdb/queryEngine';
import { tableToRows } from '../services/workers/duckDbRows';

const duck = vi.hoisted(() => ({ db: null as any, conn: null as any }));

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

const FIXTURE_DIR = new URL('./fixtures/weird-reports/', import.meta.url);
const truth = JSON.parse(readFileSync(new URL('truth.json', FIXTURE_DIR), 'utf8')) as { f4: { rows: number; total: number } };

const sumOf = async (data: CsvData, column: string) => {
    const plan: QueryPlan = { aggregates: [{ function: 'sum', column, as: 'total' }], limit: 10 };
    const execution = await executeManagedDataQuery(data, plan, Object.keys(data.data[0] ?? {}), { allowNativeFallback: false, bypassCache: true });
    expect(execution.engine).toBe('duckdb');
    return Number(execution.result.rows[0].total);
};

describe('European numbers in DuckDB', () => {
    it('sums the w4 Betrag column to the ground-truth total, matching the JS parser', async () => {
        const text = readFileSync(new URL('w4_european_semicolon.csv', FIXTURE_DIR), 'utf8');
        const { rawRows, detection } = parseCsvTextWithDetection(text);
        const data = buildCsvDataFromIntakeIr(buildReportIntakeIr('w4_european_semicolon.csv', rawRows, detection));

        expect(data.data).toHaveLength(truth.f4.rows);
        const duckTotal = await sumOf(data, 'Betrag');
        expect(Math.round(duckTotal * 100) / 100).toBe(truth.f4.total);

        const jsTotal = data.data.reduce((sum, row) => sum + (robustParseFloat(row.Betrag) ?? 0), 0);
        expect(Math.round(jsTotal * 100) / 100).toBe(truth.f4.total);
    }, 60_000);

    it('reads each column in its own style, with ambiguous cells following column evidence', async () => {
        const data: CsvData = {
            fileName: 'mixed-number-styles.csv',
            data: [
                // Eu proves the decimal comma, so its 4.567 is 4567.
                { Eu: '4.567', Us: '1,234.56', Ambiguous: '1,234', Plain: '10', Name: 'a' },
                { Eu: '1.234,50', Us: '2,000.00', Ambiguous: '2,345', Plain: '20', Name: 'b' },
                { Eu: '0,5', Us: '3.25', Ambiguous: '', Plain: '30', Name: 'c' },
                { Eu: '(10,00)', Us: '(4.00)', Ambiguous: 'n/a', Plain: '', Name: 'd' },
            ],
        };
        expect(await sumOf(data, 'Eu')).toBeCloseTo(4567 + 1234.5 + 0.5 - 10, 6);
        expect(await sumOf(data, 'Us')).toBeCloseTo(1234.56 + 2000 + 3.25 - 4, 6);
        // No column evidence: a lone 1,234 stays US thousands.
        expect(await sumOf(data, 'Ambiguous')).toBe(1234 + 2345);
        expect(await sumOf(data, 'Plain')).toBe(60);
    }, 60_000);

    it('casts unambiguous European cells even when the column is not normalised first', async () => {
        // A US-style cell in the same column blocks column normalisation, so the
        // SQL expression alone has to handle the unambiguous European cells.
        const data: CsvData = {
            fileName: 'mixed-in-one-column.csv',
            data: [{ V: '1.234,56' }, { V: '161,30' }, { V: '1.234.567' }, { V: '1,234.50' }],
        };
        expect(await sumOf(data, 'V')).toBeCloseTo(1234.56 + 161.3 + 1234567 + 1234.5, 6);
    }, 60_000);
});
