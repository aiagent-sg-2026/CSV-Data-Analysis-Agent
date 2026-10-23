import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisPlan, CanonicalBuildMeta, ColumnProfile, CsvData, SqlAnalysisPlan } from '../types';

// Chat and skill cards skip the topic pipeline's evidence gate, so they apply
// the series-measure check themselves: "total visitors by month" in chat must
// not sum a published total together with its components, and series of
// different units must not share one chart axis.

const { createNewCardMock, executeAggregationMock, executeSqlPlanMock } = vi.hoisted(() => ({
    createNewCardMock: vi.fn(),
    executeAggregationMock: vi.fn(),
    executeSqlPlanMock: vi.fn(),
}));

vi.mock('../services/agent/execution/cardCreator', () => ({ createNewCard: createNewCardMock }));
vi.mock('../services/workers/dataWorkerClient', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    executeAggregationWithWorker: executeAggregationMock,
}));
vi.mock('../services/agent/execution/sqlCardExecutor', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    executeSqlPlanAndCreateCard: executeSqlPlanMock,
}));

interface Melted {
    csvData: CsvData;
    columnProfiles: ColumnProfile[];
    canonicalBuildMeta: CanonicalBuildMeta;
}

const melt = async (fileName: string, text: string): Promise<Melted> => {
    const { processCsvWithIntakeIr } = await import('../services/data/csvParser');
    const { buildCsvDataFromIntakeIr } = await import('../services/data/reportCsvIntake');
    const { profileData } = await import('../services/data/dataProfiler');
    const { resolveReportStructureArtifactsWithProposal } = await import('../services/agent/orchestration/reportStructureOrchestrator');
    const { createTestSettings } = await import('./testSettings');
    const file = ({ name: fileName, size: text.length, text: async () => text }) as unknown as File;
    const { csvData, intakeIr } = await processCsvWithIntakeIr(file);
    const artifacts = await resolveReportStructureArtifactsWithProposal({
        rawCsvData: buildCsvDataFromIntakeIr(intakeIr),
        csvData,
        rawIntakeIr: intakeIr,
        cleaningRun: null,
        dataPreparationPlan: { explanation: 'x', operations: [], outputColumns: [], planStatus: 'schema_only', consistencyIssues: [] },
        columnProfiles: profileData(csvData.data).profiles,
        settings: createTestSettings(),
    });
    const canonical = artifacts.canonicalCsvData!;
    return { csvData: canonical, columnProfiles: profileData(canonical.data).profiles, canonicalBuildMeta: artifacts.canonicalBuildMeta! };
};

// Rail length (with its MRT/LRT parts) next to unrelated ridership series.
const TRANSPORT = [
    'DataSeries,2021,2022,2023,2024',
    'Rail Length,245.3,258.5,258.5,271.3',
    '    MRT,216.5,229.7,229.7,242.5',
    '    LRT,28.8,28.8,28.8,28.8',
    'Average Daily Ridership - MRT,2100,2745,3243,3412',
    'Average Daily Ridership - Bus,3000,3461,3747,3837',
].join('\n') + '\n';

// A published total and the arrivals that add up to it.
const VISITORS = [
    'DataSeries,2024Jan,2024Feb,2024Mar,2024Apr',
    'Total Visitor Arrivals,300,330,360,390',
    '    Asia,200,220,240,260',
    '    Europe,100,110,120,130',
].join('\n') + '\n';

const buildStore = (melted: Melted) => {
    const addProgress = vi.fn();
    const state = { ...melted, addProgress, pendingPrecomputedCardData: null };
    return { store: { getState: () => state, setState: vi.fn() } as any, addProgress };
};

const chartPlan = (overrides: Partial<AnalysisPlan>): AnalysisPlan => ({
    chartType: 'line',
    title: 'Total visitors by month',
    description: 'Monthly total.',
    aggregation: 'sum',
    groupByColumn: 'Period',
    valueColumn: 'Value',
    ...overrides,
});

