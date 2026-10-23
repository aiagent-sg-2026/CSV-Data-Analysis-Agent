// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCleaningProgram, AiCleaningProgramResult, CsvData, SqlEvidenceQueryPlan } from '../types';

/**
 * End-to-end totals for the indented hierarchy report (w2): intake, canonical
 * table, autonomous cleaning (with an AI that is unavailable or wrong), AI row
 * annotations (wrong), the default analysis view, an in-process DuckDB and the
 * real evidence query. Detail-row sums must match the printed report exactly,
 * per region and per country. Only the model calls and the card renderer are
 * replaced.
 */

const hoisted = vi.hoisted(() => ({
    presentationMock: vi.fn(),
    cleaningGenerator: vi.fn(),
    duck: { db: null as any, conn: null as any },
}));
const { presentationMock, cleaningGenerator, duck } = hoisted;

vi.mock('../services/workers/duckDbWorkerClient', async () => {
    const { tableToRows } = await import('../services/workers/duckDbRows');
    return {
        duckDbWorkerClient: {
            initDuckDb: async () => ({ initialized: true }),
            loadCleanDataset: async (payload: { csvText: string; csvFileName: string; loadVersion: string; tableName: string }) => {
                const table = `"${payload.tableName.replace(/"/g, '""')}"`;
                await duck.db.registerFileText(payload.csvFileName, payload.csvText);
                duck.conn.query(`DROP TABLE IF EXISTS ${table}`);
                duck.conn.query(`CREATE TABLE ${table} AS SELECT * FROM read_csv_auto('${payload.csvFileName.replace(/'/g, "''")}', header=true, all_varchar=true)`);
                return { loaded: true, tableName: payload.tableName, loadVersion: payload.loadVersion };
            },
            executeCompiledQuery: async (payload: { sql: string; countSql: string; selectedColumns: string[]; appliedOrderBy: unknown[]; appliedLimit: number }) => {
                const rows = tableToRows(duck.conn.query(payload.sql));
                const total = Number(tableToRows(duck.conn.query(payload.countSql))[0]?.total ?? rows.length);
                return { rows, totalMatchedRows: total, returnedRows: rows.length, truncated: total > rows.length, selectedColumns: payload.selectedColumns, appliedOrderBy: payload.appliedOrderBy, appliedLimit: payload.appliedLimit, durationMs: 1 };
            },
            executeRawQuery: async () => { throw new Error('not used'); },
            disposeDuckDbSession: async () => undefined,
        },
    };
});
vi.mock('../services/ai/cleaningProgramGenerator', () => ({ generateAiCleaningProgram: cleaningGenerator }));
vi.mock('../services/duckdb/storeSessionSync', () => ({ ensureDuckDbSessionSync: vi.fn(async () => undefined) }));
vi.mock('../services/agent/execution/sqlPrecheck', () => ({ runSqlPrecheck: vi.fn(async () => ({ status: 'passed', summary: '' })) }));
vi.mock('../services/agent/execution/sqlCardExecutor', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    executePresentationPlanAndCreateCard: presentationMock,
}));
vi.mock('../services/vectorStore', () => ({ vectorStore: { searchIfReady: vi.fn().mockResolvedValue([]) } }));
vi.mock('../services/ai/streamGenerateText', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    streamGenerateText: vi.fn().mockRejectedValue(new Error('no AI')),
}));

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const wasmBase = fileURLToPath(new URL('../node_modules/@duckdb/duckdb-wasm/dist/', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./fixtures/weird-reports/', import.meta.url));

interface PrintedTruth {
    leafRows: number;
    grandTotal: number;
    byRegion: Map<string, number>;
    byCountry: Map<string, { rows: number; total: number }>;
}

/** Reads the printed indentation hierarchy independently of the app. */
const readPrintedTruth = (text: string): PrintedTruth => {
    const truth: PrintedTruth = { leafRows: 0, grandTotal: 0, byRegion: new Map(), byCountry: new Map() };
    let region = '';
    let country = '';
    for (const line of text.split(/\r?\n/).slice(1)) {
        if (!line.trim()) continue;
        const indent = line.length - line.trimStart().length;
        const cells = line.split(',');
        const label = cells[0]!.trim();
        const total = Number(cells[cells.length - 1]);
        if (indent === 0) { region = label; continue; }
        if (indent === 4) { country = label; continue; }
        truth.leafRows += 1;
        truth.grandTotal += total;
        truth.byRegion.set(region, (truth.byRegion.get(region) ?? 0) + total);
        // The app names a country level by its full path, so printed truth uses the same key.
        const key = `${region} > ${country}`;
        const entry = truth.byCountry.get(key) ?? { rows: 0, total: 0 };
        entry.rows += 1;
        entry.total += total;
        truth.byCountry.set(key, entry);
    }
    return truth;
};

let scratchDir = '';
// The full-size file is generated on the fly by the fixture generator, which needs python3.
const hasPython = (() => {
    try {
        execFileSync('python3', ['-I', '-c', 'pass']);
        return true;
    } catch {
        return false;
    }
})();
const datasets: Array<{ name: string; load: () => string }> = [
    { name: 'committed fixture', load: () => join(fixtureDir, 'w2_hierarchy_monthly.csv') },
    ...(!hasPython ? [] : [{
        name: 'full-size report (SCALE=1)',
        load: () => {
            scratchDir = mkdtempSync(join(tmpdir(), 'weird-reports-full-'));
            execFileSync('python3', ['-I', join(fixtureDir, 'generate-weird-reports.py'), scratchDir], { env: { ...process.env, SCALE: '1' } });
            return join(scratchDir, 'w2_hierarchy_monthly.csv');
        },
    }]),
];

/** Cleaning program that deletes rows by index, the way a model guessing indexes would. */
const buildWrongIndexProgram = (rowCount: number): AiCleaningProgramResult => {
    const indices = Array.from({ length: Math.floor(rowCount / 32) }, (_, slot) => 3 + slot * 32);
    const program: AiCleaningProgram = {
        programId: 'wrong-index-program',
        explanation: 'Remove residual summary-like rows.',
        source: 'llm_generated',
        outputColumns: [],
        steps: [{
            id: 'step-1',
            title: 'Drop residual rows',
            operations: [{ id: 'drop-guessed', type: 'drop_rows_by_index', reason: 'Residual summary-like rows.', indices }],
        }],
    } as unknown as AiCleaningProgram;
    const candidate = {
        strategyId: 'strategy-agent_primary',
        source: 'agent_primary' as const,
        program,
        plan: { explanation: program.explanation, operations: program.steps.flatMap(step => step.operations), outputColumns: [], planStatus: 'operations' as const, consistencyIssues: [] },
        intentSummary: program.explanation,
        requires: [],
        priority: 1,
    };
    return { primary: candidate, candidates: [candidate] } as unknown as AiCleaningProgramResult;
};

beforeAll(async () => {
    duck.db = await duckdb.createDuckDB(
        { mvp: { mainModule: `${wasmBase}duckdb-mvp.wasm` }, eh: { mainModule: `${wasmBase}duckdb-eh.wasm` } },
        new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await duck.db.instantiate();
    duck.db.open({ path: ':memory:', maximumThreads: 1 });
    duck.conn = duck.db.connect();
}, 60_000);
afterAll(() => {
    duck.conn?.close();
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});
beforeEach(() => {
    cleaningGenerator.mockReset();
    presentationMock.mockReset();
});

const runPipeline = async (text: string, aiProgram: 'unavailable' | 'wrong_indexes') => {
    const { processCsvWithIntakeIr } = await import('../services/data/csvParser');
    const { buildCsvDataFromIntakeIr } = await import('../services/data/reportCsvIntake');
    const { resolveReportStructureArtifactsWithProposal } = await import('../services/agent/orchestration/reportStructureOrchestrator');
    const { orchestrateAutonomousAiCleaning } = await import('../services/agent/orchestration/autonomousCleaningPipeline');
    const { profileData } = await import('../services/data/dataProfiler');
    const { createTestSettings } = await import('./testSettings');

    const file = { name: 'w2.csv', size: text.length, text: async () => text } as unknown as File;
    const intake = await processCsvWithIntakeIr(file);
    const rawCsvData = buildCsvDataFromIntakeIr(intake.intakeIr);
    const artifacts = await resolveReportStructureArtifactsWithProposal({
        rawCsvData, csvData: intake.csvData, rawIntakeIr: intake.intakeIr, cleaningRun: null,
        dataPreparationPlan: { explanation: '', operations: [], outputColumns: [], planStatus: 'schema_only', consistencyIssues: [] },
        columnProfiles: profileData(intake.csvData.data).profiles, settings: createTestSettings(),
    });
    const canonical = artifacts.canonicalCsvData as CsvData;
    const state: any = {
        sessionId: 's', currentDatasetId: 'd', settings: { ...createTestSettings(), language: 'English' },
        csvData: canonical, rawCsvData, canonicalCsvData: canonical, canonicalBuildMeta: artifacts.canonicalBuildMeta,
        rawIntakeIr: intake.intakeIr, reportStructureResolution: artifacts.reportStructureResolution ?? null,
        columnProfiles: profileData(canonical.data).profiles, dataPreparationPlan: null, workspaceFiles: {}, chatHistory: [],
        cleaningRun: null, datasetSemanticSnapshot: null, semanticDatasetVersion: null,
        ensureDatasetSemanticSnapshot: vi.fn(async () => null), addProgress: vi.fn(), recordAgentEvent: vi.fn(),
        logTelemetryEvent: vi.fn(),
    };
    const store: any = { getState: () => state, setState: (partial: any) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial) };
    if (aiProgram === 'unavailable') {
        cleaningGenerator.mockRejectedValue(new Error('AI unavailable'));
    } else {
        cleaningGenerator.mockResolvedValue(buildWrongIndexProgram(canonical.data.length));
    }
    await orchestrateAutonomousAiCleaning(store);
    return { state, store, canonicalBuildMeta: artifacts.canonicalBuildMeta };
};

/** Row annotations from a model that calls many detail rows notes or subtotals. */
const buildHostileAnnotations = (data: CsvData) => ({
    rowAnnotations: data.data
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(({ row }) => row.RowClass === 'fact')
        .filter(({ rowIndex }) => rowIndex % 29 === 5)
        .map(({ rowIndex }) => ({
            rowIndex,
            rowRole: rowIndex % 2 === 0 ? 'note' : 'subtotal',
            confidence: 0.95,
            reason: 'Looks like a comment line.',
        })),
});

describe.each(datasets)('hierarchy report totals through DuckDB: $name', dataset => {
    let text = '';
    let truth: PrintedTruth;
    beforeAll(() => {
        text = readFileSync(dataset.load(), 'utf8');
        truth = readPrintedTruth(text);
    }, 120_000);

    it.each([
        ['AI cleaning unavailable', 'unavailable'],
        ['AI cleaning program deletes rows by guessed index', 'wrong_indexes'],
    ] as const)('keeps every detail row when %s and the row annotations are wrong', async (_label, aiProgram) => {
        const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');
        const { sanitizeDatasetSemanticSnapshot, buildSemanticDatasetVersion } = await import('../services/agent/datasetSemantics');
        const { resolveDatasetBindingTarget } = await import('../services/agent/datasetBinding');
        const { primeDuckDbDataset } = await import('../services/duckdb/queryEngine');
        const { profileData } = await import('../services/data/dataProfiler');

        const { state, store, canonicalBuildMeta } = await runPipeline(text, aiProgram);
        const cleaned: CsvData = state.csvData;
        // Cleaning completes with the deterministic program: only the report's subtotal rows are
        // removed. A faulty model program must be replaced, not left to stall the run.
        expect(state.cleaningRun?.status).toBe('completed');
        expect(cleaned.data).toHaveLength(truth.leafRows);
        const profiles = profileData(cleaned.data).profiles;
        const version = buildSemanticDatasetVersion(cleaned);
        const snapshot = sanitizeDatasetSemanticSnapshot(buildHostileAnnotations(cleaned) as never, cleaned, 'm', version, profiles as never, null, null);
        Object.assign(state, { datasetSemanticSnapshot: snapshot, semanticDatasetVersion: version, columnProfiles: profiles, canonicalBuildMeta });

        // The data the SQL engine receives is the default analysis view, not the cleaned table itself.
        const target = resolveDatasetBindingTarget({ mode: 'analysis', csvData: cleaned, snapshot, semanticDatasetVersion: version })!;
        const viewFacts = target.dataset.data.filter(row => row.RowClass === 'fact');
        expect(viewFacts).toHaveLength(truth.leafRows);

        await primeDuckDbDataset(target.dataset);
        const perCountry = duck.conn.query(
            `SELECT Region, Country, COUNT(*) AS n, SUM(TRY_CAST(Total AS DOUBLE)) AS s FROM session_clean_dataset WHERE RowClass = 'fact' GROUP BY Region, Country`,
        ).toArray().map((row: any) => row.toJSON());
        expect(perCountry).toHaveLength(truth.byCountry.size);
        for (const row of perCountry) {
            // The app disambiguates repeated country names with a path ("ASEAN > Malaysia"); unique names stay plain.
            const label = `${row.Region} > ${String(row.Country).split(" > ").pop()}`;
            const expected = truth.byCountry.get(label);
            expect(expected, label).toBeDefined();
            expect(Number(row.n), `${label} rows`).toBe(expected!.rows);
            expect(Number(row.s), `${label} total`).toBe(expected!.total);
        }

        // The same numbers through the real planner and evidence query.
        let regionRows: Array<Record<string, unknown>> = [];
        presentationMock.mockImplementation(async (plan: SqlEvidenceQueryPlan, _p: unknown, _s: unknown, _sum: unknown, execution: any) => {
            regionRows = execution.result.rows;
            return { card: { id: 'c' }, presentationPlan: { title: plan.title, presentationMode: 'table', bindings: {} }, evidenceSummary: {}, activeDataQuery: { result: { rows: [] } } };
        });
        const plan: SqlEvidenceQueryPlan = {
            title: 'Sum Total by Region', queryMode: 'aggregate', intentSummary: 'Sum Total by Region', preferredResultShape: 'ranked_aggregate',
            query: { select: ['Region', 'sum_total'], groupBy: ['Region'], aggregates: [{ function: 'sum', column: 'Total', as: 'sum_total' }], orderBy: [{ column: 'sum_total', direction: 'desc' }], limit: 10 },
        };
        Object.assign(state, {
            isChangingGoal: false, rawCsvData: cleaned, agentMemoryHistory: [], analysisCards: [], datasetBundle: null, reportContextResolution: null,
            settings: { provider: 'google', geminiApiKey: 'k', openAIApiKey: '', simpleModel: 'm', complexModel: 'm', language: 'English' },
        });
        await processSingleTopic('Sum Total by Region', cleaned, store, undefined as never, [], { preGeneratedPlan: plan });
        expect(regionRows).toHaveLength(truth.byRegion.size);
        for (const row of regionRows) {
            expect(Number(row.sum_total), `region ${String(row.Region)}`).toBe(truth.byRegion.get(String(row.Region)));
        }
        expect(regionRows.reduce((sum, row) => sum + Number(row.sum_total), 0)).toBe(truth.grandTotal);
    }, 180_000);
});
