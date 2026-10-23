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
import { profileData, robustParseFloat } from '../services/data/dataProfiler';
import { executeManagedDataQuery } from '../services/duckdb/queryEngine';
import { tableToRows } from '../services/workers/duckDbRows';
import { executeArqueroQuery } from '../services/data/arqueroEngine';
import { executeDataQuery } from '../services/agent/execution/dataQueryExecutor';

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
        // 1.234.567 may be a code: without column proof it stays NULL, like the JS parser.
        const data: CsvData = {
            fileName: 'mixed-in-one-column.csv',
            data: [{ V: '1.234,56' }, { V: '161,30' }, { V: '1.234.567' }, { V: '1,234.50' }],
        };
        expect(await sumOf(data, 'V')).toBeCloseTo(1234.56 + 161.3 + 1234.5, 6);
        expect(robustParseFloat('1.234.567')).toBeNull();
    }, 60_000);
});

const selectColumn = async (data: CsvData, column: string) => {
    const plan: QueryPlan = { select: [column], limit: 50 };
    const execution = await executeManagedDataQuery(data, plan, Object.keys(data.data[0] ?? {}), { allowNativeFallback: false, bypassCache: true });
    expect(execution.engine).toBe('duckdb');
    return execution.result.rows.map(row => String(row[column]));
};

// The Arquero and native JS executors must read the column like DuckDB does.
const expectEnginesAgree = async (data: CsvData, column: string) => {
    const plan: QueryPlan = { aggregates: [{ function: 'sum', column, as: 'total' }], limit: 10 };
    const duckTotal = await sumOf(data, column);
    const arquero = executeArqueroQuery(data.data, plan, { allowedColumns: [column] });
    expect(arquero.supported).toBe(true);
    expect(Number(arquero.result.rows[0].total)).toBeCloseTo(duckTotal, 6);
    expect(Number(executeDataQuery(data.data, plan, { allowedColumns: [column] }).rows[0].total)).toBeCloseTo(duckTotal, 6);
};

const jsSum = (data: CsvData, column: string) =>
    data.data.reduce((sum, row) => sum + (robustParseFloat(row[column]) ?? 0), 0);

describe('number formats the profiler advertises as measures agree with DuckDB', () => {
    it('sums Swiss apostrophe numbers like the JS parser and the profile', async () => {
        const data: CsvData = {
            fileName: 'swiss-amounts.csv',
            data: [
                { Amt: "1'234.50", Typo: '1’234.50', Odd: "5'6" },
                { Amt: "2'234.50", Typo: '2’234.50', Odd: "7'8" },
                { Amt: "-3'000.25", Typo: '(3’000.25)', Odd: "O'Brien" },
                { Amt: "1'000'000.00", Typo: '12’345', Odd: '' },
            ],
        };
        const { profiles } = profileData(data.data);
        expect(profiles.find(profile => profile.name === 'Amt')?.type).toBe('numerical');
        const expectedAmt = 1234.5 + 2234.5 - 3000.25 + 1000000;
        expect(jsSum(data, 'Amt')).toBeCloseTo(expectedAmt, 6);
        expect(await sumOf(data, 'Amt')).toBeCloseTo(expectedAmt, 6);
        await expectEnginesAgree(data, 'Amt');
        await expectEnginesAgree(data, 'Typo');
        expect(await sumOf(data, 'Typo')).toBeCloseTo(jsSum(data, 'Typo'), 6);
        expect(await sumOf(data, 'Typo')).toBeCloseTo(1234.5 + 2234.5 - 3000.25 + 12345, 6);
        // Apostrophes that are not thousands separators never become digits.
        expect(robustParseFloat("5'6")).toBeNull();
        expect(await sumOf(data, 'Odd')).toBe(0); // NULL, not 56 + 78
    }, 60_000);

    it('sums Indian lakh/crore grouping with and without decimals like the JS parser', async () => {
        const data: CsvData = {
            fileName: 'indian-grouping.csv',
            data: [{ Amt: '12,34,567.89', Whole: '12,34,567' }, { Amt: '1,23,456.00', Whole: '1,23,456' }, { Amt: '10,34,567.50', Whole: '999' }],
        };
        expect(robustParseFloat('12,34,567.89')).toBe(1234567.89);
        expect(robustParseFloat('12,34,567')).toBe(1234567);
        const { profiles } = profileData(data.data);
        expect(profiles.find(profile => profile.name === 'Amt')?.type).toBe('numerical');
        expect(profiles.find(profile => profile.name === 'Whole')?.type).toBe('numerical');
        expect(await sumOf(data, 'Amt')).toBeCloseTo(1234567.89 + 123456 + 1034567.5, 6);
        expect(await sumOf(data, 'Amt')).toBeCloseTo(jsSum(data, 'Amt'), 6);
        expect(await sumOf(data, 'Whole')).toBeCloseTo(jsSum(data, 'Whole'), 6);
        await expectEnginesAgree(data, 'Amt');
        await expectEnginesAgree(data, 'Whole');
    }, 60_000);

    it('never rewrites identifier columns that merely look like decimal-comma numbers', async () => {
        const data: CsvData = {
            fileName: 'identifier-columns.csv',
            data: [
                { Code: '1.234.567', Ref: '12,34', Rate: '12,5%', Preis: '161,30' },
                { Code: '2.345.678', Ref: '56,78', Rate: '7,25%', Preis: '12,50' },
            ],
        };
        // Same text in DuckDB as in the data: no silent rewrite of codes.
        expect(await selectColumn(data, 'Code')).toEqual(['1.234.567', '2.345.678']);
        expect(await selectColumn(data, 'Ref')).toEqual(['12,34', '56,78']);
        // A real measure column in the same file is read as numbers.
        expect(await sumOf(data, 'Preis')).toBeCloseTo(173.8, 6);
        expect(await sumOf(data, 'Rate')).toBeCloseTo(19.75, 6);
        expect(await selectColumn(data, 'Rate')).toEqual(['12.5%', '7.25%']);
    }, 60_000);

    it('reads an ambiguous-only column in a European file as thousands, junk cell included', async () => {
        const data: CsvData = {
            fileName: 'european-with-junk.csv',
            data: [
                { Preis: '12,50', Menge: '1.000' },
                { Preis: '7,25', Menge: '2.500' },
                { Preis: '3,10', Menge: '3.200' },
                ...Array.from({ length: 17 }, () => ({ Preis: '1,00', Menge: '0' })),
                { Preis: 'TBD', Menge: '0' },
            ],
        };
        expect(await sumOf(data, 'Menge')).toBe(6700);
        expect(await sumOf(data, 'Preis')).toBeCloseTo(12.5 + 7.25 + 3.1 + 17, 6);
        const { profiles } = profileData(data.data);
        expect(profiles.find(profile => profile.name === 'Menge')?.numberFormat).toBe('decimal_comma');
    }, 60_000);
});
