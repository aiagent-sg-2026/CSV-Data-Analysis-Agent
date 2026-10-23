// @vitest-environment node
//
// The number path the browser takes, offline: import -> profile -> deterministic
// cleaning plan -> cleaning operations -> canonical dataset preparation ->
// DuckDB load -> compiled aggregate. A live run showed the w4 European file
// summing to 4,824,436.70 instead of 225,644,688.43 (exactly "strip every comma,
// then parse"), and Preis medians 100x too large. These tests run that flow on the
// w4 fixture (and, when python3 is available, on the full-size SCALE=1 file) with a
// real in-process DuckDB and compare against values computed independently here.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Papa from 'papaparse';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CsvData, DataPreparationPlan, QueryPlan } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { buildDeterministicNormalizationPlan } from '../services/ai/deterministicNormalizer';
import { applyDataOperations } from '../services/agent/execution/dataOperationRunner';
import { applyPreparationPlanToCanonicalDataset } from '../services/agent/orchestration/canonicalPreparation';
import { executeManagedDataQuery } from '../services/duckdb/queryEngine';
import { tableToRows } from '../services/workers/duckDbRows';
import { resolveDiagnosticTemplate } from '../services/duckdb/diagnosticTemplates';

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

const FIXTURE_DIR = path.resolve(fileURLToPath(new URL('./fixtures/weird-reports/', import.meta.url)));

const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Independent reference: parse the file with PapaParse and read European numbers with plain string surgery. */
const readReference = (text: string) => {
    const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { delimiter: ';' }).data
        .filter(row => row.length > 1 && row[0] !== '');
    const [header, ...body] = parsed;
    const col = (name: string) => header.indexOf(name);
    const euro = (cell: string) => Number(cell.replace(/\./g, '').replace(',', '.'));
    const records = body.map(row => ({
        kunde: row[col('Kunde')], beschreibung: row[col('Beschreibung')],
        menge: Number(row[col('Menge')]), preis: euro(row[col('Preis')]), betrag: euro(row[col('Betrag')]),
    }));
    return records;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The browser's data path up to the DuckDB load, including the steps that rewrite cell text. */
const runProductionFlow = (text: string, fileName: string, delimiterHint?: string): { cleaned: CsvData; canonical: CsvData } => {
    const { rawRows, detection } = parseCsvTextWithDetection(text);
    if (delimiterHint) expect(detection.delimiter).toBe(delimiterHint);
    const imported = buildCsvDataFromIntakeIr(buildReportIntakeIr(fileName, rawRows, detection));
    const { profiles } = profileData(imported.data);

    // Cleaning: the deterministic numeric normalisation plus whatever cast_column steps
    // an AI plan adds for the measures.
    const aiPlan: DataPreparationPlan = {
        explanation: 'cast measures',
        operations: [
            { id: 'cast_menge', type: 'cast_column', reason: 'measure', column: 'Menge', targetType: 'number' },
            { id: 'cast_preis', type: 'cast_column', reason: 'measure', column: 'Preis', targetType: 'number' },
            { id: 'cast_betrag', type: 'cast_column', reason: 'measure', column: 'Betrag', targetType: 'number' },
        ],
        outputColumns: profiles,
        planStatus: 'operations',
        consistencyIssues: [],
    };
    const normalization = buildDeterministicNormalizationPlan(aiPlan, profiles, imported.data);
    const cleaned: CsvData = {
        ...imported,
        data: applyDataOperations(imported.data, normalization.plan.operations, { allowEmptyResult: false }).data,
    };

    // Canonical preparation re-applies the numeric columns the plan lists; a plan
    // that lists the measures (as the normaliser does for formatted-number columns)
    // must read them per column, not by stripping commas.
    const canonical = applyPreparationPlanToCanonicalDataset(imported, {
        ...aiPlan,
        operations: [],
        numericStringNormalizedColumns: ['Menge', 'Preis', 'Betrag'],
    })!;
    return { cleaned, canonical };
};

const aggregate = async (data: CsvData, fn: 'sum' | 'median', column: string, groupBy?: string) => {
    const plan: QueryPlan = {
        ...(groupBy ? { groupBy: [groupBy] } : {}),
        aggregates: [{ function: fn, column, as: 'value' }],
        limit: 50,
    };
    const execution = await executeManagedDataQuery(data, plan, Object.keys(data.data[0] ?? {}), { allowNativeFallback: false, bypassCache: true });
    expect(execution.engine).toBe('duckdb');
    return execution.result.rows;
};

