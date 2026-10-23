// @vitest-environment node
//
// The ERP "outstanding orders" report (fixtures/weird-reports/w1) folds a two-row
// header into "Amount :: Price" and "Amount :: Balance Amount". Both share the
// layer label "Amount", yet one is a unit price (never summed) and the other the
// open value of an order line (the number an accounts-receivable clerk asks for).
// A real-AI run summed neither: it judged every "Balance" a point-in-time stock
// and led with an ordered quantity by date. These tests pin the leaf-based rules
// that keep the planner's inputs right, with a real in-process DuckDB for the totals.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ColumnProfile, CsvData, QueryPlan, ResearchPlanQuestion } from '../types';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr } from '../services/data/reportCsvIntake';
import { resolveReportStructureArtifactsWithProposal } from '../services/agent/orchestration/reportStructureOrchestrator';
import { createTestSettings } from './testSettings';
import { profileData } from '../services/data/dataProfiler';
import { buildColumnRegistry, isNonAdditiveMetric } from '../services/data/columnRegistry';
import { classifyMeasureLeaf, inferLeafAdditivity, isMoneyMeasureName } from '../services/data/columnNameLeaf';
import { buildDatasetContext } from '../services/agent/contextBuilder';
import { buildDeterministicTopics } from '../services/agent/planning/planGenerator';
import { checkQuestionMethods, prioritizeMoneyMeasure, validateColumnAdditivity } from '../services/agent/runtime/pi/researchPlan';
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

const FIXTURE_DIR = new URL('./fixtures/weird-reports/', import.meta.url);
const truth = JSON.parse(readFileSync(new URL('truth.json', FIXTURE_DIR), 'utf8')) as {
    f1: { rows: number; grand_total: number; per_customer: Record<string, number> };
};

const BALANCE_AMOUNT = 'Amount :: Balance Amount';
const PRICE = 'Amount :: Price';
const QTY_ORDERED = 'Quantity :: Ordered';
const QTY_BALANCE = 'Quantity :: Balance';

let csvData: CsvData;
let profiles: ColumnProfile[];

beforeAll(async () => {
    duck.db = await duckdb.createDuckDB(
        { mvp: { mainModule: `${wasmBase}duckdb-mvp.wasm` }, eh: { mainModule: `${wasmBase}duckdb-eh.wasm` } },
        new duckdb.VoidLogger(),
        duckdb.NODE_RUNTIME,
    );
    await duck.db.instantiate();
    duck.db.open({ path: ':memory:', maximumThreads: 1 });
    duck.conn = duck.db.connect();

    const text = readFileSync(new URL('w1_erp_outstanding.csv', FIXTURE_DIR), 'utf8');
    const file = { name: 'w1_erp_outstanding.csv', size: text.length, text: async () => text } as unknown as File;
    const intake = await processCsvWithIntakeIr(file);
    // The production path: the customer printed once per group is filled down in the canonical table the analysis reads.
    const artifacts = await resolveReportStructureArtifactsWithProposal({
        rawCsvData: buildCsvDataFromIntakeIr(intake.intakeIr),
        csvData: intake.csvData,
        rawIntakeIr: intake.intakeIr,
        cleaningRun: null,
        dataPreparationPlan: {
            explanation: 'Import keeps the source rows unchanged.',
            operations: [],
            outputColumns: [],
            planStatus: 'schema_only',
            consistencyIssues: [],
        },
        columnProfiles: profileData(intake.csvData.data).profiles,
        settings: createTestSettings(),
    });
    csvData = artifacts.canonicalCsvData ?? intake.csvData;
    profiles = profileData(csvData.data).profiles;
}, 60_000);
afterAll(() => duck.conn?.close());

const names = () => profiles.map(profile => profile.name);

