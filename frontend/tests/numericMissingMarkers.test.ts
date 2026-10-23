// @vitest-environment node
//
// Regression: on the live site the evidence card "Median Gross Mthly 25
// Percentile by School" ranked "School of Law" at 0 and "Yong Siew Toh" at
// 1,500. Both come from missing markers (`na`, `N.A.`) that the DuckDB query
// compiler coalesced to 0 before aggregating. These tests run the real demo
// CSV through the app's intake parser, the DuckDB query engine (with the
// worker transport replaced by a real in-process DuckDB that loads the CSV the
// same way services/workers/duckDbWorker.ts does) and the query compiler.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CsvData, QueryPlan } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { executeManagedDataQuery } from '../services/duckdb/queryEngine';
import { compileQueryPlanToDuckDbSql, compileUnpivotToDuckDbSql } from '../services/duckdb/queryCompiler';
import { buildColumnTypeGate, DEFAULT_DIMENSION_NORMALIZATION } from '../services/duckdb/dimensionNormalization';
import { executeDataQuery } from '../services/agent/execution/dataQueryExecutor';
import { executeArqueroQuery } from '../services/data/arqueroEngine';
import { tableToRows } from '../services/workers/duckDbRows';

const duck = vi.hoisted(() => ({ db: null as any, conn: null as any, loaded: null as { tableName: string; loadVersion: string } | null }));