const expectFlowMatchesReference = async (text: string, fileName: string, reference: ReturnType<typeof readReference>, total: number, delimiter: string) => {
    const { cleaned, canonical } = runProductionFlow(text, fileName, delimiter);
    const preisMedian = median(reference.map(record => record.preis));
    for (const [label, data] of [['cleaned', cleaned], ['canonical', canonical]] as const) {
        expect(data.data, label).toHaveLength(reference.length);
        const sum = Number((await aggregate(data, 'sum', 'Betrag'))[0].value);
        expect(round2(sum), `${label} SUM(Betrag)`).toBe(total);
        const overallMedian = Number((await aggregate(data, 'median', 'Preis'))[0].value);
        expect(overallMedian, `${label} median(Preis)`).toBeCloseTo(preisMedian, 6);
        const byDescription = await aggregate(data, 'median', 'Preis', 'Beschreibung');
        expect(byDescription.length, label).toBeGreaterThan(1);
        for (const row of byDescription) {
            const expected = median(reference.filter(record => record.beschreibung === row.Beschreibung).map(record => record.preis));
            expect(Number(row.value), `${label} median(Preis) for ${String(row.Beschreibung)}`).toBeCloseTo(expected, 6);
            // The corrupted flow produced medians in the tens of thousands.
            expect(Number(row.value)).toBeLessThan(450);
        }
    }
};

describe('European number flow: import to DuckDB aggregate', () => {
    const truth = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'truth.json'), 'utf8')) as { f4: { rows: number; total: number } };
    const fixtureText = readFileSync(path.join(FIXTURE_DIR, 'w4_european_semicolon.csv'), 'utf8');

    it('sums the w4 fixture to truth.f4.total and keeps the Preis medians near the true values', async () => {
        const reference = readReference(fixtureText);
        expect(reference).toHaveLength(truth.f4.rows);
        expect(round2(reference.reduce((sum, record) => sum + record.betrag, 0))).toBe(truth.f4.total);
        await expectFlowMatchesReference(fixtureText, 'w4_european_semicolon.csv', reference, truth.f4.total, ';');
    }, 120_000);

    const hasPython = (() => {
        try { execFileSync('python3', ['-I', '--version'], { stdio: 'ignore' }); return true; } catch { return false; }
    })();

    it.skipIf(!hasPython)('sums the full-size SCALE=1 w4 file to its ground truth', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'weird-reports-'));
        execFileSync('python3', ['-I', path.join(FIXTURE_DIR, 'generate-weird-reports.py'), dir], {
            env: { ...process.env, SCALE: '1' }, stdio: 'ignore',
        });
        const fullText = readFileSync(path.join(dir, 'w4_european_semicolon.csv'), 'utf8');
        const fullTruth = JSON.parse(readFileSync(path.join(dir, 'truth.json'), 'utf8')) as { f4: { rows: number; total: number } };
        const reference = readReference(fullText);
        expect(reference).toHaveLength(fullTruth.f4.rows);
        expect(fullTruth.f4.rows).toBeGreaterThan(1000);
        await expectFlowMatchesReference(fullText, 'w4_european_semicolon.csv', reference, fullTruth.f4.total, ';');
    }, 240_000);

    it('totals per description through the diagnostic template with the same numbers', async () => {
        const reference = readReference(fixtureText);
        const { canonical } = runProductionFlow(fixtureText, 'w4_european_semicolon.csv', ';');
        // Rows left as European text (no cleaning step ran) must also total correctly.
        const imported = (() => {
            const { rawRows, detection } = parseCsvTextWithDetection(fixtureText);
            return buildCsvDataFromIntakeIr(buildReportIntakeIr('w4_european_semicolon.csv', rawRows, detection));
        })();
        for (const data of [canonical, imported]) {
            await aggregate(data, 'sum', 'Betrag'); // primes session_clean_dataset
            const template = resolveDiagnosticTemplate('description_totals')!;
            const compiled = template.toCompiledQuery!(
                { descriptionColumn: 'Beschreibung', valueColumn: 'Betrag', limit: 50 },
                { tableName: 'session_clean_dataset', allowedColumns: Object.keys(data.data[0]), columnProfiles: [] },
            );
            const rows = tableToRows(duck.conn.query(compiled.sql));
            expect(rows.length).toBeGreaterThan(1);
            for (const row of rows) {
                const expected = reference.filter(record => record.beschreibung === row.description).reduce((sum, record) => sum + record.betrag, 0);
                expect(round2(Number(row.total))).toBe(round2(expected));
            }
        }
    }, 120_000);

    it('still sums a US-format control file (comma delimiter, 1,234.56) to the same total', async () => {
        const reference = readReference(fixtureText);
        const usFormat = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const usText = Papa.unparse({
            fields: ['Kunde', 'Beschreibung', 'Menge', 'Preis', 'Betrag'],
            data: reference.map(record => [record.kunde, record.beschreibung, String(record.menge), usFormat(record.preis), usFormat(record.betrag)]),
        });
        expect(usText).toContain('"1,');
        const { cleaned, canonical } = runProductionFlow(usText, 'us_control.csv', ',');
        for (const data of [cleaned, canonical]) {
            expect(round2(Number((await aggregate(data, 'sum', 'Betrag'))[0].value))).toBe(truth.f4.total);
            expect(Number((await aggregate(data, 'median', 'Preis'))[0].value))
                .toBeCloseTo(median(reference.map(record => record.preis)), 6);
        }
    }, 120_000);
});
