// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    AnalysisPlan,
    CanonicalBuildMeta,
    ColumnProfile,
    CsvRow,
    RuntimeSemanticUnderstanding,
    SqlEvidenceQueryPlan,
} from '../types';

const {
    generateEvidenceQueryPlanWithRetryMock,
    executeEvidenceQueryMock,
    executePresentationPlanAndCreateCardMock,
    streamGenerateTextMock,
} = vi.hoisted(() => ({
    generateEvidenceQueryPlanWithRetryMock: vi.fn(),
    executeEvidenceQueryMock: vi.fn(),
    executePresentationPlanAndCreateCardMock: vi.fn(),
    streamGenerateTextMock: vi.fn(),
}));

vi.mock('../services/ai/streamGenerateText', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    streamGenerateText: streamGenerateTextMock,
}));

vi.mock('../services/agent/planning/planGenerator', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    generateEvidenceQueryPlanWithRetry: generateEvidenceQueryPlanWithRetryMock,
}));

vi.mock('../services/agent/execution/sqlCardExecutor', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    executeEvidenceQuery: executeEvidenceQueryMock,
    executePresentationPlanAndCreateCard: executePresentationPlanAndCreateCardMock,
}));

vi.mock('../services/vectorStore', () => ({ vectorStore: { searchIfReady: vi.fn().mockResolvedValue([]) } }));

// The hierarchy fixture w2: Region / Country / Customer rows with monthly
// columns; the intake tags parent rows RowClass = 'subtotal'. An aggregate that
// also reads the parents counts every amount once per level.
const FIXTURE = 'w2_hierarchy_monthly.csv';
const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/weird-reports');
const truth = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'truth.json'), 'utf8')).f2 as { leaf_rows: number; grand_total: number };

const semanticUnderstanding: RuntimeSemanticUnderstanding = {
    businessGrains: ['ParentSeries'],
    candidateMetrics: ['Total'],
    timeGrains: [],
    helperDimensions: [],
    blockedDimensions: [],
    detailRowPolicy: 'exclude_non_detail_rows',
    businessGlossary: [],
    businessGrainConfidence: 'high',
    unsafeForBusinessNarrative: false,
};

const matches = (row: CsvRow, predicate: { column: string; operator: string; value?: unknown }) => {
    const cell = String(row[predicate.column]);
    if (predicate.operator === 'eq') return cell === String(predicate.value);
    if (predicate.operator === 'in') return (predicate.value as unknown[]).map(String).includes(cell);
    if (predicate.operator === 'not_in') return !(predicate.value as unknown[]).map(String).includes(cell);
    return true;
};

const median = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
};

/** Runs an evidence plan over the canonical rows the way the SQL engine would. */
const evaluatePlan = async (rows: CsvRow[], plan: SqlEvidenceQueryPlan): Promise<CsvRow[]> => {
    const { mergeEvidencePreFilterIntoQuery } = await import('../services/agent/planning/evidenceQuerySemantics');
    const query = mergeEvidencePreFilterIntoQuery(plan.query, plan.preFilter);
    const predicates = query.where?.predicates ?? [];
    const filtered = rows.filter(row => predicates.every(predicate => matches(row, predicate)));
    const groupBy = query.groupBy ?? [];
    const groups = new Map<string, CsvRow[]>();
    filtered.forEach(row => {
        const key = groupBy.map(column => String(row[column])).join('|');
        groups.set(key, [...(groups.get(key) ?? []), row]);
    });
    if (groupBy.length === 0 && groups.size === 0) groups.set('', []);
    let result = [...groups.values()].map(members => {
        const out: CsvRow = {};
        groupBy.forEach(column => { out[column] = members[0]?.[column] ?? null; });
        (query.aggregates ?? []).forEach(aggregate => {
            const values = members
                .map(row => (aggregate.column ? Number(row[aggregate.column]) : 1))
                .filter(value => Number.isFinite(value));
            out[aggregate.as] = aggregate.function === 'sum' ? values.reduce((total, value) => total + value, 0)
                : aggregate.function === 'count' ? members.length
                    : aggregate.function === 'avg' ? values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1)
                        : aggregate.function === 'median' ? median(values)
                            : aggregate.function === 'max' ? Math.max(...values)
                                : aggregate.function === 'min' ? Math.min(...values) : values.length;
        });
        return out;
    });
    const order = query.orderBy?.[0];
    if (order) {
        result = result.sort((left, right) => (Number(left[order.column]) - Number(right[order.column])) * (order.direction === 'desc' ? -1 : 1));
    }
    return result;
};

