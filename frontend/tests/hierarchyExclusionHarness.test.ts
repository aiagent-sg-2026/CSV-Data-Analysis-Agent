// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsvData, SqlEvidenceQueryPlan } from '../types';

/**
 * The investigation harness must never put a label exclusion list on top of a hierarchy
 * table's RowClass contract. On the full-size indented report (w2) its "duplicate label"
 * statistic used to flag 700+ ordinary customers (any two totals within 1% count), and the
 * DirectiveInjector then added `"Region / Country / Customer" NOT IN [...]` to every query,
 * which silently removed about 3% of the detail rows from every total.
 *
 * Real in-process DuckDB, real harness, real steering, real directive injection and the real
 * evidence query. Only the model calls and the card renderer are replaced.
 */

const hoisted = vi.hoisted(() => ({
    presentationMock: vi.fn(),
    executedSql: [] as string[],
    duck: { db: null as any, conn: null as any },
}));
const { presentationMock, executedSql, duck } = hoisted;

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
                executedSql.push(payload.sql);
                const rows = tableToRows(duck.conn.query(payload.sql));
                const total = Number(tableToRows(duck.conn.query(payload.countSql))[0]?.total ?? rows.length);
                return { rows, totalMatchedRows: total, returnedRows: rows.length, truncated: total > rows.length, selectedColumns: payload.selectedColumns, appliedOrderBy: payload.appliedOrderBy, appliedLimit: payload.appliedLimit, durationMs: 1 };
            },
            executeRawQuery: async () => { throw new Error('not used'); },
            disposeDuckDbSession: async () => undefined,
        },
    };
});
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
const LABEL_COLUMN = 'Region / Country / Customer';

let scratchDir = '';
const hasPython = (() => {
    try {
        execFileSync('python3', ['-I', '-c', 'pass']);
        return true;
    } catch {
        return false;
    }
})();

/** Printed truth read independently of the app: region sums and the grand total. */
const readTruth = (text: string) => {
    const byRegion = new Map<string, number>();
    const byCountry = new Map<string, number>();
    let region = '';
    let country = '';
    let grand = 0;
    for (const line of text.split(/\r?\n/).slice(1)) {
        if (!line.trim()) continue;
        const indent = line.length - line.trimStart().length;
        const cells = line.split(',');
        const label = cells[0]!.trim();
        const total = Number(cells[cells.length - 1]);
        if (indent === 0) { region = label; continue; }
        if (indent === 4) { country = label; continue; }
        grand += total;
        byRegion.set(region, (byRegion.get(region) ?? 0) + total);
        byCountry.set(`${region} > ${country}`, (byCountry.get(`${region} > ${country}`) ?? 0) + total);
    }
    return { grand, byRegion, byCountry };
};

const datasets: Array<{ name: string; path: () => string }> = [
    { name: 'committed fixture', path: () => join(fixtureDir, 'w2_hierarchy_monthly.csv') },
    ...(!hasPython ? [] : [{
        name: 'full-size report (SCALE=1)',
        path: () => {
            scratchDir = mkdtempSync(join(tmpdir(), 'weird-reports-harness-'));
            execFileSync('python3', ['-I', join(fixtureDir, 'generate-weird-reports.py'), scratchDir], { env: { ...process.env, SCALE: '1' } });
            return join(scratchDir, 'w2_hierarchy_monthly.csv');
        },
    }]),
];

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
    presentationMock.mockReset();
    executedSql.length = 0;
});

