// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type {
    AnalysisCardData,
    ColumnProfile,
    RuntimeSemanticUnderstanding,
    SqlEvidenceQueryPlan,
    SqlEvidenceQueryResultSummary,
} from '../types';
import {
    assessVolumeDependence,
    buildVolumeCheckPlan,
    measureEvidenceVolumeDependence,
    spearmanRankCorrelation,
} from '../services/agent/planning/volumeDrivenSum';
import {
    checkQuestionMethods,
    checkSumVolumeDependence,
    validateColumnAdditivity,
    validateResearchQuestions,
} from '../services/agent/runtime/pi/researchPlan';
import { evaluateEvidenceValue } from '../services/agent/evidenceValueGate';
import { evaluateAutoAnalysisCards } from '../services/agent/autoAnalysisEvaluation';

// Per-group [sum, row count] pairs. One row per transaction: the sum follows the count.
const MIRRORS_COUNT: Array<[number, number]> = [[9_000, 90], [7_100, 70], [5_000, 52], [3_200, 31], [900, 9], [600, 5]];
// Per-row values differ enough between groups that the sum ranking departs from the count ranking.
const DIFFERS_FROM_COUNT: Array<[number, number]> = [[9_000, 10], [7_000, 80], [5_000, 20], [3_000, 60], [1_000, 40]];
// Pre-aggregated rows (one row per group per period): every group has the same row count.
const EQUAL_GROUP_SIZES: Array<[number, number]> = [[9_000, 12], [7_000, 12], [5_000, 12], [3_000, 12]];

const groups = (pairs: Array<[number, number]>) => pairs.map(([sum, count]) => ({ sum, count }));

