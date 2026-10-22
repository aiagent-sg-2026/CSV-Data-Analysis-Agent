// @vitest-environment node
//
// Regression: during the Pi initial analysis of the HDB sample, data_describe
// and data_missing returned "DuckDB binding unavailable." while data_query and
// the Data Explorer worked. These tests run the diagnostic tools through the
// production Pi wiring (createPiAppTools -> handleAiAction -> executorAgent ->
// diagnosticDataActions -> queryEngine -> unifiedQueryExecutor). Only the
// DuckDB worker transport is replaced, by a fake that loads and queries a real
// in-process DuckDB the same way services/workers/duckDbWorker.ts does, so the
// statistics in the assertions are computed by DuckDB from the bound rows.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createPiAppTools } from '../services/agent/runtime/pi/piAppTools';
import { primeDuckDbDataset } from '../services/duckdb/queryEngine';
import { createDuckDbSessionStatusFromBinding } from '../services/duckdb/sessionStatus';
import { tableToRows } from '../services/workers/duckDbRows';
import { getCsvDatasetLoadVersion, getCsvDatasetVersion } from '../utils/datasetId';
import { createRuntimeTestStore } from './runtimeTestStore';

type Binding = { tableName: string; loadVersion: string };

const duck = vi.hoisted(() => ({
    db: null as any,
    conn: null as any,
    loaded: null as Binding | null,
    failLoad: false,
    loads: [] as Binding[],
    queries: [] as Binding[],
}));