vi.mock('../services/workers/duckDbWorkerClient', () => ({
    duckDbWorkerClient: {
        initDuckDb: async () => ({ initialized: true }),
        loadCleanDataset: async (payload: { csvText: string; csvFileName: string; loadVersion: string; tableName: string }) => {
            const table = `"${payload.tableName.replace(/"/g, '""')}"`;
            await duck.db.registerFileText(payload.csvFileName, payload.csvText);
            duck.conn.query(`DROP TABLE IF EXISTS ${table}`);
            // Same load statement as the production worker.
            duck.conn.query(`CREATE TABLE ${table} AS SELECT * FROM read_csv_auto('${payload.csvFileName.replace(/'/g, "''")}', header=true, all_varchar=true)`);
            duck.loaded = { tableName: payload.tableName, loadVersion: payload.loadVersion };
            return { loaded: true, ...duck.loaded };
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

const importCsvText = (fileName: string, text: string): CsvData => {
    const { rawRows, detection } = parseCsvTextWithDetection(text);
    return buildCsvDataFromIntakeIr(buildReportIntakeIr(fileName, rawRows, detection));
};

const importDemoCsv = (name: string): CsvData =>
    importCsvText(name, readFileSync(fileURLToPath(new URL(`../../demo-data/${name}`, import.meta.url)), 'utf8'));

// The HDB rent file has no quoted fields. It is split directly so this test
// does not depend on header-layer detection, which is covered elsewhere.
const loadUnquotedDemoCsv = (name: string): CsvData => {
    const [header, ...lines] = readFileSync(fileURLToPath(new URL(`../../demo-data/${name}`, import.meta.url)), 'utf8')
        .split(/\r?\n/)
        .filter(line => line.length > 0)
        .map(line => line.split(','));
    return { fileName: name, data: lines.map(cells => Object.fromEntries(header.map((column, index) => [column, cells[index] ?? '']))) };
};

const columnsOf = (data: CsvData) => Object.keys(data.data[0] ?? {});

// The evidence card path compiles with the type-gated dimension normalization.
const runEvidenceQuery = async (data: CsvData, plan: QueryPlan) => {
    const { profiles } = profileData(data.data);
    const execution = await executeManagedDataQuery(data, plan, columnsOf(data), {
        allowNativeFallback: false,
        bypassCache: true,
        dimensionNormalization: { ...DEFAULT_DIMENSION_NORMALIZATION, shouldNormalize: buildColumnTypeGate(profiles) },
    });
    expect(execution.engine).toBe('duckdb');
    return execution.result.rows;
};

const toNumberOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));

const MARKERS = ['', '   ', 'na', 'NA', 'n/a', 'N/A', 'n.a.', 'N.A.', '-', '--', '\u2014', '\u2013', 'null', 'NULL', 'none', 'nan', 'NaN', 'nil'];

const buildMarkerDataset = (marker: string): CsvData => ({
    fileName: `marker-${encodeURIComponent(marker) || 'empty'}.csv`,
    data: [
        { grp: 'only_missing', v: marker },
        { grp: 'only_missing', v: marker },
        { grp: 'mixed', v: '10' },
        { grp: 'mixed', v: marker },
        { grp: 'mixed', v: '30' },
        { grp: 'mixed', v: '0' },
    ],
});

const MARKER_PLAN: QueryPlan = {
    groupBy: ['grp'],
    aggregates: [
        { function: 'sum', column: 'v', as: 'sum_v' },
        { function: 'avg', column: 'v', as: 'avg_v' },
        { function: 'min', column: 'v', as: 'min_v' },
        { function: 'max', column: 'v', as: 'max_v' },
        { function: 'median', column: 'v', as: 'median_v' },
        { function: 'percentile', column: 'v', percentile: 0.5, as: 'p50_v' },
        { function: 'count', column: 'v', as: 'count_v' },
        { function: 'count_distinct', column: 'v', as: 'distinct_v' },
        { function: 'count', as: 'rows' },
    ],
    orderBy: [{ column: 'grp', direction: 'asc' }],
    limit: 10,
};

const expectMarkerAggregates = (rows: Array<Record<string, unknown>>) => {
    const mixed = rows.find(row => row.grp === 'mixed')!;
    const onlyMissing = rows.find(row => row.grp === 'only_missing')!;
    // A valid zero still counts as a value.
    expect(mixed).toMatchObject({ sum_v: 40, min_v: 0, max_v: 30, median_v: 10, p50_v: 10 });
    expect(Number(mixed.avg_v)).toBeCloseTo(40 / 3, 9);
    expect(Number(mixed.count_v)).toBe(3);
    expect(Number(mixed.distinct_v)).toBe(3);
    expect(Number(mixed.rows)).toBe(4);
    for (const key of ['sum_v', 'avg_v', 'min_v', 'max_v', 'median_v', 'p50_v']) {
        expect(onlyMissing[key] ?? null).toBeNull();
    }
    expect(Number(onlyMissing.count_v)).toBe(0);
    expect(Number(onlyMissing.distinct_v)).toBe(0);
    expect(Number(onlyMissing.rows)).toBe(2);
};

describe('numeric missing markers in DuckDB aggregation', () => {
    it('gives School of Law a NULL median and keeps the lowest real median at 2,050 (real demo CSV)', async () => {
        const data = importDemoCsv('sg-graduate-employment.csv');
        const rows = await runEvidenceQuery(data, {
            groupBy: ['school'],
            aggregates: [
                { function: 'median', column: 'gross_mthly_25_percentile', as: 'median_p25' },
                { function: 'avg', column: 'gross_mthly_25_percentile', as: 'avg_p25' },
                { function: 'min', column: 'gross_mthly_25_percentile', as: 'min_p25' },
                { function: 'count', column: 'gross_mthly_25_percentile', as: 'reported' },
                { function: 'count', as: 'row_count' },
            ],
            orderBy: [{ column: 'median_p25', direction: 'asc' }],
            limit: 500,
        });

        const law = rows.find(row => row.school === 'School of Law');
        expect(law).toBeDefined();
        expect(law!.median_p25).toBeNull();
        expect(law!.avg_p25).toBeNull();
        expect(law!.min_p25).toBeNull();
        expect(Number(law!.reported)).toBe(0);
        expect(Number(law!.row_count)).toBe(3);

        // Yong Siew Toh: na, na, 3000, 2999, 1500 -> median of reported values is 2,999.
        const yst = rows.find(row => row.school === 'Yong Siew Toh Conservatory of Music');
        expect(toNumberOrNull(yst?.median_p25)).toBe(2999);
        expect(Number(yst?.reported)).toBe(3);
        expect(Number(yst?.row_count)).toBe(5);

        const realMedians = rows.map(row => toNumberOrNull(row.median_p25)).filter((value): value is number => value !== null);
        expect(Math.min(...realMedians)).toBe(2050);
        expect(rows.find(row => toNumberOrNull(row.median_p25) === 2050)?.school).toBe('YST Conservatory Of Music');
        expect(realMedians).not.toContain(0);
    });

    it('keeps the DuckDB result equal to the in-process query path on the real CSV', async () => {
        const data = importDemoCsv('sg-graduate-employment.csv');
        const plan: QueryPlan = {
            groupBy: ['university'],
            aggregates: [
                { function: 'median', column: 'basic_monthly_median', as: 'median_basic' },
                { function: 'count', column: 'basic_monthly_median', as: 'reported' },
            ],
            orderBy: [{ column: 'university', direction: 'asc' }],
            limit: 500,
        };
        const duckRows = await runEvidenceQuery(data, plan);
        const nativeRows = executeDataQuery(data.data, plan, { allowedColumns: columnsOf(data) }).rows;
        const normalize = (rows: Array<Record<string, unknown>>) => rows
            .map(row => ({ university: row.university, median: toNumberOrNull(row.median_basic), reported: Number(row.reported) }))
            .sort((a, b) => String(a.university).localeCompare(String(b.university)));
        expect(normalize(duckRows)).toEqual(normalize(nativeRows));
    });

    it('treats the HDB rent markers `na` and `-` as missing, not 0 (real demo CSV)', async () => {
        const data = loadUnquotedDemoCsv('sg-hdb-median-rent.csv');
        const rows = await runEvidenceQuery(data, {
            groupBy: ['flat_type'],
            aggregates: [
                { function: 'min', column: 'median_rent', as: 'min_rent' },
                { function: 'count', column: 'median_rent', as: 'reported' },
                { function: 'count', as: 'row_count' },
            ],
            limit: 50,
        });
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            if (row.min_rent !== null) expect(Number(row.min_rent)).toBeGreaterThan(0);
            expect(Number(row.reported)).toBeLessThanOrEqual(Number(row.row_count));
        }
        const reported = rows.reduce((total, row) => total + Number(row.reported), 0);
        const all = rows.reduce((total, row) => total + Number(row.row_count), 0);
        // 2,273 `na` and 2,249 `-` cells are not reported values.
        expect(all - reported).toBe(2273 + 2249);
    });

    it.each(MARKERS)('treats the marker %j as missing in every DuckDB numeric aggregate', async marker => {
        expectMarkerAggregates(await runEvidenceQuery(buildMarkerDataset(marker), MARKER_PLAN));
    });

    it.each(MARKERS)('treats the marker %j as missing in the Arquero and native fallback paths', marker => {
        const data = buildMarkerDataset(marker);
        const arquero = executeArqueroQuery(data.data, MARKER_PLAN, { allowedColumns: ['grp', 'v'] });
        expect(arquero.supported).toBe(true);
        expectMarkerAggregates(arquero.result.rows);
        expectMarkerAggregates(executeDataQuery(data.data, MARKER_PLAN, { allowedColumns: ['grp', 'v'] }).rows);
    });


    it('keeps a footnote-marked value such as `3200*` out of numeric aggregates instead of reading it as 0', async () => {
        const data: CsvData = {
            fileName: 'footnote.csv',
            data: [{ g: 'a', v: '3200*' }, { g: 'a', v: '3000' }],
        };
        const rows = await runEvidenceQuery(data, {
            groupBy: ['g'],
            aggregates: [{ function: 'min', column: 'v', as: 'min_v' }, { function: 'avg', column: 'v', as: 'avg_v' }],
            limit: 10,
        });
        expect(rows[0]).toMatchObject({ min_v: 3000, avg_v: 3000 });
    });

    it('returns NULL for a multi-column period sum only when every source column is missing', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            groupBy: ['g'],
            aggregates: [
                { function: 'sum', column: 'OCT 2010 + NOV 2010 + DEC 2010', as: 'total' },
                { function: 'count', column: 'OCT 2010 + NOV 2010 + DEC 2010', as: 'reported' },
            ],
            orderBy: [{ column: 'g', direction: 'asc' }],
            limit: 10,
        }, { tableName: 'multi_missing', allowedColumns: ['g', 'OCT 2010', 'NOV 2010', 'DEC 2010'] });
        duck.conn.query('DROP TABLE IF EXISTS multi_missing');
        duck.conn.query(`CREATE TABLE multi_missing AS SELECT * FROM (VALUES
            ('x', 'na', '-', ''), ('x', 'na', 'N.A.', '—'), ('y', '5', 'na', '-'), ('y', '0', '0', '0')) t(g, "OCT 2010", "NOV 2010", "DEC 2010")`);
        const rows = tableToRows(duck.conn.query(compiled.sql));
        expect(rows.find(row => row.g === 'x')).toMatchObject({ total: null, reported: 0 });
        expect(rows.find(row => row.g === 'y')).toMatchObject({ total: 5, reported: 2 });
    });

    it('does not turn missing markers into 0 in an unpivot aggregate', () => {
        duck.conn.query('DROP TABLE IF EXISTS unpivot_missing');
        duck.conn.query(`CREATE TABLE unpivot_missing AS SELECT * FROM (VALUES ('s1', 'na', '4'), ('s2', 'N.A.', '6')) t(series, y2024, y2025)`);
        const compiled = compileUnpivotToDuckDbSql(
            { sourceColumns: ['y2024', 'y2025'], nameAs: 'year', valueAs: 'value', aggregate: 'min' },
            { tableName: 'unpivot_missing', allowedColumns: ['series', 'y2024', 'y2025'] },
        );
        const rows = tableToRows(duck.conn.query(compiled.sql));
        expect(rows).toEqual([{ year: 'y2024', value: null }, { year: 'y2025', value: 4 }]);
    });
});