describe('w1 outstanding-orders report: measures by the leaf of the folded header', () => {
    it('keeps the four numeric columns under their folded names', () => {
        const numeric = profiles.filter(profile => profile.type === 'numerical' || profile.type === 'currency').map(profile => profile.name);
        expect(numeric).toEqual(expect.arrayContaining([QTY_ORDERED, QTY_BALANCE, PRICE, BALANCE_AMOUNT]));
    });

    it('classifies each column by its leaf: balance amount and quantities add up, price does not', () => {
        expect(classifyMeasureLeaf(BALANCE_AMOUNT, names())).toBe('open_amount');
        expect(classifyMeasureLeaf(PRICE, names())).toBe('unit_price');
        expect(classifyMeasureLeaf(QTY_ORDERED, names())).toBe('line_quantity');
        expect(classifyMeasureLeaf(QTY_BALANCE, names())).toBe('line_quantity');

        expect(inferLeafAdditivity(BALANCE_AMOUNT, names())).toMatchObject({ kind: 'additive', nature: 'flow' });
        expect(inferLeafAdditivity(QTY_ORDERED, names())).toMatchObject({ kind: 'additive', nature: 'flow' });
        expect(inferLeafAdditivity(QTY_BALANCE, names())).toMatchObject({ kind: 'additive', nature: 'flow' });
        expect(inferLeafAdditivity(PRICE, names())).toMatchObject({ kind: 'non_additive', nature: 'unit_value' });
        // The row serial number labels the line; it is no measure.
        expect(inferLeafAdditivity('S/N', names())).toMatchObject({ kind: 'non_additive', nature: 'identifier' });
    });

    it('lets the registry offer a sum for the balance amount and never for the price', () => {
        const registry = buildColumnRegistry({ data: csvData, columnProfiles: profiles })!;
        const hint = (column: string) => registry.columns.find(entry => entry.physicalName === column)!.allowedUsages.aggregationHint;
        expect(hint(BALANCE_AMOUNT)).toBe('additive');
        expect(hint(QTY_ORDERED)).toBe('additive');
        expect(hint(QTY_BALANCE)).toBe('additive');
        expect(hint(PRICE)).toBe('non_additive');
        expect(isNonAdditiveMetric(BALANCE_AMOUNT, profiles.find(profile => profile.name === BALANCE_AMOUNT))).toBe(false);
    });

    it("corrects the model's stock judgement of the balances and its additive judgement of the price", () => {
        // What the real run did: every "Balance" read as a point-in-time stock, the price left unjudged or additive.
        const { accepted } = validateColumnAdditivity([
            { column: BALANCE_AMOUNT, kind: 'non_additive', nature: 'stock', rationale: 'Outstanding balance.' },
            { column: QTY_BALANCE, kind: 'non_additive', nature: 'stock', rationale: 'Outstanding quantity.' },
            { column: PRICE, kind: 'additive', nature: 'flow', rationale: 'Money.' },
        ], profiles);
        expect(accepted[BALANCE_AMOUNT]).toMatchObject({ kind: 'additive', nature: 'flow' });
        expect(accepted[QTY_BALANCE]).toMatchObject({ kind: 'additive', nature: 'flow' });
        expect(accepted[PRICE]).toMatchObject({ kind: 'non_additive', nature: 'unit_value' });
        // Unjudged columns get the same priors, so a sum question is not bounced for a missing classification.
        expect(accepted[QTY_ORDERED]).toMatchObject({ kind: 'additive' });

        const sumBalance: ResearchPlanQuestion = {
            title: 'Total Balance Amount by Customer', rationale: '', dimension: 'Customer', metric: BALANCE_AMOUNT, aggregation: 'sum', comparison: null, totalIntent: true,
        };
        const sumPrice: ResearchPlanQuestion = { ...sumBalance, title: 'Total price', metric: PRICE };
        const checked = checkQuestionMethods([sumBalance, sumPrice], accepted);
        expect(checked.questions.map(question => question.metric)).toEqual([BALANCE_AMOUNT]);
        expect(checked.rejected[0].reason).toContain('non_additive');
    });

    it('recognizes the balance amount as the money measure and the price and quantities as not', () => {
        expect(isMoneyMeasureName(BALANCE_AMOUNT, names())).toBe(true);
        expect(isMoneyMeasureName(PRICE, names())).toBe(false);
        expect(isMoneyMeasureName(QTY_ORDERED, names())).toBe(false);
        expect(isMoneyMeasureName(QTY_BALANCE, names())).toBe(false);
    });

    it('leads the deterministic fallback with the balance amount by customer', () => {
        const context = buildDatasetContext(csvData, profiles);
        const topics = buildDeterministicTopics(profiles, context);
        expect(topics[0]).toBe(`Total ${BALANCE_AMOUNT} by Customer`);
        topics.forEach(topic => {
            expect(topic).not.toContain('S/N');
            expect(topic).not.toContain(PRICE);
        });
        // The order number tells every order apart: never a ranking dimension.
        expect(topics.join('\n')).not.toContain('SO No.');
    });

    it('moves the money total by customer to the front of the model plan, ahead of a quantity by date', async () => {
        // The plan of the real run: quantity by date first, medians of the amounts.
        const modelPlan: ResearchPlanQuestion[] = [
            { title: 'Total Ordered Quantity by Order Date', rationale: '', dimension: 'Order :: Date', metric: QTY_ORDERED, aggregation: 'sum', comparison: 'trend over time' },
            { title: 'Median Balance Amount by Customer', rationale: '', dimension: 'Customer', metric: BALANCE_AMOUNT, aggregation: 'median', comparison: null },
            { title: 'Total Ordered Quantity by Customer', rationale: '', dimension: 'Customer', metric: QTY_ORDERED, aggregation: 'sum', comparison: null },
        ];
        const { accepted } = validateColumnAdditivity([], profiles);
        const planned = prioritizeMoneyMeasure(modelPlan, profiles, accepted, csvData.data.length);

        expect(planned[0]).toMatchObject({ dimension: 'Customer', metric: BALANCE_AMOUNT, aggregation: 'sum', totalIntent: true });
        expect(planned.slice(1)).toEqual(modelPlan);
        // Nothing sums the price, and the plan stays inside the question limit.
        expect(planned.some(question => question.metric === PRICE && question.aggregation === 'sum')).toBe(false);

        // The planned question, run in real DuckDB, reproduces the file's grand total over the order lines.
        const query: QueryPlan = {
            groupBy: [planned[0].dimension!],
            aggregates: [{ function: 'sum', column: planned[0].metric!, as: 'total' }],
            limit: 100,
        };
        const execution = await executeManagedDataQuery(csvData, query, Object.keys(csvData.data[0] ?? {}), { allowNativeFallback: false, bypassCache: true });
        expect(execution.engine).toBe('duckdb');
        const rows = execution.result.rows;
        expect(rows).toHaveLength(Object.keys(truth.f1.per_customer).length);
        const total = rows.reduce((sum, row) => sum + Number(row.total), 0);
        expect(Math.round(total * 100) / 100).toBe(truth.f1.grand_total);
        for (const row of rows) {
            expect(Math.round(Number(row.total) * 100) / 100).toBe(truth.f1.per_customer[String(row.Customer)]);
        }
    }, 60_000);

    it('keeps a model plan that already sums the money by a category, only moving it first', () => {
        const { accepted } = validateColumnAdditivity([], profiles);
        const own: ResearchPlanQuestion[] = [
            { title: 'Typical unit price by customer', rationale: '', dimension: 'Customer', metric: PRICE, aggregation: 'median', comparison: null },
            { title: 'Open value by customer', rationale: '', dimension: 'Customer', metric: BALANCE_AMOUNT, aggregation: 'sum', comparison: null, totalIntent: true },
        ];
        const planned = prioritizeMoneyMeasure(own, profiles, accepted, csvData.data.length);
        expect(planned.map(question => question.title)).toEqual(['Open value by customer', 'Typical unit price by customer']);
    });
});
