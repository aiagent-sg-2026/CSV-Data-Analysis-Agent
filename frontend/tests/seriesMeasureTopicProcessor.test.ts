// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalBuildMeta, ColumnProfile, CsvRow, SqlEvidenceQueryPlan } from '../types';

const {
    generateEvidenceQueryPlanWithRetryMock,
    executeEvidenceQueryMock,
    executePresentationPlanAndCreateCardMock,
} = vi.hoisted(() => ({
    generateEvidenceQueryPlanWithRetryMock: vi.fn(),
    executeEvidenceQueryMock: vi.fn(),
    executePresentationPlanAndCreateCardMock: vi.fn(),
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

const TRANSPORT = 'sg-public-transport-ridership.csv';

const plan = (title: string, filters: Array<{ column: string; value: string }>, fn: 'sum' | 'avg'): SqlEvidenceQueryPlan => ({
    title,
    queryMode: 'aggregate',
    intentSummary: title,
    preferredResultShape: 'time_series',
    query: {
        select: ['Period', `${fn}_value`],
        groupBy: ['Period'],
        aggregates: [{ function: fn, column: 'Value', as: `${fn}_value` }],
        where: filters.length ? { predicates: filters.map(filter => ({ column: filter.column, operator: 'eq' as const, value: filter.value })) } : undefined,
        orderBy: [{ column: 'Period', direction: 'asc' }],
        limit: 500,
    },
});

const aggregateByPeriod = (rows: CsvRow[], evidencePlan: SqlEvidenceQueryPlan): CsvRow[] => {
    const predicates = evidencePlan.query.where?.predicates ?? [];
    const aggregate = evidencePlan.query.aggregates![0];
    const groups = new Map<string, number[]>();
    rows
        .filter(row => predicates.every(predicate => String(row[predicate.column]) === String(predicate.value)))
        .forEach(row => {
            if (row.Value === null) return;
            groups.set(String(row.Period), [...(groups.get(String(row.Period)) ?? []), Number(row.Value)]);
        });
    return [...groups.entries()].map(([period, values]) => ({
        Period: period,
        [aggregate.as]: aggregate.function === 'sum'
            ? values.reduce((total, value) => total + value, 0)
            : values.reduce((total, value) => total + value, 0) / values.length,
    }));
};

describe('topic pipeline on a melted table whose series measure different things', { timeout: 60_000 }, () => {
    let rows: CsvRow[] = [];
    let profiles: ColumnProfile[] = [];
    let canonicalBuildMeta: CanonicalBuildMeta | null = null;

    beforeAll(async () => {
        const { processCsvWithIntakeIr } = await import('../services/data/csvParser');
        const { buildCsvDataFromIntakeIr } = await import('../services/data/reportCsvIntake');
        const { profileData } = await import('../services/data/dataProfiler');
        const { resolveReportStructureArtifactsWithProposal } = await import('../services/agent/orchestration/reportStructureOrchestrator');
        const { createTestSettings } = await import('./testSettings');
        const text = fs.readFileSync(path.resolve(process.cwd(), '../demo-data', TRANSPORT), 'utf8');
        const file = ({ name: TRANSPORT, size: text.length, text: async () => text }) as unknown as File;
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
        executeEvidenceQueryMock.mockImplementation(async (evidencePlan: SqlEvidenceQueryPlan) => {
            const resultRows = aggregateByPeriod(rows, evidencePlan);
            return {
                result: {
                    rows: resultRows,
                    totalMatchedRows: resultRows.length,
                    returnedRows: resultRows.length,
                    truncated: false,
                    selectedColumns: evidencePlan.query.select,
                    appliedOrderBy: [],
                    appliedLimit: 500,
                    durationMs: 1,
                },
                execution: { engine: 'duckdb', sqlPreview: 'SELECT', tableName: 't', loadVersion: 'v1', fallbackReason: null, fallbackStage: null },
                activeDataQuery: { result: { rows: [] } },
            };
        });
        executePresentationPlanAndCreateCardMock.mockImplementation(async (evidencePlan: SqlEvidenceQueryPlan) => ({
            card: { id: `card-${evidencePlan.title}` },
            presentationPlan: { title: evidencePlan.title, description: '', presentationMode: 'chart', chartType: 'line', bindings: {} },
            evidenceSummary: {},
            activeDataQuery: { result: { rows: [] } },
        }));
    });

    it('replans a cross-series SUM(Value) by Period before it runs and keeps the single-series trend', async () => {
        const crossSeries = plan('Total Ridership by Period', [{ column: 'RowClass', value: 'fact' }], 'sum');
        const singleSeries = plan('Average daily MRT ridership trend by year', [{ column: 'DataSeries', value: 'Average Daily Ridership - MRT' }], 'avg');
        generateEvidenceQueryPlanWithRetryMock.mockResolvedValue(singleSeries);

        const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');
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
        const store = { getState: () => state, setState: vi.fn() };

        const result = await processSingleTopic('Total ridership by period', { fileName: TRANSPORT, data: rows }, store, {
            tableName: 't',
            loadVersion: 'v1',
        }, [], { preGeneratedPlan: crossSeries });

        expect(executeEvidenceQueryMock.mock.calls.map(call => call[0].title)).not.toContain('Total Ridership by Period');
        expect(generateEvidenceQueryPlanWithRetryMock).toHaveBeenCalledTimes(1);
        expect(String(generateEvidenceQueryPlanWithRetryMock.mock.calls[0][5])).toContain('each series measures something different');
        expect(result).toMatchObject({ status: 'completed', cardCreated: true, accepted: true, valueDecision: 'pass' });
        expect(executePresentationPlanAndCreateCardMock.mock.calls[0][0].title).toBe('Average daily MRT ridership trend by year');
    });

    it('rejects the topic when every replan still aggregates across series', async () => {
        const crossSeries = plan('Total Ridership by Period', [], 'sum');
        generateEvidenceQueryPlanWithRetryMock.mockResolvedValue(crossSeries);

        const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');
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
        const store = { getState: () => state, setState: vi.fn() };

        const result = await processSingleTopic('Total ridership by period', { fileName: TRANSPORT, data: rows }, store, {
            tableName: 't',
            loadVersion: 'v1',
        }, [], { preGeneratedPlan: crossSeries });

        expect(result).toMatchObject({ status: 'completed', cardCreated: false, accepted: false, valueDecision: 'reject' });
        expect(executePresentationPlanAndCreateCardMock).not.toHaveBeenCalled();
    });
});
