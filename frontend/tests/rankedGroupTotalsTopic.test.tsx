// The topic pipeline (evidence query, value gate, companion total, card) on the
// real melted visitor-arrivals table. The AI planner is scripted with the three
// shapes a plan can carry its detail-row filter in. A filter written as the
// plan's `preFilter` runs as part of the WHERE clause, so it must protect the
// sum exactly like one in `query.where`: the card stays a verified chart and its
// total over all 52 leaf markets (244,299,398) is measured. Before, the series
// guard and the harness floor read only `query.where`, saw a SUM over parents
// and children, downgraded the card to a table and suppressed the total.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CsvData, EvidenceHarnessContext, SqlEvidenceQueryPlan } from '../types';
import { initialAppState, useAppStore } from '../store/useAppStore';
import { profileData } from '../services/data/dataProfiler';
import { tableToRows } from '../services/workers/duckDbRows';

const duck = vi.hoisted(() => ({ db: null as any, conn: null as any }));
const planned = vi.hoisted(() => ({ plan: null as any }));

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

vi.mock('../services/agent/planning/planGenerator', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    generateEvidenceQueryPlanStepped: async () => { throw new Error('stepped planner unavailable'); },
    generateEvidenceQueryPlanWithRetry: async () => planned.plan,
}));

// jsdom replaces the global URL, so paths are resolved from the package root.
const require = createRequire(path.resolve(process.cwd(), 'package.json'));
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const wasmBase = `${path.resolve(process.cwd(), 'node_modules/@duckdb/duckdb-wasm/dist')}/`;

let visitors: CsvData;
let buildMeta: unknown;

beforeAll(async () => {
    duck.db = await duckdb.createDuckDB(
        { mvp: { mainModule: `${wasmBase}duckdb-mvp.wasm` }, eh: { mainModule: `${wasmBase}duckdb-eh.wasm` } },
        new duckdb.VoidLogger(),
        duckdb.NODE_RUNTIME,
    );
    await duck.db.instantiate();
    duck.db.open({ path: ':memory:', maximumThreads: 1 });
    duck.conn = duck.db.connect();

    const { processCsvWithIntakeIr } = await import('../services/data/csvParser');
    const { buildCsvDataFromIntakeIr } = await import('../services/data/reportCsvIntake');
    const { resolveReportStructureArtifactsWithProposal } = await import('../services/agent/orchestration/reportStructureOrchestrator');
    const { createTestSettings } = await import('./testSettings');
    const fileName = 'sg-visitor-arrivals.csv';
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
    visitors = artifacts.canonicalCsvData!;
    buildMeta = artifacts.canonicalBuildMeta;
}, 60_000);
afterAll(() => duck.conn?.close());

const FACT = { column: 'RowClass', operator: 'eq' as const, value: 'fact' };
const ranked = (shape: 'where' | 'preFilter' | 'aggregate'): SqlEvidenceQueryPlan => ({
    title: 'Total Arrivals by Data Series',
    queryMode: 'aggregate',
    intentSummary: 'Rank the leaf markets by arrivals.',
    preferredResultShape: 'ranked_aggregate',
    ...(shape === 'preFilter' ? { preFilter: [FACT] } : {}),
    query: {
        select: ['DataSeries', 'total_value'],
        ...(shape === 'where' ? { where: { predicates: [FACT] } } : {}),
        groupBy: ['DataSeries'],
        aggregates: [{ function: 'sum', column: 'Value', as: 'total_value', ...(shape === 'aggregate' ? { where: { predicates: [FACT] } } : {}) }],
        orderBy: [{ column: 'total_value', direction: 'desc' }],
        limit: 20,
    },
});

// What the investigation harness reports for a hierarchical report: detail rows only.
const hierarchicalHarness: EvidenceHarnessContext = {
    preferGroupBy: ['DataSeries'],
    blockGroupBy: [],
    reportShapeClass: 'hierarchical_statement',
    detailRowPolicy: 'exclude_non_detail_rows',
    hierarchyMode: 'preserve',
    widePivotMode: 'none',
    signalConfidence: 'high',
    excludeFromAggregation: ['Total International Visitor Arrivals By Place Of Residence'],
    hierarchyColumn: 'ParentSeries',
    parentDescriptions: ['Southeast Asia'],
    duplicateDescriptions: [],
    detailRowColumn: 'RowClass',
    detailRowValue: 'fact',
    detailRowFilter: { column: 'RowClass', value: 'fact' },
};

const runTopic = async (evidencePlan: SqlEvidenceQueryPlan, harnessContext?: EvidenceHarnessContext) => {
    const profiles = profileData(visitors.data).profiles;
    useAppStore.setState({
        ...initialAppState,
        settings: { ...initialAppState.settings, language: 'English', enableVisualEvaluation: false },
        columnProfiles: profiles,
        csvData: visitors,
        canonicalCsvData: visitors,
        canonicalBuildMeta: buildMeta as never,
    });
    planned.plan = evidencePlan;
    const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');
    const result = await processSingleTopic(
        'Total Arrivals by Data Series', visitors, useAppStore as never, null as never, [],
        harnessContext ? { harnessContext } as never : undefined,
    );
    return { result: result as Record<string, any>, card: useAppStore.getState().analysisCards[0] };
};

describe('ranked leaf-market card through the topic pipeline (real melted visitor data)', () => {
    it.each([
        ['the WHERE clause', 'where'],
        ['the plan pre-filter', 'preFilter'],
        ['the aggregate filter', 'aggregate'],
    ] as const)('stays a verified chart with the true total when RowClass = fact is in %s', async (_label, shape) => {
        const { result, card } = await runTopic(ranked(shape));

        expect(result).toMatchObject({ accepted: true, valueDecision: 'pass', valueReasonCodes: [] });
        expect(card.evidenceValueGate?.decision).toBe('pass');
        expect(card.provenance?.evidenceStatus).toBe('verified');
        expect(card.aggregatedData).toHaveLength(20);
        expect(card.groupCoverage).toMatchObject({ status: 'partial', overallTotal: 244_299_398 });
    }, 120_000);

    it('keeps the plan pre-filter a valid detail-row filter under a hierarchical-report harness', async () => {
        const { result, card } = await runTopic(ranked('preFilter'), hierarchicalHarness);

        expect(result.valueReasonCodes).not.toContain('missing_detail_row_filter');
        expect(result.valueReasonCodes).not.toContain('series_hierarchy_mix');
        expect(result.valueDecision).toBe('pass');
        expect(card.groupCoverage).toEqual({ status: 'partial', groupCount: 52, overallTotal: 244_299_398 });
    }, 120_000);

    it('still downgrades a sum across parents and children with no detail-row filter anywhere, and does not total it', async () => {
        const unfiltered = ranked('where');
        delete unfiltered.query.where;
        const { result, card } = await runTopic(unfiltered);

        expect(result.valueDecision).toBe('table_only');
        expect(result.valueReasonCodes).toContain('series_hierarchy_mix');
        expect(card.groupCoverage).toMatchObject({ status: 'partial', overallTotal: null });
    }, 120_000);
});