describe('spearmanRankCorrelation', () => {
    it('is 1 for the same order, -1 for the reverse order, and handles ties', () => {
        expect(spearmanRankCorrelation([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
        expect(spearmanRankCorrelation([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1);
        expect(spearmanRankCorrelation([1, 2, 2, 3], [1, 2, 3, 4])).toBeGreaterThan(0.9);
    });

    it('is undefined when one side has no variation', () => {
        expect(spearmanRankCorrelation([1, 2, 3], [5, 5, 5])).toBeNull();
        expect(spearmanRankCorrelation([1], [1])).toBeNull();
    });
});

describe('assessVolumeDependence', () => {
    it('flags a SUM whose group ranking mirrors the row-count ranking', () => {
        expect(assessVolumeDependence(groups(MIRRORS_COUNT))).toMatchObject({ volumeDriven: true, groupCount: 6 });
    });

    it('does not flag a SUM whose ranking departs from the row counts', () => {
        expect(assessVolumeDependence(groups(DIFFERS_FROM_COUNT))?.volumeDriven).toBe(false);
    });

    it('does not apply to rows that are not one per event (equal group sizes)', () => {
        expect(assessVolumeDependence(groups(EQUAL_GROUP_SIZES))).toBeNull();
    });

    it('does not apply to too few groups', () => {
        expect(assessVolumeDependence(groups(MIRRORS_COUNT.slice(0, 3)))).toBeNull();
    });
});

describe('buildVolumeCheckPlan', () => {
    const sumPlan: SqlEvidenceQueryPlan = {
        title: 'Revenue by Region',
        queryMode: 'aggregate',
        intentSummary: 'x',
        query: {
            groupBy: ['Region'],
            where: { predicates: [{ column: 'Year', operator: 'eq', value: 2025 }] },
            aggregates: [{ function: 'sum', column: 'Revenue', as: 'total' }],
            limit: 10,
        },
        preFilter: [{ column: 'Status', operator: 'eq', value: 'Closed' }] as never,
    };

    it('keeps the population of the evidence query and adds a row count', () => {
        expect(buildVolumeCheckPlan(sumPlan)).toMatchObject({
            queryMode: 'aggregate',
            preFilter: sumPlan.preFilter,
            query: {
                groupBy: ['Region'],
                where: sumPlan.query.where,
                aggregates: [
                    { function: 'sum', column: 'Revenue' },
                    { function: 'count' },
                ],
            },
        });
    });

    it('ignores plans that are not one dimension compared by one unconditional SUM', () => {
        expect(buildVolumeCheckPlan({ ...sumPlan, query: { ...sumPlan.query, aggregates: [{ function: 'median', column: 'Revenue', as: 'm' }] } })).toBeNull();
        expect(buildVolumeCheckPlan({ ...sumPlan, query: { ...sumPlan.query, groupBy: ['Region', 'Year'] } })).toBeNull();
        expect(buildVolumeCheckPlan({ ...sumPlan, queryMode: 'rowset' })).toBeNull();
        expect(buildVolumeCheckPlan({
            ...sumPlan,
            query: { ...sumPlan.query, aggregates: [{ function: 'sum', column: 'Revenue', as: 't', where: { predicates: [{ column: 'Year', operator: 'eq', value: 2025 }] } }] },
        })).toBeNull();
    });

    it('treats a failed companion query as no finding but rethrows a cancellation', async () => {
        await expect(measureEvidenceVolumeDependence(sumPlan, async () => { throw new Error('duckdb down'); })).resolves.toBeNull();
        const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        await expect(measureEvidenceVolumeDependence(sumPlan, async () => { throw abort; })).rejects.toBe(abort);
    });
});

const columns = [
    { name: 'town', type: 'categorical' },
    { name: 'resale_price', type: 'currency' },
    { name: 'block', type: 'numerical' },
    { name: 'revenue', type: 'currency' },
] as unknown as ColumnProfile[];

const question = (overrides: Record<string, unknown>) => ({
    title: 'Q', rationale: 'r', dimension: 'town', metric: 'resale_price', aggregation: 'sum', ...overrides,
});

describe('research plan method checks', () => {
    const plan = (raw: Array<Record<string, unknown>>) => validateResearchQuestions({ questions: raw }, columns).questions;

    it('reads total_intent only for SUM questions', () => {
        const [sum, median] = plan([question({ title: 'A', total_intent: true }), question({ title: 'B', aggregation: 'median', total_intent: true })]);
        expect(sum.totalIntent).toBe(true);
        expect(median.totalIntent).toBeUndefined();
    });

    it("holds a SUM to the model's own additivity judgement", () => {
        const { accepted } = validateColumnAdditivity([
            { column: 'resale_price', kind: 'non_additive', nature: 'unit_value' },
            { column: 'revenue', kind: 'additive', nature: 'flow' },
        ], columns);
        const { questions, rejected } = checkQuestionMethods(plan([
            question({ title: 'Sum of a unit value' }),
            question({ title: 'Sum of revenue', metric: 'revenue' }),
            question({ title: 'Median price', aggregation: 'median' }),
        ]), accepted);
        expect(questions.map(item => item.title)).toEqual(['Sum of revenue', 'Median price']);
        expect(rejected).toEqual([{ title: 'Sum of a unit value', reason: expect.stringContaining('non_additive') }]);
    });

    it('asks for a judgement before a metric is summed', () => {
        const { rejected } = checkQuestionMethods(plan([question({ title: 'Unjudged sum', metric: 'revenue' })]), {});
        expect(rejected[0].reason).toContain('Classify "revenue"');
    });

    it('rejects numeric aggregation of a column judged to be an identifier, but allows counting it', () => {
        const { accepted, rejected: judgementRejected } = validateColumnAdditivity([
            { column: 'block', kind: 'non_additive', nature: 'identifier' },
        ], columns);
        expect(judgementRejected).toEqual([]);
        expect(validateColumnAdditivity([{ column: 'block', kind: 'additive', nature: 'identifier' }], columns).rejected).toHaveLength(1);
        const { questions, rejected } = checkQuestionMethods(plan([
            question({ title: 'Average block', metric: 'block', aggregation: 'avg' }),
            question({ title: 'Distinct blocks', metric: 'block', aggregation: 'count_distinct' }),
        ]), accepted);
        expect(rejected.map(item => item.title)).toEqual(['Average block']);
        expect(questions.map(item => item.title)).toEqual(['Distinct blocks']);
    });

    it('sends back a grouped SUM that only mirrors group size, unless it is explicitly a total', async () => {
        const measure = vi.fn(async (_dimension: string, metric: string) =>
            groups(metric === 'resale_price' ? MIRRORS_COUNT : DIFFERS_FROM_COUNT));
        const { questions, rejected } = await checkSumVolumeDependence([
            ...plan([
                question({ title: 'Sum of price by town' }),
                question({ title: 'Revenue by town', metric: 'revenue' }),
                question({ title: 'Median price by town', aggregation: 'median' }),
            ]),
            // Same measure, but stated as a total; validated separately because it duplicates the first question.
            ...plan([question({ title: 'Total transaction value by town', total_intent: true })]),
        ], measure);

        expect(rejected).toHaveLength(1);
        expect(rejected[0].title).toBe('Sum of price by town');
        expect(rejected[0].reason).toMatch(/row counts.*median or avg.*total_intent/s);
        expect(questions.map(item => item.title)).toEqual(['Revenue by town', 'Median price by town', 'Total transaction value by town']);
        // Only grouped SUMs without a stated total intent are measured.
        expect(measure.mock.calls).toEqual([['town', 'resale_price'], ['town', 'revenue']]);
    });

    it('keeps the question when the data cannot be measured', async () => {
        const { questions } = await checkSumVolumeDependence(plan([question({ title: 'Sum' })]), async () => { throw new Error('no data'); });
        expect(questions).toHaveLength(1);
    });
});

const semanticUnderstanding: RuntimeSemanticUnderstanding = {
    businessGrains: ['Region'],
    candidateMetrics: ['Revenue'],
    timeGrains: [],
    helperDimensions: [],
    blockedDimensions: [],
    detailRowPolicy: 'exclude_non_detail_rows',
    businessGlossary: [],
    businessGrainConfidence: 'high',
    unsafeForBusinessNarrative: false,
};
const evidencePlan: SqlEvidenceQueryPlan = {
    title: 'Revenue by Region',
    queryMode: 'aggregate',
    intentSummary: 'x',
    preferredResultShape: 'ranked_aggregate',
    query: { select: ['Region', 'total'], groupBy: ['Region'], aggregates: [{ function: 'sum', column: 'Revenue', as: 'total' }] },
};
const evidenceSummary: SqlEvidenceQueryResultSummary = {
    queryMode: 'aggregate',
    preferredResultShape: 'ranked_aggregate',
    rowCount: 5,
    columnCount: 2,
    columns: ['Region', 'total'],
    numericColumns: ['total'],
    categoricalColumns: ['Region'],
    timeColumns: [],
    distinctGroupCount: 5,
    totalValue: 100,
    isTimeSeriesCandidate: false,
    isWideCategorySet: false,
    hasSecondaryMetric: false,
    hasNegativeValues: false,
    previewRows: [{ Region: 'A', total: 60 }, { Region: 'B', total: 40 }],
};

describe('evidence value gate with a volume measurement', () => {
    const gate = (volumeDependence: Parameters<typeof evaluateEvidenceValue>[0]['volumeDependence']) =>
        evaluateEvidenceValue({ semanticUnderstanding, evidencePlan, evidenceSummary, volumeDependence });
    const dependence = { rankCorrelation: 0.97, groupCount: 5, volumeDriven: true, description: 'The ranking mostly reflects row counts.' };

    it('adds a caveat without changing the presentation decision', () => {
        const baseline = gate(null);
        const flagged = gate({ ...dependence, totalIntentConfirmed: false });
        expect(baseline.reasonCodes).not.toContain('volume_driven_sum');
        expect(flagged.decision).toBe(baseline.decision);
        expect(flagged.reasonCodes).toContain('volume_driven_sum');
        expect(flagged.detail).toContain('row counts');
    });

    it('only notes the dependence for a stated total, and ignores a non-volume-driven SUM', () => {
        expect(gate({ ...dependence, totalIntentConfirmed: true }).reasonCodes).toEqual(expect.arrayContaining(['volume_driven_total']));
        expect(gate({ ...dependence, volumeDriven: false, totalIntentConfirmed: false }).reasonCodes).not.toContain('volume_driven_sum');
    });
});

describe('auto analysis evaluation of a volume-driven SUM card', () => {
    const card = (reasonCodes: string[]): AnalysisCardData => ({
        id: 'card-1',
        plan: { chartType: 'bar', title: 'Revenue by Region', description: 'd', aggregation: 'sum', groupByColumn: 'Region', valueColumn: 'Revenue' },
        aggregatedData: [{ Region: 'East', Revenue: 100 }, { Region: 'West', Revenue: 80 }],
        summary: { language: 'English', text: 's' },
        displayChartType: 'bar',
        isDataVisible: false,
        topN: null,
        hideOthers: false,
        evidenceValueGate: {
            decision: 'pass', reasonCodes, detail: 'd', querySignature: 'q', semanticSignature: 's', semanticRisk: 'low',
            evaluatedAt: '2026-10-22T00:00:00Z', source: 'evidence_value_gate_v1',
        },
    }) as AnalysisCardData;

    it('caveats an unconfirmed volume-driven SUM so trusted cards lead the headline', () => {
        const [evaluation] = evaluateAutoAnalysisCards([card(['volume_driven_sum'])]).cards;
        expect(evaluation).toMatchObject({ verdict: 'caveated', reasonCodes: ['volume_driven_aggregate'] });
    });

    it('keeps a stated total trusted', () => {
        const [evaluation] = evaluateAutoAnalysisCards([card(['volume_driven_total'])]).cards;
        expect(evaluation.verdict).toBe('trusted');
    });
});