const rankedPlan = (title: string, groupBy: string, aggregate: SqlEvidenceQueryPlan['query']['aggregates'], limit = 500, where?: SqlEvidenceQueryPlan['query']['where']): SqlEvidenceQueryPlan => ({
    title,
    queryMode: 'aggregate',
    intentSummary: title,
    preferredResultShape: 'ranked_aggregate',
    query: {
        select: [groupBy, aggregate![0].as],
        groupBy: [groupBy],
        aggregates: aggregate,
        ...(where ? { where } : {}),
        orderBy: [{ column: aggregate![0].as, direction: 'desc' }],
        limit,
    },
});

const sum = (values: unknown[]) => values.reduce<number>((total, value) => total + Number(value ?? 0), 0);

describe('topic pipeline on a hierarchy row table', { timeout: 60_000 }, () => {
    let rows: CsvRow[] = [];
    let profiles: ColumnProfile[] = [];
    let canonicalBuildMeta: CanonicalBuildMeta | null = null;
    let leafRows: CsvRow[] = [];

    const buildStore = () => {
        const state = {
            isChangingGoal: false,
            columnProfiles: profiles,
            canonicalBuildMeta,
            settings: { provider: 'google', geminiApiKey: 'k', openAIApiKey: '', simpleModel: 'm', complexModel: 'm', language: 'English' },
            reportContextResolution: null,
            datasetSemanticSnapshot: null,
            semanticDatasetVersion: null,
            dataPreparationPlan: null,
            agentMemoryHistory: [],
            recordAgentEvent: vi.fn(),
        } as never;
        return { getState: () => state, setState: vi.fn() };
    };

    const runTopic = async (topic: string, preGeneratedPlan: SqlEvidenceQueryPlan, options: Record<string, unknown> = {}) => {
        const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');
        return processSingleTopic(topic, { fileName: FIXTURE, data: rows }, buildStore(), { tableName: 't', loadVersion: 'v1' }, [], {
            preGeneratedPlan,
            ...options,
        });
    };

    const executedPlans = () => executeEvidenceQueryMock.mock.calls.map(call => call[0] as SqlEvidenceQueryPlan);
    const readsDetailRowsOnly = (plan: SqlEvidenceQueryPlan) => {
        const predicates = [...(plan.query.where?.predicates ?? []), ...(plan.preFilter ?? []).map(clause => ({ ...clause }))];
        return predicates.some(predicate => predicate.column === 'RowClass' && predicate.operator === 'eq' && predicate.value === 'fact');
    };

    beforeAll(async () => {
        const { processCsvWithIntakeIr } = await import('../services/data/csvParser');
        const { buildCsvDataFromIntakeIr } = await import('../services/data/reportCsvIntake');
        const { profileData } = await import('../services/data/dataProfiler');
        const { resolveReportStructureArtifactsWithProposal } = await import('../services/agent/orchestration/reportStructureOrchestrator');
        const { createTestSettings } = await import('./testSettings');
        const text = fs.readFileSync(path.join(FIXTURE_DIR, FIXTURE), 'utf8');
        const file = ({ name: FIXTURE, size: text.length, text: async () => text }) as unknown as File;
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
        rows = artifacts.canonicalCsvData!.data;
        profiles = profileData(rows).profiles;
        canonicalBuildMeta = artifacts.canonicalBuildMeta;
        leafRows = rows.filter(row => row.RowClass === 'fact');
    });

    beforeEach(() => {
        vi.clearAllMocks();
        streamGenerateTextMock.mockRejectedValue(new Error('No AI step is scripted for this test.'));
        executeEvidenceQueryMock.mockImplementation(async (evidencePlan: SqlEvidenceQueryPlan) => {
            const resultRows = await evaluatePlan(rows, evidencePlan);
            const limit = evidencePlan.query.limit ?? 500;
            const returned = resultRows.slice(0, limit);
            return {
                result: {
                    rows: returned,
                    totalMatchedRows: resultRows.length,
                    returnedRows: returned.length,
                    truncated: resultRows.length > returned.length,
                    selectedColumns: evidencePlan.query.select,
                    appliedOrderBy: [],
                    appliedLimit: limit,
                    durationMs: 1,
                },
                execution: { engine: 'duckdb', sqlPreview: 'SELECT', tableName: 't', loadVersion: 'v1', fallbackReason: null, fallbackStage: null },
                activeDataQuery: { result: { rows: [] } },
            };
        });
        executePresentationPlanAndCreateCardMock.mockImplementation(async (evidencePlan: SqlEvidenceQueryPlan) => ({
            card: { id: `card-${evidencePlan.title}` },
            presentationPlan: { title: evidencePlan.title, description: '', presentationMode: 'table', chartType: 'bar', bindings: {} },
            evidenceSummary: {},
            activeDataQuery: { result: { rows: [] } },
        }));
    });

    it('records a hierarchy with parents tagged subtotal and the detail rows as the leaf total', () => {
        expect(canonicalBuildMeta?.rowHierarchy).toMatchObject({ rowClassColumn: 'RowClass', detailRowValue: 'fact', detailRows: truth.leaf_rows });
        expect(canonicalBuildMeta!.rowHierarchy!.levelColumns).toEqual(['Region', 'Country']);
        expect(leafRows).toHaveLength(truth.leaf_rows);
        expect(sum(leafRows.map(row => row.Total))).toBe(truth.grand_total);
        expect(sum(rows.map(row => row.Total))).toBeGreaterThan(truth.grand_total * 2.5);
    });

    it('offers each level as a column whose group totals over detail rows equal the published parents', async () => {
        const { resolveRowHierarchy } = await import('../services/agent/planning/rowHierarchyGuard');
        expect(resolveRowHierarchy({ canonicalBuildMeta, columnProfiles: profiles })).toMatchObject({ levelColumns: ['Region', 'Country'] });
        const regionRows = rows.filter(row => row.HierarchyDepth === 0);
        expect(regionRows.length).toBeGreaterThan(1);
        for (const region of regionRows) {
            const regionKey = String(region['Region / Country / Customer']);
            const leaves = leafRows.filter(row => row.Region === regionKey);
            expect(sum(leaves.map(row => row.Total))).toBe(Number(region.Total));
            const countries = rows.filter(row => row.HierarchyDepth === 1 && row.Region === regionKey);
            expect(sum(countries.map(row => row.Total))).toBe(Number(region.Total));
        }
        const countryRows = rows.filter(row => row.HierarchyDepth === 1);
        for (const country of countryRows) {
            const leaves = leafRows.filter(row => row.Country === country['Region / Country / Customer']);
            expect(sum(leaves.map(row => row.Total))).toBe(Number(country.Total));
        }
    });

    it('adds the detail-row filter to a planner plan that groups parents with their children', async () => {
        // The plan the AI wrote on the live build: no RowClass filter at all.
        const unfiltered = rankedPlan('Top Parent Serieses by Total Value', 'ParentSeries', [{ function: 'sum', column: 'Total', as: 'sum_total' }], 5);
        const result = await runTopic('Top Parent Serieses by Total Value', unfiltered);

        expect(result).toMatchObject({ status: 'completed', cardCreated: true, accepted: true, valueDecision: 'pass' });
        const executed = executedPlans();
        expect(executed.length).toBeGreaterThan(0);
        expect(executed.every(readsDetailRowsOnly)).toBe(true);
        // Every group is a country read from its customers: no region aggregate beside country groups.
        const shown = await evaluatePlan(rows, executed[0]);
        const parentLabels = new Set(rows.filter(row => row.RowClass !== 'fact').map(row => String(row['Region / Country / Customer'])));
        expect(shown.every(group => !parentLabels.has(String(group.ParentSeries)) || rows.some(row => row.RowClass === 'fact' && row.ParentSeries === group.ParentSeries))).toBe(true);
        expect(shown.every(group => {
            const members = leafRows.filter(row => row.ParentSeries === group.ParentSeries);
            return sum(members.map(row => row.Total)) === Number(group.sum_total);
        })).toBe(true);
    });

    it('measures the share denominator over detail rows, so shares are against the leaf total', async () => {
        const unfiltered = rankedPlan('Top Parent Serieses by Total Value', 'ParentSeries', [{ function: 'sum', column: 'Total', as: 'sum_total' }], 2);
        await runTopic('Top Parent Serieses by Total Value', unfiltered);

        const createCall = executePresentationPlanAndCreateCardMock.mock.calls[0];
        const coverage = (createCall[5] as { groupCoverage: { status: string; overallTotal: number | null } }).groupCoverage;
        expect(coverage.status).toBe('partial');
        expect(coverage.overallTotal).toBe(truth.grand_total);
        const totalCheck = executedPlans().find(plan => plan.query.aggregates?.[0].as === 'group_coverage_total')!;
        expect(readsDetailRowsOnly(totalCheck)).toBe(true);
    });

    it('counts detail rows only for a row count by parent', async () => {
        const count = rankedPlan('Row Count by Parent Series', 'ParentSeries', [{ function: 'count', as: 'row_count' }], 500);
        await runTopic('Row Count by Parent Series', count);

        const executed = executedPlans().find(plan => plan.title === 'Row Count by Parent Series')!;
        expect(readsDetailRowsOnly(executed)).toBe(true);
        const counted = await evaluatePlan(rows, executed);
        expect(sum(counted.map(group => group.row_count as number))).toBe(truth.leaf_rows);
    });

    it('computes a median per parent over its detail rows, never over subtotal rows', async () => {
        const medianPlan = rankedPlan('Median Total by Parent Series', 'ParentSeries', [{ function: 'median', column: 'Total', as: 'median_total' }], 500);
        await runTopic('Median Total by Parent Series', medianPlan);

        const executed = executedPlans().find(plan => plan.title === 'Median Total by Parent Series')!;
        expect(readsDetailRowsOnly(executed)).toBe(true);
        const groups = await evaluatePlan(rows, executed);
        groups.forEach(group => {
            const members = leafRows.filter(row => row.ParentSeries === group.ParentSeries).map(row => Number(row.Total));
            expect(group.median_total).toBe(median(members));
        });
    });

    it('rejects a topic whose every plan aggregates subtotal rows with their details', async () => {
        const mixed = rankedPlan('Total by label', 'Region / Country / Customer', [{ function: 'sum', column: 'Total', as: 'sum_total' }], 20, {
            predicates: [{ column: 'RowClass', operator: 'in', value: ['subtotal', 'fact'] }],
        });
        generateEvidenceQueryPlanWithRetryMock.mockResolvedValue(mixed);
        const result = await runTopic('Total by label', mixed);

        expect(result).toMatchObject({ status: 'completed', cardCreated: false, accepted: false, valueDecision: 'reject' });
        expect(executePresentationPlanAndCreateCardMock).not.toHaveBeenCalled();
        expect(String(generateEvidenceQueryPlanWithRetryMock.mock.calls[0][5])).toContain("RowClass");
    });

    it('lets a plan that states its own one-level scope through', async () => {
        const regionsOnly = rankedPlan('Published region totals', 'Region / Country / Customer', [{ function: 'sum', column: 'Total', as: 'sum_total' }], 20, {
            predicates: [{ column: 'HierarchyDepth', operator: 'eq', value: 0 }],
        });
        const result = await runTopic('Published region totals', regionsOnly);
        expect(result).toMatchObject({ status: 'completed', cardCreated: true, valueDecision: 'pass' });
        expect(readsDetailRowsOnly(executedPlans()[0])).toBe(false);
    });
});