describe.each(datasets)('investigation harness steering on the hierarchy report: $name', dataset => {
    let text = '';
    let canonical: CsvData;
    let meta: unknown;
    let profiles: any[];
    let truth: ReturnType<typeof readTruth>;

    beforeAll(async () => {
        text = readFileSync(dataset.path(), 'utf8');
        truth = readTruth(text);
        const { processCsvWithIntakeIr } = await import('../services/data/csvParser');
        const { buildCsvDataFromIntakeIr } = await import('../services/data/reportCsvIntake');
        const { resolveReportStructureArtifactsWithProposal } = await import('../services/agent/orchestration/reportStructureOrchestrator');
        const { profileData } = await import('../services/data/dataProfiler');
        const { createTestSettings } = await import('./testSettings');
        const file = { name: 'w2.csv', size: text.length, text: async () => text } as unknown as File;
        const intake = await processCsvWithIntakeIr(file);
        const artifacts = await resolveReportStructureArtifactsWithProposal({
            rawCsvData: buildCsvDataFromIntakeIr(intake.intakeIr), csvData: intake.csvData, rawIntakeIr: intake.intakeIr, cleaningRun: null,
            dataPreparationPlan: { explanation: '', operations: [], outputColumns: [], planStatus: 'schema_only', consistencyIssues: [] },
            columnProfiles: profileData(intake.csvData.data).profiles, settings: createTestSettings(),
        });
        canonical = artifacts.canonicalCsvData as CsvData;
        meta = artifacts.canonicalBuildMeta;
        profiles = profileData(canonical.data).profiles;
    }, 120_000);

    const planWithoutScope: SqlEvidenceQueryPlan = {
        title: 'Sum Total by Region', queryMode: 'aggregate', intentSummary: 'Sum Total by Region', preferredResultShape: 'ranked_aggregate',
        query: { select: ['Region', 'sum_total'], groupBy: ['Region'], aggregates: [{ function: 'sum', column: 'Total', as: 'sum_total' }], orderBy: [{ column: 'sum_total', direction: 'desc' }], limit: 10 },
    };
    // What a planner writes once the steering names the detail-row filter.
    const planWithScope: SqlEvidenceQueryPlan = {
        ...planWithoutScope,
        preFilter: [{ column: 'RowClass', operator: 'eq', value: 'fact' }],
        // A different limit keeps this query out of the engine's result cache, so its SQL is observed.
        query: { ...planWithoutScope.query, limit: 11, where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] } },
    };

    it.each([
        ['a plan without its own row scope', planWithoutScope, false],
        ['a plan that states the RowClass scope itself', planWithScope, false],
        ['a plan without its own row scope and steering that still carries a label list', { ...planWithoutScope, query: { ...planWithoutScope.query, limit: 12 } }, true],
        ['a plan that states the RowClass scope and steering that still carries a label list', { ...planWithScope, query: { ...planWithScope.query, limit: 13 } }, true],
    ] as const)('adds no label exclusion and keeps every detail row for %s', async (_label, plan, staleLabelList) => {
        const infoLogs: string[] = [];
        const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { infoLogs.push(args.map(String).join(' ')); });
        try {
            const { primeDuckDbDataset } = await import('../services/duckdb/queryEngine');
            const { runDataInvestigationHarness } = await import('../services/agent/runtime/dataInvestigationHarness');
            const { buildRuntimeSemanticUnderstanding } = await import('../services/agent/runtimeSemanticUnderstanding');
            const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');
            const { sanitizeDatasetSemanticSnapshot, buildSemanticDatasetVersion } = await import('../services/agent/datasetSemantics');

            const binding = (await primeDuckDbDataset(canonical)) as any;
            const semanticUnderstanding = buildRuntimeSemanticUnderstanding({
                columns: profiles, analysisBrief: null, reportContextResolution: null, datasetSemanticSnapshot: null,
            } as never);
            const findings = await runDataInvestigationHarness(profiles, binding, semanticUnderstanding, {});
            expect(findings).not.toBeNull();
            // The statistic that used to flag ordinary customers as duplicates, and its result.
            expect(findings!.duplicateLabels).toHaveLength(0);
            expect(findings!.analysisSteering.excludeFromAggregation).toEqual([]);
            expect(findings!.analysisSteering.hierarchyColumn).toBeNull();
            // Second line of defence: steering saved by an older run (or built elsewhere) may still
            // carry a label list made of real detail rows. Nothing downstream may apply it.
            const steering = staleLabelList
                ? {
                    ...findings!.analysisSteering,
                    excludeFromAggregation: canonical.data.filter(row => row.RowClass === 'fact').map(row => String(row[LABEL_COLUMN])).slice(0, 700),
                    hierarchyColumn: LABEL_COLUMN,
                }
                : findings!.analysisSteering;

            presentationMock.mockImplementation(async (p: SqlEvidenceQueryPlan, _a: unknown, _b: unknown, _c: unknown, execution: any) => ({
                card: { id: 'c', rows: execution.result.rows },
                presentationPlan: { title: p.title, presentationMode: 'table', bindings: {} }, evidenceSummary: {}, activeDataQuery: { result: { rows: [] } },
            }));
            const version = buildSemanticDatasetVersion(canonical);
            const state: any = {
                isChangingGoal: false, columnProfiles: profiles, canonicalBuildMeta: meta, csvData: canonical, canonicalCsvData: canonical, rawCsvData: canonical,
                datasetSemanticSnapshot: sanitizeDatasetSemanticSnapshot(null, canonical, 'm', version, profiles as never, null, null), semanticDatasetVersion: version,
                settings: { provider: 'google', geminiApiKey: 'k', openAIApiKey: '', simpleModel: 'm', complexModel: 'm', language: 'English' },
                reportContextResolution: null, dataPreparationPlan: null, agentMemoryHistory: [], recordAgentEvent: vi.fn(),
                analysisCards: [], datasetBundle: null,
                latestAnalysisSession: { analysisSteering: steering },
            };
            const store: any = { getState: () => state, setState: vi.fn() };
            executedSql.length = 0;
            await processSingleTopic('Sum Total by Region', canonical, store, undefined as never, [], {
                preGeneratedPlan: plan,
                harnessContext: steering,
            });

            expect(infoLogs.filter(line => line.includes('hierarchy_exclusion'))).toEqual([]);
            const aggregateSql = executedSql.filter(sql => /SUM\(/i.test(sql));
            expect(aggregateSql.length).toBeGreaterThan(0);
            aggregateSql.forEach(sql => expect(sql).not.toMatch(/NOT IN/i));

            const result = presentationMock.mock.calls[0]?.[4]?.result?.rows as Array<Record<string, unknown>>;
            expect(result).toHaveLength(truth.byRegion.size);
            for (const row of result) {
                expect(Number(row.sum_total), `region ${String(row.Region)}`).toBe(truth.byRegion.get(String(row.Region)));
            }
            expect(result.reduce((sum, row) => sum + Number(row.sum_total), 0)).toBe(truth.grand);

            // Per country, on the very table the queries ran against.
            const perCountry = duck.conn.query(
                `SELECT Region, Country, SUM(TRY_CAST(Total AS DOUBLE)) AS s FROM session_clean_dataset WHERE RowClass = 'fact' GROUP BY Region, Country`,
            ).toArray().map((row: any) => row.toJSON());
            for (const row of perCountry) {
                const label = `${row.Region} > ${String(row.Country).split(' > ').pop()}`;
                expect(Number(row.s), label).toBe(truth.byCountry.get(label));
            }
        } finally {
            logSpy.mockRestore();
        }
    }, 180_000);
});