describe('series-measure check on chat and skill cards', () => {
    let transport: Melted;
    let visitors: Melted;

    beforeAll(async () => {
        transport = await melt('transport.csv', TRANSPORT);
        visitors = await melt('visitors.csv', VISITORS);
        expect(transport.canonicalBuildMeta.seriesMeasure?.additiveAcrossSeries).toBe(false);
        expect(visitors.canonicalBuildMeta.seriesMeasure?.additiveAcrossSeries).toBe(true);
    }, 60_000);

    beforeEach(() => {
        vi.clearAllMocks();
        executeAggregationMock.mockResolvedValue([{ Period: '2024-01-01', Value: 600 }, { Period: '2024-02-01', Value: 660 }]);
        createNewCardMock.mockImplementation(async (plan: AnalysisPlan, aggregatedData: unknown, _store: unknown, annotations?: Record<string, unknown>) => ({
            id: 'card-1', plan, aggregatedData, evidenceValueGate: annotations?.evidenceValueGate ?? null,
        }));
        executeSqlPlanMock.mockResolvedValue({ id: 'sql-card' });
    });

    it('sends back a chat sum of a total together with its components', async () => {
        const { executePlanAndCreateCard } = await import('../services/agent/execution/cardExecutor');
        const { store, addProgress } = buildStore(visitors);

        expect(await executePlanAndCreateCard(chartPlan({}), visitors.csvData, store)).toBeNull();
        expect(executeAggregationMock).not.toHaveBeenCalled();
        expect(createNewCardMock).not.toHaveBeenCalled();
        expect(addProgress.mock.calls[0][0]).toContain('double-counts');

        await expect(executePlanAndCreateCard(chartPlan({}), visitors.csvData, store, { throwOnSoftFailure: true }))
            .rejects.toMatchObject({ name: 'PlanExecutionSoftError', code: 'series_scope_rejected' });

        // The same sum over detail rows is a valid total.
        const detail = await executePlanAndCreateCard(
            chartPlan({ preFilter: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] }),
            visitors.csvData,
            store,
        );
        expect(detail).toMatchObject({ id: 'card-1', evidenceValueGate: null });
    });

    it('keeps a per-series comparison of different units as a caveated table and passes one series', async () => {
        const { executePlanAndCreateCard } = await import('../services/agent/execution/cardExecutor');
        const { store } = buildStore(transport);

        expect(await executePlanAndCreateCard(chartPlan({ title: 'Ridership by year' }), transport.csvData, store)).toBeNull();

        const perSeries = await executePlanAndCreateCard(
            chartPlan({ chartType: 'bar', title: 'Average value by series', aggregation: 'avg', groupByColumn: 'DataSeries' }),
            transport.csvData,
            store,
        );
        expect(perSeries?.evidenceValueGate).toMatchObject({
            decision: 'table_only',
            reasonCodes: ['mixed_unit_series_comparison'],
            source: 'evidence_value_gate_v1',
        });

        const oneSeries = await executePlanAndCreateCard(
            chartPlan({
                title: 'MRT ridership trend',
                aggregation: 'avg',
                preFilter: [{ column: 'DataSeries', operator: 'eq', value: 'Average Daily Ridership - MRT' }],
            }),
            transport.csvData,
            store,
        );
        expect(oneSeries?.evidenceValueGate).toBeNull();
    });

    it('applies the same check to SQL-first chat plans', async () => {
        const { executePlanAction } = await import('../services/agent/execution/executorAgent');
        const { store, addProgress } = buildStore(transport);
        const sqlPlan = (groupBy: string, title: string): SqlAnalysisPlan => ({
            chartType: 'bar',
            title,
            description: title,
            queryMode: 'aggregate',
            aggregation: 'sum',
            bindings: { groupByColumn: groupBy, valueColumn: 'total_value' },
            query: { groupBy: [groupBy], aggregates: [{ function: 'sum', column: 'Value', as: 'total_value' }] },
        });

        expect(await executePlanAction(sqlPlan('Period', 'Total ridership by year'), store)).toBeNull();
        expect(executeSqlPlanMock).not.toHaveBeenCalled();
        expect(addProgress.mock.calls[0][0]).toContain('cross');
        await expect(executePlanAction(sqlPlan('Period', 'Total ridership by year'), store, { throwOnSoftFailure: true }))
            .rejects.toMatchObject({ code: 'series_scope_rejected' });

        await executePlanAction(sqlPlan('DataSeries', 'Total by series'), store);
        expect(executeSqlPlanMock).toHaveBeenCalledTimes(1);
        expect(executeSqlPlanMock.mock.calls[0][3]?.evidenceValueGate).toMatchObject({ decision: 'table_only' });
    });

    it('keeps a skill result that aggregates across series as an unverified table', async () => {
        const { createAnalysisCard } = await import('../services/agent/execution/analysisResultBuilders');
        const { store } = buildStore(transport);
        const rows = [{ Period: '2023-01-01', Value: 7000 }, { Period: '2024-01-01', Value: 7500 }];

        const total = await createAnalysisCard({ plan: chartPlan({ title: 'Value by year' }), data: rows, store });
        expect(total.evidenceValueGate).toMatchObject({ decision: 'table_only', reasonCodes: ['cross_series_aggregate'] });

        // A skill's own derived measure is not the series value.
        const derived = await createAnalysisCard({
            plan: chartPlan({ chartType: 'bar', title: 'Growth by year', valueColumn: 'growth_pct', aggregation: 'sum' }),
            data: [{ Period: '2024-01-01', growth_pct: 3 }],
            store,
        });
        expect(derived.evidenceValueGate).toBeNull();
    });
});