describe('detail-row scope on every planner and gate path for a hierarchy table', { timeout: 60_000 }, () => {
    let rows: CsvRow[] = [];
    let profiles: ColumnProfile[] = [];
    let canonicalBuildMeta: CanonicalBuildMeta | null = null;

    beforeAll(async () => {
        const { processCsvWithIntakeIr } = await import('../services/data/csvParser');
        const { buildCsvDataFromIntakeIr } = await import('../services/data/reportCsvIntake');
        const { profileData } = await import('../services/data/dataProfiler');
        const { resolveReportStructureArtifactsWithProposal } = await import('../services/agent/orchestration/reportStructureOrchestrator');
        const { createTestSettings } = await import('./testSettings');
        const text = fs.readFileSync(path.join(FIXTURE_DIR, FIXTURE), 'utf8');
        const file = ({ name: FIXTURE, size: text.length, text: async () => text }) as unknown as File;
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
        rows = artifacts.canonicalCsvData!.data;
        profiles = profileData(rows).profiles;
        canonicalBuildMeta = artifacts.canonicalBuildMeta;
    });

    beforeEach(() => {
        vi.clearAllMocks();
        streamGenerateTextMock.mockRejectedValue(new Error('No AI step is scripted for this test.'));
    });

    const hasFactScope = (plan: Pick<SqlEvidenceQueryPlan, 'query' | 'preFilter'>) => {
        const predicates = [...(plan.query.where?.predicates ?? []), ...(plan.preFilter ?? [])];
        return predicates.some(predicate => predicate.column === 'RowClass' && predicate.operator === 'eq' && predicate.value === 'fact');
    };

    it('the stepped planner scopes its plan to detail rows even without harness steering', async () => {
        const { generateEvidenceQueryPlanStepped } = await import('../services/agent/planning/planGenerator');
        const { buildDatasetContext } = await import('../services/agent/contextBuilder');
        const { resolveRowHierarchy } = await import('../services/agent/planning/rowHierarchyGuard');
        streamGenerateTextMock.mockImplementation(async ({ messages }: { messages: Array<{ content: string }> }) => {
            const prompt = messages[messages.length - 1].content;
            if (prompt.includes('Which metric')) return { text: 'SUM(Total)' };
            if (prompt.includes('WHERE filters')) return { text: 'none' };
            return { text: 'ParentSeries' };
        });
        const data = { fileName: FIXTURE, data: rows };
        const datasetContext = buildDatasetContext(data, profiles, null, null, null, null, data);
        datasetContext.rowHierarchy = resolveRowHierarchy({ canonicalBuildMeta, columnProfiles: profiles });
        const settings = { provider: 'google', geminiApiKey: 'k', openAIApiKey: '', simpleModel: 'm', complexModel: 'm', language: 'English' } as never;

        const plan = await generateEvidenceQueryPlanStepped('Top Parent Serieses by Total Value', profiles, settings, null, datasetContext);
        expect(plan.query.aggregates?.[0]).toMatchObject({ function: 'sum', column: 'Total' });
        expect(hasFactScope(plan)).toBe(true);
    });

    it('the stepped planner leaves a plan unscoped when the table has no hierarchy', async () => {
        const { generateEvidenceQueryPlanStepped } = await import('../services/agent/planning/planGenerator');
        const { buildDatasetContext } = await import('../services/agent/contextBuilder');
        streamGenerateTextMock.mockImplementation(async ({ messages }: { messages: Array<{ content: string }> }) => {
            const prompt = messages[messages.length - 1].content;
            if (prompt.includes('Which metric')) return { text: 'SUM(Total)' };
            if (prompt.includes('WHERE filters')) return { text: 'none' };
            return { text: 'ParentSeries' };
        });
        const data = { fileName: FIXTURE, data: rows };
        const datasetContext = buildDatasetContext(data, profiles, null, null, null, null, data);
        const settings = { provider: 'google', geminiApiKey: 'k', openAIApiKey: '', simpleModel: 'm', complexModel: 'm', language: 'English' } as never;
        const plan = await generateEvidenceQueryPlanStepped('Top Parent Serieses by Total Value', profiles, settings, null, datasetContext);
        expect(hasFactScope(plan)).toBe(false);
    });

    it('the retry planner scopes the plan the model wrote', async () => {
        const planGenerator = await vi.importActual<typeof import('../services/agent/planning/planGenerator')>('../services/agent/planning/planGenerator');
        const { buildDatasetContext } = await import('../services/agent/contextBuilder');
        const { resolveRowHierarchy } = await import('../services/agent/planning/rowHierarchyGuard');
        const modelPlan = rankedPlan('Top Parent Serieses by Total Value', 'ParentSeries', [{ function: 'sum', column: 'Total', as: 'sum_total' }], 10);
        streamGenerateTextMock.mockResolvedValue({ text: JSON.stringify(modelPlan), output: modelPlan });
        const data = { fileName: FIXTURE, data: rows };
        const datasetContext = buildDatasetContext(data, profiles, null, null, null, null, data);
        datasetContext.rowHierarchy = resolveRowHierarchy({ canonicalBuildMeta, columnProfiles: profiles });
        const settings = { provider: 'google', geminiApiKey: 'k', openAIApiKey: '', simpleModel: 'm', complexModel: 'm', language: 'English' } as never;
        const state = { columnProfiles: profiles, canonicalBuildMeta, settings } as never;

        const plan = await planGenerator.generateEvidenceQueryPlanWithRetry(
            'Top Parent Serieses by Total Value', profiles, settings, undefined, state, undefined, datasetContext, rows,
        );
        expect(hasFactScope(plan)).toBe(true);
    });

    it('the Pi research planner puts the detail-row filter on every measuring question', async () => {
        const { applyRowHierarchyScope, buildResearchTopic } = await import('../services/agent/runtime/pi/researchPlan');
        const { resolveRowHierarchy } = await import('../services/agent/planning/rowHierarchyGuard');
        const contract = resolveRowHierarchy({ canonicalBuildMeta, columnProfiles: profiles });
        const scoped = applyRowHierarchyScope([
            { title: 'Totals by parent', rationale: 'r', dimension: 'ParentSeries', metric: 'Total', aggregation: 'sum', comparison: null },
            { title: 'Rows by parent', rationale: 'r', dimension: 'ParentSeries', metric: null, aggregation: 'count', comparison: null },
        ], contract);
        expect(scoped.map(question => question.filter)).toEqual([
            { column: 'RowClass', value: 'fact' },
            { column: 'RowClass', value: 'fact' },
        ]);
        expect(buildResearchTopic(scoped[1])).toContain("where RowClass = 'fact'");
    });

    it('the evidence gate rejects an unfiltered aggregate and a card plan without the filter is not verified', async () => {
        const { evaluateEvidenceValue } = await import('../services/agent/evidenceValueGate');
        const { buildEvidenceResultSummary } = await import('../services/agent/execution/sqlCardExecutor');
        const { resolveRowHierarchy } = await import('../services/agent/planning/rowHierarchyGuard');
        const { assessCardSeriesScope } = await import('../services/agent/execution/cardSeriesScope');
        const contract = resolveRowHierarchy({ canonicalBuildMeta, columnProfiles: profiles });
        const plan = rankedPlan('Row Count by Parent Series', 'ParentSeries', [{ function: 'count', as: 'row_count' }]);
        const resultRows = await evaluatePlan(rows, plan);
        const summary = buildEvidenceResultSummary(plan, {
            rows: resultRows, totalMatchedRows: resultRows.length, returnedRows: resultRows.length, truncated: false,
            selectedColumns: plan.query.select ?? [], appliedOrderBy: [], appliedLimit: 0, durationMs: 0,
        }, profiles);

        const unscoped = evaluateEvidenceValue({ semanticUnderstanding, evidencePlan: plan, evidenceSummary: summary, rowHierarchy: contract });
        expect(unscoped.decision).toBe('reject');
        expect(unscoped.reasonCodes).toContain('series_hierarchy_double_count');

        const { withDetailRowScope } = await import('../services/agent/planning/rowHierarchyGuard');
        const scopedPlan = withDetailRowScope(plan, contract);
        const scoped = evaluateEvidenceValue({ semanticUnderstanding, evidencePlan: scopedPlan, evidenceSummary: summary, rowHierarchy: contract });
        expect(scoped.decision).not.toBe('reject');
        expect(scoped.reasonCodes).not.toContain('series_hierarchy_double_count');

        // A chat or skill card plan written without the filter never passes unverified.
        const cardPlan: AnalysisPlan = { chartType: 'bar', title: 'Total by parent', description: '', groupByColumn: 'ParentSeries', valueColumn: 'Total', aggregation: 'sum' };
        expect(assessCardSeriesScope(cardPlan, null, contract).decision).toBe('reject');
        expect(assessCardSeriesScope({ ...cardPlan, preFilter: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] }, null, contract).decision).toBe('pass');
        expect(assessCardSeriesScope(cardPlan, null, null).decision).toBe('pass');
    });
});
