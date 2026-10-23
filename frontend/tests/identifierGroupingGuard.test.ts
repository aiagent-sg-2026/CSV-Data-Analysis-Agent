// @vitest-environment node
//
// Ranking or counting by a column that identifies single records ("Top 8 of 3,200
// invoices" with every invoice at 0.1%, "Product Count by Product" with every count
// 7) is not a finding. The guard runs at the research plan, the topic processor and
// the deterministic topic fallback.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnProfile, CsvRow, ResearchPlanQuestion, SqlEvidenceQueryPlan } from '../types';
import { assessIdentifierGrouping, isIdentifierLikeGrouping, userAskedForLookup } from '../services/agent/planning/identifierGrouping';
import { checkQuestionDimensions } from '../services/agent/runtime/pi/researchPlan';
import { buildDeterministicTopics } from '../services/agent/planning/planGenerator';
import type { AnalysisDatasetContext } from '../services/prompts/analysisPrompts';

const { generateEvidenceQueryPlanWithRetryMock, executeEvidenceQueryMock, executePresentationPlanAndCreateCardMock } = vi.hoisted(() => ({
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

const ROWS = 200;
const rows: CsvRow[] = Array.from({ length: ROWS }, (_, index) => ({
    'Invoice No': `INV-${String(index).padStart(5, '0')}`,
    Customer: `Customer ${index % 8}`,
    Balance: 100 + index,
}));
const profiles: ColumnProfile[] = [
    { name: 'Invoice No', type: 'categorical', uniqueValues: ROWS },
    { name: 'Customer', type: 'categorical', uniqueValues: 8 },
    { name: 'Balance', type: 'numerical', uniqueValues: ROWS, valueRange: [100, 299] },
];

const plan = (title: string, groupBy: string): SqlEvidenceQueryPlan => ({
    title,
    queryMode: 'aggregate',
    intentSummary: title,
    query: {
        select: [groupBy, 'total'],
        groupBy: [groupBy],
        aggregates: [{ function: 'sum', column: 'Balance', as: 'total' }],
        orderBy: [{ column: 'total', direction: 'desc' }],
        limit: 20,
    },
});

describe('identifier-like grouping', () => {
    it('flags a column with at least 80% distinct values over enough rows', () => {
        expect(isIdentifierLikeGrouping({ name: 'Invoice No', type: 'categorical', uniqueValues: 3200 }, 3200)).toBe(true);
        expect(isIdentifierLikeGrouping({ name: 'Product', type: 'categorical', uniqueValues: 2040 }, 14280)).toBe(false);
        expect(isIdentifierLikeGrouping({ name: 'Product', type: 'categorical', uniqueValues: 2040 }, 2500)).toBe(true);
        expect(isIdentifierLikeGrouping({ name: 'Customer', type: 'categorical', uniqueValues: 20 }, 359)).toBe(false);
    });

    it('leaves small tables and time axes alone', () => {
        expect(isIdentifierLikeGrouping({ name: 'Name', type: 'categorical', uniqueValues: 9 }, 10)).toBe(false);
        // One row per day is a time series, not an identifier.
        expect(isIdentifierLikeGrouping({ name: 'Day', type: 'date', uniqueValues: 365 }, 365)).toBe(false);
        expect(isIdentifierLikeGrouping({ name: 'Order :: Date', type: 'categorical', uniqueValues: 300 }, 359)).toBe(false);
    });

    it('lets a reader who asks for a lookup or detail table group by the identifier', () => {
        expect(userAskedForLookup('Look up the balance of each invoice')).toBe(true);
        expect(userAskedForLookup('Invoice details')).toBe(true);
        expect(userAskedForLookup('Top invoices by sum balance')).toBe(false);
        const base = { groupBy: ['Invoice No'], profiles, rowCount: ROWS };
        expect(assessIdentifierGrouping({ ...base, requestText: 'Top invoices by sum balance' })).toMatchObject({ decision: 'reject', reasonCodes: ['identifier_grouping'] });
        expect(assessIdentifierGrouping({ ...base, requestText: 'List all invoice details' }).decision).toBe('accept');
    });

    it('sends back research questions grouped by an identifier, with the reason', () => {
        const questions: ResearchPlanQuestion[] = [
            { title: 'Top invoices by balance', rationale: '', dimension: 'Invoice No', metric: 'Balance', aggregation: 'sum', comparison: null },
            { title: 'Balance by customer', rationale: '', dimension: 'Customer', metric: 'Balance', aggregation: 'sum', comparison: null },
            { title: 'Count of products by product', rationale: '', dimension: 'Invoice No', metric: null, aggregation: 'count', comparison: null },
        ];
        const checked = checkQuestionDimensions(questions, profiles, ROWS);
        expect(checked.questions.map(question => question.title)).toEqual(['Balance by customer']);
        expect(checked.rejected).toHaveLength(2);
        expect(checked.rejected[0].reason).toContain('identifies single records');
    });

    it('keeps identifiers out of the deterministic fallback topics', () => {
        const context = {
            title: 'Invoices',
            rowCount: ROWS,
            dimensionColumns: ['Invoice No', 'Customer'],
            metricColumns: ['Balance'],
            blockedDimensions: [],
        } as unknown as AnalysisDatasetContext;
        const topics = buildDeterministicTopics(profiles, context);
        expect(topics.length).toBeGreaterThan(0);
        topics.forEach(topic => expect(topic).not.toContain('Invoice No'));
        expect(topics[0]).toContain('Customer');
    });
});

describe('topic processor replans or rejects an identifier grouping', () => {
    const buildStore = () => {
        const state = {
            isChangingGoal: false,
            columnProfiles: profiles,
            canonicalBuildMeta: null,
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

    beforeEach(() => {
        vi.clearAllMocks();
        executeEvidenceQueryMock.mockImplementation(async (evidencePlan: SqlEvidenceQueryPlan) => {
            const groupBy = evidencePlan.query.groupBy![0];
            const totals = new Map<string, number>();
            rows.forEach(row => totals.set(String(row[groupBy]), (totals.get(String(row[groupBy])) ?? 0) + Number(row.Balance)));
            const resultRows = [...totals.entries()].map(([key, total]) => ({ [groupBy]: key, total }));
            return {
                result: {
                    rows: resultRows, totalMatchedRows: resultRows.length, returnedRows: resultRows.length, truncated: false,
                    selectedColumns: evidencePlan.query.select, appliedOrderBy: [], appliedLimit: 20, durationMs: 1,
                },
                execution: { engine: 'duckdb', sqlPreview: 'SELECT', tableName: 't', loadVersion: 'v1', fallbackReason: null, fallbackStage: null },
                activeDataQuery: { result: { rows: [] } },
            };
        });
        executePresentationPlanAndCreateCardMock.mockImplementation(async (evidencePlan: SqlEvidenceQueryPlan) => ({
            card: { id: `card-${evidencePlan.title}` },
            presentationPlan: { title: evidencePlan.title, description: '', presentationMode: 'chart', chartType: 'bar', bindings: {} },
            evidenceSummary: {},
            activeDataQuery: { result: { rows: [] } },
        }));
    });

    it('replans a sum by invoice number before it runs and keeps the customer ranking', async () => {
        generateEvidenceQueryPlanWithRetryMock.mockResolvedValue(plan('Total balance by customer', 'Customer'));
        const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');

        const result = await processSingleTopic('Top invoices by balance', { fileName: 'invoices.csv', data: rows }, buildStore(), {
            tableName: 't', loadVersion: 'v1',
        }, [], { preGeneratedPlan: plan('Top invoices by balance', 'Invoice No') });

        expect(executeEvidenceQueryMock.mock.calls.map(call => (call[0] as SqlEvidenceQueryPlan).title)).not.toContain('Top invoices by balance');
        expect(String(generateEvidenceQueryPlanWithRetryMock.mock.calls[0][5])).toContain('identifies single records');
        expect(result).toMatchObject({ status: 'completed', cardCreated: true, accepted: true });
        expect(executePresentationPlanAndCreateCardMock.mock.calls[0][0].title).toBe('Total balance by customer');
    }, 30_000);

    it('rejects the topic with a reason when every replan still groups by the identifier', async () => {
        generateEvidenceQueryPlanWithRetryMock.mockResolvedValue(plan('Top invoices by balance', 'Invoice No'));
        const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');

        const result = await processSingleTopic('Top invoices by balance', { fileName: 'invoices.csv', data: rows }, buildStore(), {
            tableName: 't', loadVersion: 'v1',
        }, [], { preGeneratedPlan: plan('Top invoices by balance', 'Invoice No') });

        expect(result).toMatchObject({
            status: 'completed', cardCreated: false, accepted: false, valueDecision: 'reject', valueReasonCodes: ['identifier_grouping'],
        });
        expect((result as { rejectionReason?: string }).rejectionReason).toContain('identifies single records');
        expect(executePresentationPlanAndCreateCardMock).not.toHaveBeenCalled();
    }, 30_000);

    it('lets a lookup request through', async () => {
        const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');
        const result = await processSingleTopic('Look up the balance of each invoice', { fileName: 'invoices.csv', data: rows }, buildStore(), {
            tableName: 't', loadVersion: 'v1',
        }, [], { preGeneratedPlan: plan('Balance by invoice', 'Invoice No') });
        expect(generateEvidenceQueryPlanWithRetryMock).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'completed' });
    }, 30_000);
    it('does not judge a plan that filters rows, since its population is unknown', async () => {
        const filtered = plan('Top invoices of one customer', 'Invoice No');
        filtered.query.where = { predicates: [{ column: 'Customer', operator: 'eq', value: 'Customer 1' }] };
        const { processSingleTopic } = await import('../services/agent/planning/topicProcessor');
        const result = await processSingleTopic('Top invoices of Customer 1', { fileName: 'invoices.csv', data: rows }, buildStore(), {
            tableName: 't', loadVersion: 'v1',
        }, [], { preGeneratedPlan: filtered });
        expect(generateEvidenceQueryPlanWithRetryMock).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'completed' });
    }, 30_000);
});
