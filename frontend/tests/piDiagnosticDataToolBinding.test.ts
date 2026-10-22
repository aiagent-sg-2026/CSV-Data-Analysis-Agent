// @vitest-environment node
//
// Regression: during the Pi initial analysis of the HDB sample, data_describe
// and data_missing returned "DuckDB binding unavailable." while data_query and
// the Data Explorer worked. These tests run the diagnostic tools through the
// production Pi wiring (createPiAppTools -> handleAiAction -> executorAgent ->
// diagnosticDataActions -> queryEngine -> unifiedQueryExecutor) and replace
// only the DuckDB worker transport.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createPiAppTools } from '../services/agent/runtime/pi/piAppTools';
import { primeDuckDbDataset } from '../services/duckdb/queryEngine';
import { createDuckDbSessionStatusFromBinding } from '../services/duckdb/sessionStatus';
import { duckDbWorkerClient } from '../services/workers/duckDbWorkerClient';
import { getCsvDatasetLoadVersion, getCsvDatasetVersion } from '../utils/datasetId';
import { createRuntimeTestStore } from './runtimeTestStore';

vi.mock('../services/workers/duckDbWorkerClient', () => ({
    duckDbWorkerClient: {
        initDuckDb: vi.fn(),
        loadCleanDataset: vi.fn(),
        executeCompiledQuery: vi.fn(),
        executeRawQuery: vi.fn(),
        disposeDuckDbSession: vi.fn(),
    },
}));

const worker = vi.mocked(duckDbWorkerClient);

const COLUMN_PROFILES = [
    { name: 'month', type: 'date' },
    { name: 'town', type: 'categorical' },
    { name: 'floor_area_sqm', type: 'numerical' },
    { name: 'resale_price', type: 'currency' },
];

// HDB-shaped rows; each test uses its own file name so the engine's
// module-level binding cache starts cold for that dataset.
const buildHdbDataset = (fileName: string) => ({
    fileName,
    data: [
        { month: '2024-01', town: 'ANG MO KIO', floor_area_sqm: 67, resale_price: 420000 },
        { month: '2024-01', town: 'BEDOK', floor_area_sqm: 92, resale_price: 515000 },
        { month: '2024-02', town: 'TAMPINES', floor_area_sqm: 104, resale_price: 610000 },
        { month: '2024-02', town: 'YISHUN', floor_area_sqm: 73, resale_price: 455000 },
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
// ensureDatasetSemanticSnapshot after dataset.bindQueryEngine. It hides one
// non-detail row, so the semantic default view is a strict subset.
const applySemanticSnapshotHidingRow = (store: ReturnType<typeof createPiStore>, dataset: HdbDataset) => {
    const version = getCsvDatasetVersion(dataset as never);
    store.setState({
        datasetSemanticSnapshot: {
            sourceDatasetVersion: version,
            columnAnnotations: [],
            rowAnnotations: [],
            recommendedAnalysisView: {
                mode: 'soft_exclude',
                includedRowIndices: [0, 1, 2],
                excludedRowIndices: [3],
                includedRowCount: 3,
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

type ToolFeedback = { status: string; message: string; retryHint?: string };

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

const expectedBinding = (dataset: HdbDataset) => ({
    tableName: 'session_clean_dataset',
    loadVersion: getCsvDatasetLoadVersion(dataset as never),
});

describe('Pi diagnostic data tools DuckDB binding', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        worker.initDuckDb.mockResolvedValue({ initialized: true } as never);
        worker.loadCleanDataset.mockResolvedValue({ loaded: true } as never);
        worker.executeCompiledQuery.mockResolvedValue({
            rows: [{ column: 'resale_price', count: 4 }],
            totalMatchedRows: 1,
        } as never);
    });

    it('runs data_describe and data_missing after researchQuestions changes the semantic view (initial analysis)', async () => {
        const dataset = buildHdbDataset('hdb-initial.csv');
        const store = createPiStore(dataset);
        // dataset.bindQueryEngine: the prepared dataset is bound and the store records it.
        const binding = await primeDuckDbDataset(dataset as never);
        store.setState({ duckDbSessionStatus: { ...createDuckDbSessionStatusFromBinding(binding), status: 'ready' } } as never);
        // analysis.researchQuestions: semantic snapshot becomes current afterwards.
        applySemanticSnapshotHidingRow(store, dataset);

        const describe = await runTool(store, 'data_describe', { columns: ['floor_area_sqm', 'resale_price'] });
        const missing = await runTool(store, 'data_missing', {});

        expect(describe.message).not.toContain('DuckDB binding unavailable');
        expect(missing.message).not.toContain('DuckDB binding unavailable');
        expect(describe.status).toBe('success');
        expect(missing.status).toBe('success');
        expect(worker.executeCompiledQuery).toHaveBeenCalledTimes(2);
        for (const [request] of worker.executeCompiledQuery.mock.calls) {
            expect((request as { expectedBinding: unknown }).expectedBinding).toEqual(expectedBinding(dataset));
        }
        // The already-bound table is reused instead of reloading the dataset.
        expect(worker.loadCleanDataset).toHaveBeenCalledTimes(1);
    });

    it('binds the dataset on demand when no session binding was recorded yet (follow-up chat)', async () => {
        const dataset = buildHdbDataset('hdb-follow-up.csv');
        const store = createPiStore(dataset);

        const valueCounts = await runTool(store, 'data_value_counts', { column: 'town', limit: 5 });
        const outliers = await runTool(store, 'data_outliers', { column: 'resale_price' });

        expect(valueCounts.status).toBe('success');
        expect(outliers.status).toBe('success');
        expect(worker.loadCleanDataset).toHaveBeenCalledTimes(1);
        expect(worker.loadCleanDataset.mock.calls[0][0]).toMatchObject(expectedBinding(dataset));
        for (const [request] of worker.executeCompiledQuery.mock.calls) {
            expect((request as { expectedBinding: unknown }).expectedBinding).toEqual(expectedBinding(dataset));
        }
    });

    it('returns an actionable error that names data_query when DuckDB cannot bind the dataset', async () => {
        const dataset = buildHdbDataset('hdb-bind-failure.csv');
        const store = createPiStore(dataset);
        worker.loadCleanDataset.mockRejectedValue(new Error('worker load failed'));

        const describe = await runTool(store, 'data_describe', {});

        expect(describe.status).toBe('error');
        expect(describe.message).not.toBe('DuckDB binding unavailable.');
        expect(describe.retryHint).toContain('data_query');
        expect(worker.executeCompiledQuery).not.toHaveBeenCalled();
    });
});