vi.mock('../services/workers/duckDbWorkerClient', () => ({
    duckDbWorkerClient: {
        initDuckDb: async () => ({ initialized: true }),
        loadCleanDataset: async (payload: { csvText: string; csvFileName: string; loadVersion: string; tableName: string }) => {
            if (duck.failLoad) throw new Error('worker load failed');
            const table = `"${payload.tableName.replace(/"/g, '""')}"`;
            await duck.db.registerFileText(payload.csvFileName, payload.csvText);
            duck.conn.query(`DROP TABLE IF EXISTS ${table}`);
            // Same load statement as the production worker.
            duck.conn.query(`CREATE TABLE ${table} AS SELECT * FROM read_csv_auto('${payload.csvFileName.replace(/'/g, "''")}', header=true, all_varchar=true)`);
            duck.loaded = { tableName: payload.tableName, loadVersion: payload.loadVersion };
            duck.loads.push(duck.loaded);
            return { loaded: true, ...duck.loaded };
        },
        executeCompiledQuery: async (payload: { sql: string; expectedBinding?: Binding }) => {
            if (payload.expectedBinding) duck.queries.push(payload.expectedBinding);
            // The production worker refuses a query for a table it does not hold.
            if (!duck.loaded || payload.expectedBinding?.loadVersion !== duck.loaded.loadVersion
                || payload.expectedBinding?.tableName !== duck.loaded.tableName) {
                throw new Error('sql_binding_mismatch');
            }
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

const COLUMN_PROFILES = [
    { name: 'month', type: 'date' },
    { name: 'town', type: 'categorical' },
    { name: 'floor_area_sqm', type: 'numerical' },
    { name: 'resale_price', type: 'currency' },
];

const DETAIL_ROWS = [
    { month: '2024-01', town: 'ANG MO KIO', floor_area_sqm: 67, resale_price: 420000 },
    { month: '2024-01', town: 'BEDOK', floor_area_sqm: 92, resale_price: 515000 },
    { month: '2024-02', town: 'TAMPINES', floor_area_sqm: 104, resale_price: 610000 },
    { month: '2024-02', town: 'YISHUN', floor_area_sqm: 73, resale_price: 455000 },
    { month: '2024-03', town: 'BEDOK', floor_area_sqm: 88, resale_price: 498000 },
    { month: '2024-03', town: 'TAMPINES', floor_area_sqm: 95, resale_price: 560000 },
];
const DETAIL_MAX_PRICE = 610000;
const GRAND_TOTAL_PRICE = DETAIL_ROWS.reduce((sum, row) => sum + row.resale_price, 0);

// HDB-shaped rows. Each test uses its own file name so the engine's
// module-level binding cache starts cold for that dataset.
const buildHdbDataset = (fileName: string, withGrandTotal = false) => ({
    fileName,
    data: [
        ...DETAIL_ROWS.map(row => ({ ...row })),
        ...(withGrandTotal ? [{ month: '', town: 'Grand Total', floor_area_sqm: 519, resale_price: GRAND_TOTAL_PRICE }] : []),
    ],
});

type HdbDataset = ReturnType<typeof buildHdbDataset>;

const createPiStore = (dataset: HdbDataset) => {
    const store = createRuntimeTestStore({
        csvData: dataset,
        columnProfiles: COLUMN_PROFILES,
    } as never);
    store.setState({ canonicalCsvData: dataset, rawCsvData: dataset, workspaceFiles: {} } as never);
    return store;
};

// The semantic snapshot that analysis.researchQuestions creates via
// ensureDatasetSemanticSnapshot after dataset.bindQueryEngine. It hides the
// high-confidence grand-total row from the default analysis view.
const applySemanticSnapshotHidingGrandTotal = (store: ReturnType<typeof createPiStore>, dataset: HdbDataset) => {
    const version = getCsvDatasetVersion(dataset as never);
    const totalIndex = dataset.data.length - 1;
    store.setState({
        datasetSemanticSnapshot: {
            sourceDatasetVersion: version,
            columnAnnotations: [],
            rowAnnotations: [],
            recommendedAnalysisView: {
                mode: 'soft_exclude',
                includedRowIndices: dataset.data.map((_, index) => index).filter(index => index !== totalIndex),
                excludedRowIndices: [totalIndex],
                includedRowCount: totalIndex,
                excludedRowCount: 1,
                reason: 'High-confidence non-detail rows are hidden from the default analysis view.',
            },
        },
        semanticDatasetVersion: version,
        semanticStatus: 'ready',
    } as never);
};

const findTool = (store: ReturnType<typeof createPiStore>, name: string): AgentTool => {
    const tool = createPiAppTools(store as never, null, { includeSkills: false }).find(entry => entry.name === name);
    if (!tool) throw new Error(`Pi tool ${name} is not registered.`);
    return tool;
};

type ToolFeedback = {
    status: string;
    message: string;
    retryHint?: string;
    artifacts?: { activeDataQuery?: { result?: { rows: Array<Record<string, unknown>> } } };
};

// Pi tools return success feedback as content and throw error feedback, so the
// model sees both; normalise them to the same JSON shape for assertions.
const runTool = async (store: ReturnType<typeof createPiStore>, name: string, args: Record<string, unknown>): Promise<ToolFeedback> => {
    try {
        const result = await findTool(store, name).execute(`call-${name}`, args, undefined as never);
        return JSON.parse((result.content[0] as { text: string }).text) as ToolFeedback;
    } catch (error) {
        return JSON.parse(error instanceof Error ? error.message : String(error)) as ToolFeedback;
    }
};

const resultRows = (feedback: ToolFeedback) => feedback.artifacts?.activeDataQuery?.result?.rows ?? [];

describe('Pi diagnostic data tools DuckDB binding', () => {
    beforeEach(() => {
        duck.failLoad = false;
        duck.loads = [];
        duck.queries = [];
    });

    it('computes diagnostics on the detail rows after researchQuestions hides a grand-total row (initial analysis)', async () => {
        const dataset = buildHdbDataset('hdb-initial.csv', true);
        const store = createPiStore(dataset);
        // dataset.bindQueryEngine: the prepared dataset is bound and the store records it.
        const binding = await primeDuckDbDataset(dataset as never);
        store.setState({ duckDbSessionStatus: createDuckDbSessionStatusFromBinding(binding) } as never);
        // analysis.researchQuestions: the semantic snapshot becomes current afterwards.
        applySemanticSnapshotHidingGrandTotal(store, dataset);

        const describe = await runTool(store, 'data_describe', { columns: ['resale_price'] });
        const missing = await runTool(store, 'data_missing', { columns: ['town'] });
        const outliers = await runTool(store, 'data_outliers', { column: 'resale_price' });
        const valueCounts = await runTool(store, 'data_value_counts', { column: 'town', limit: 20 });

        for (const feedback of [describe, missing, outliers, valueCounts]) {
            expect(feedback.message).not.toContain('DuckDB binding unavailable');
            expect(feedback.status).toBe('success');
        }
        const priceStats = resultRows(describe).find(row => row.column_name === 'resale_price');
        expect(Number(priceStats?.max_val)).toBe(DETAIL_MAX_PRICE);
        expect(Number(priceStats?.cnt)).toBe(DETAIL_ROWS.length);
        expect(Number(resultRows(missing)[0]?.total_rows)).toBe(DETAIL_ROWS.length);
        expect(resultRows(outliers).map(row => Number(row.__outlier_value))).not.toContain(GRAND_TOTAL_PRICE);
        expect(resultRows(valueCounts).map(row => row.town)).not.toContain('Grand Total');
        // Every query ran against the bound semantic view, never the full table.
        expect(duck.queries.length).toBeGreaterThanOrEqual(4);
        expect(new Set(duck.queries.map(query => query.loadVersion)).size).toBe(1);
        expect(duck.queries[0].loadVersion).not.toBe(getCsvDatasetLoadVersion(dataset as never));
    });

    it('binds the dataset on demand when no session binding was recorded yet (follow-up chat)', async () => {
        const dataset = buildHdbDataset('hdb-follow-up.csv');
        const store = createPiStore(dataset);

        const valueCounts = await runTool(store, 'data_value_counts', { column: 'town', limit: 5 });
        const outliers = await runTool(store, 'data_outliers', { column: 'resale_price' });

        expect(valueCounts.status).toBe('success');
        expect(outliers.status).toBe('success');
        const expected = { tableName: 'session_clean_dataset', loadVersion: getCsvDatasetLoadVersion(dataset as never) };
        expect(duck.loads).toEqual([expected]);
        expect(duck.queries.every(query => query.loadVersion === expected.loadVersion)).toBe(true);
        expect(resultRows(valueCounts).find(row => row.town === 'BEDOK')).toMatchObject({ count: 2 });
    });

    it('returns an actionable error that names data_query when DuckDB cannot bind the dataset', async () => {
        const dataset = buildHdbDataset('hdb-bind-failure.csv');
        const store = createPiStore(dataset);
        duck.failLoad = true;

        const describe = await runTool(store, 'data_describe', {});

        expect(describe.status).toBe('error');
        expect(describe.message).not.toBe('DuckDB binding unavailable.');
        expect(describe.retryHint).toContain('data_query');
        expect(duck.queries).toEqual([]);
    });
});