describe('duplicate label detection', () => {
    it('does not call ordinary entities duplicates because their totals are close', async () => {
        const { detectDuplicateLabels, areLikelyAliasLabels } = await import('../services/agent/runtime/hierarchyDetector');
        const totals = [
            { description: 'Customer EUSi011', total: 20432, rowCount: 1 },
            { description: 'Customer EUSi012', total: 20440, rowCount: 1 },
            { description: 'Customer AMBr010', total: 20433, rowCount: 1 },
        ];
        expect(detectDuplicateLabels(totals, new Set())).toEqual([]);
        expect(areLikelyAliasLabels('Customer A1', 'Customer A10')).toBe(false);
    });

    it('still flags real aliases with near-equal totals', async () => {
        const { detectDuplicateLabels } = await import('../services/agent/runtime/hierarchyDetector');
        const pairs = detectDuplicateLabels([
            { description: 'ACME Trading Sdn. Bhd.', total: 1000, rowCount: 3 },
            { description: 'Acme Trading Sdn Bhd', total: 1002, rowCount: 3 },
            { description: 'Revenue Sales', total: 500, rowCount: 2 },
            { description: 'Sales Revenue', total: 500, rowCount: 2 },
        ], new Set());
        expect(pairs.map(pair => pair.descriptionB).sort()).toEqual(['Acme Trading Sdn Bhd', 'Sales Revenue']);
    });
});
