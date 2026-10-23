// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { AnalysisCardData, AnalysisCardGroupCoverage, CsvCellValue, CsvRow, SqlEvidenceQueryPlan } from '../types';
import {
    buildGroupCountCheckPlan,
    buildGroupTotalCheckPlan,
    GROUP_COUNT_ALIAS,
    GROUP_TOTAL_ALIAS,
    isGroupResultTruncated,
    measureGroupCoverage,
} from '../services/agent/planning/groupCoverage';
import { describeCardGroupCoverage, resolveCardGroupTotals } from '../utils/cardGroupTotals';
import { evaluateAggregationQuality } from '../services/agent/execution/aggregationQuality';
import { buildNarrativeAnalysisIrInputList } from '../services/dashboard/displayAnalysisNarrative';

const rankedPlan = (overrides: Partial<SqlEvidenceQueryPlan['query']> = {}, plan: Partial<SqlEvidenceQueryPlan> = {}): SqlEvidenceQueryPlan => ({
    title: 'Sum Value by Data Series',
    queryMode: 'aggregate',
    intentSummary: 'Rank the markets.',
    query: {
        select: ['DataSeries', 'total_value'],
        where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] },
        groupBy: ['DataSeries'],
        aggregates: [{ function: 'sum', column: 'Value', as: 'total_value' }],
        orderBy: [{ column: 'total_value', direction: 'desc' }],
        limit: 3,
        ...overrides,
    },
    ...plan,
});

const rows = (...values: number[]): CsvRow[] => values.map((total_value, index) => ({ DataSeries: `G${index + 1}`, total_value }));
const cutOff = (rowValues: CsvRow[], matched = 9) => ({ rows: rowValues, totalMatchedRows: matched, truncated: matched > rowValues.length, appliedLimit: rowValues.length });
const companion = (total: CsvCellValue) => vi.fn(async () => ({ result: { rows: [{ [GROUP_TOTAL_ALIAS]: total }] } }));

describe('buildGroupTotalCheckPlan', () => {
    it('is one ungrouped, unlimited aggregate over the same filters and pre-filter', () => {
        const plan = rankedPlan({}, { preFilter: [{ column: 'Period', operator: 'gte', value: '2025-01-01' }] });
        expect(buildGroupTotalCheckPlan(plan)).toMatchObject({
            queryMode: 'aggregate',
            query: {
                select: [GROUP_TOTAL_ALIAS],
                where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] },
                aggregates: [{ function: 'sum', column: 'Value', as: GROUP_TOTAL_ALIAS }],
                limit: 1,
            },
            preFilter: [{ column: 'Period', operator: 'gte', value: '2025-01-01' }],
        });
        expect(buildGroupTotalCheckPlan(plan)!.query.groupBy).toBeUndefined();
        expect(buildGroupTotalCheckPlan(plan)!.query.orderBy).toBeUndefined();
    });

    it('keeps the filter of a conditional aggregate and counts rows without a column', () => {
        const conditional = rankedPlan({
            aggregates: [{ function: 'sum', column: 'Value', as: 'total_value', where: { predicates: [{ column: 'Kind', operator: 'eq', value: 'a' }] } }],
        });
        expect(buildGroupTotalCheckPlan(conditional)!.query.aggregates).toEqual([
            { function: 'sum', column: 'Value', as: GROUP_TOTAL_ALIAS, where: { predicates: [{ column: 'Kind', operator: 'eq', value: 'a' }] } },
        ]);
        const counting = rankedPlan({ aggregates: [{ function: 'count', as: 'rows' }] });
        expect(buildGroupTotalCheckPlan(counting)!.query.aggregates).toEqual([{ function: 'count', as: GROUP_TOTAL_ALIAS }]);
    });

    it('totals the aggregate the card shows when the query has several', () => {
        const plan = rankedPlan({ aggregates: [{ function: 'avg', column: 'Value', as: 'avg_value' }, { function: 'sum', column: 'Value', as: 'total_value' }] });
        expect(buildGroupTotalCheckPlan(plan, 'total_value')!.query.aggregates![0].function).toBe('sum');
        expect(buildGroupTotalCheckPlan(plan)).toBeNull();
    });

    it.each([
        ['an average', rankedPlan({ aggregates: [{ function: 'avg', column: 'Value', as: 'total_value' }] })],
        ['a median', rankedPlan({ aggregates: [{ function: 'median', column: 'Value', as: 'total_value' }] })],
        ['a distinct count', rankedPlan({ aggregates: [{ function: 'count_distinct', column: 'Value', as: 'total_value' }] })],
        ['a query without grouping', rankedPlan({ groupBy: undefined })],
        ['raw SQL', rankedPlan({ rawSql: 'SELECT 1' })],
        ['a post-aggregate filter', rankedPlan({ postAggregateFilter: { predicates: [{ column: 'total_value', operator: 'gt', value: 5 }] } })],
        ['a rowset', rankedPlan({}, { queryMode: 'rowset' })],
    ])('does not apply to %s', (_label, plan) => {
        expect(buildGroupTotalCheckPlan(plan)).toBeNull();
    });
});

describe('isGroupResultTruncated', () => {
    it('trusts the engine flags and the matched group count', () => {
        expect(isGroupResultTruncated({ rows: rows(3, 2, 1), totalMatchedRows: 9, truncated: true })).toBe(true);
        expect(isGroupResultTruncated({ rows: rows(3, 2, 1), totalMatchedRows: 3, truncated: false, appliedLimit: 3 })).toBe(false);
        expect(isGroupResultTruncated({ rows: rows(3, 2, 1), totalMatchedRows: 9, truncated: false })).toBe(true);
    });

    it('treats a result without engine flags as cut off when it filled the limit exactly', () => {
        expect(isGroupResultTruncated({ rows: rows(3, 2, 1), appliedLimit: 3 })).toBe(true);
        expect(isGroupResultTruncated({ rows: rows(3, 2), appliedLimit: 3 })).toBe(false);
        expect(isGroupResultTruncated({ rows: rows(3, 2) })).toBe(false);
    });
});

describe('measureGroupCoverage', () => {
    it('runs no companion query when the query returned every group', async () => {
        const run = companion(99);
        const coverage = await measureGroupCoverage(rankedPlan(), cutOff(rows(3, 2, 1), 3), run);
        expect(coverage).toEqual({ status: 'complete', groupCount: 3, overallTotal: 6 });
        expect(run).not.toHaveBeenCalled();
    });

    it('measures the total over every group when the query limit cut groups off', async () => {
        const run = companion(30);
        const coverage = await measureGroupCoverage(rankedPlan(), cutOff(rows(10, 8, 6)), run);
        expect(coverage).toEqual({ status: 'partial', groupCount: 9, overallTotal: 30 });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('reads a total the engine returns as a formatted string', async () => {
        expect(await measureGroupCoverage(rankedPlan(), cutOff(rows(10, 8, 6)), companion('1,030.5'))).toMatchObject({ overallTotal: 1030.5 });
    });

    it('leaves the total unmeasured, not zero, when the companion query fails or returns nothing', async () => {
        const failing = vi.fn(async () => { throw new Error('boom'); });
        expect(await measureGroupCoverage(rankedPlan(), cutOff(rows(10, 8, 6)), failing)).toEqual({ status: 'partial', groupCount: 9, overallTotal: null });
        const empty = vi.fn(async () => ({ result: { rows: [] } }));
        expect(await measureGroupCoverage(rankedPlan(), cutOff(rows(10, 8, 6)), empty)).toMatchObject({ overallTotal: null });
        expect(await measureGroupCoverage(rankedPlan(), cutOff(rows(10, 8, 6)), companion(null))).toMatchObject({ overallTotal: null });
    });

    it('rethrows a cancellation instead of recording an unmeasured card', async () => {
        const controller = new AbortController();
        controller.abort();
        const aborted = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); });
        await expect(measureGroupCoverage(rankedPlan(), cutOff(rows(10, 8, 6)), aborted, { signal: controller.signal })).rejects.toThrow('cancelled');
    });

    it('rejects a total below the rows already shown, which means the queries read different data', async () => {
        expect(await measureGroupCoverage(rankedPlan(), cutOff(rows(10, 8, 6)), companion(20))).toMatchObject({ status: 'partial', overallTotal: null });
        // With negative groups the total can legitimately be below the positive rows.
        expect(await measureGroupCoverage(rankedPlan(), cutOff(rows(10, 8, -6)), companion(5))).toMatchObject({ overallTotal: 5 });
    });

    it('does not claim a group count when the engine only reports the rows it returned', async () => {
        const coverage = await measureGroupCoverage(rankedPlan(), { rows: rows(10, 8, 6), totalMatchedRows: 3, appliedLimit: 3 }, companion(30));
        expect(coverage).toEqual({ status: 'partial', groupCount: null, overallTotal: 30 });
    });

    it('skips the companion query when the total is suppressed (a measure that is not additive across series)', async () => {
        const run = companion(30);
        expect(await measureGroupCoverage(rankedPlan(), cutOff(rows(10, 8, 6)), run, { totalSuppressed: true }))
            .toEqual({ status: 'partial', groupCount: 9, overallTotal: null });
        expect(run).not.toHaveBeenCalled();
    });

    it('records only the group count of an average, with no total and no total query', async () => {
        const run = companion(30);
        const plan = rankedPlan({ aggregates: [{ function: 'avg', column: 'Value', as: 'total_value' }] });
        expect(await measureGroupCoverage(plan, cutOff(rows(10, 8, 6)), run)).toEqual({ status: 'partial', groupCount: 9, overallTotal: null });
        expect(run).not.toHaveBeenCalled();
    });

    it.each([
        ['a query without grouping', rankedPlan({ groupBy: undefined })],
        ['a rowset', rankedPlan({}, { queryMode: 'rowset' })],
    ])('records nothing for %s', async (_label, plan) => {
        const run = companion(30);
        expect(await measureGroupCoverage(plan, cutOff(rows(10, 8, 6)), run)).toBeNull();
        expect(run).not.toHaveBeenCalled();
    });

    it('leaves a post-aggregate filter unmeasured, since "all groups" is then ambiguous', async () => {
        const run = companion(30);
        const plan = rankedPlan({ postAggregateFilter: { predicates: [{ column: 'total_value', operator: 'gt', value: 5 }] } });
        expect(await measureGroupCoverage(plan, cutOff(rows(10, 8, 6)), run)).toEqual({ status: 'partial', groupCount: 9, overallTotal: null });
        expect(run).not.toHaveBeenCalled();
    });
});

describe('resolveCardGroupTotals', () => {
    const partial: AnalysisCardGroupCoverage = { status: 'partial', groupCount: 52, overallTotal: 244 };
    const base = { additive: true, rowsTotal: 180, rowCount: 10, filterActive: false };

    it('uses the measured total and group count for a cut-off ranking', () => {
        expect(resolveCardGroupTotals({ ...base, coverage: partial })).toEqual({ overallTotal: 244, matchedGroupCount: 52, complete: false });
    });

    it('has no total at all for an unmeasured cut-off ranking', () => {
        expect(resolveCardGroupTotals({ ...base, coverage: { ...partial, overallTotal: null } }))
            .toEqual({ overallTotal: null, matchedGroupCount: 52, complete: false });
    });

    it('treats a complete, legacy or filtered view as complete over its rows', () => {
        const complete = { overallTotal: 180, matchedGroupCount: 10, complete: true };
        expect(resolveCardGroupTotals({ ...base, coverage: { status: 'complete', groupCount: 10, overallTotal: 180 } })).toEqual(complete);
        expect(resolveCardGroupTotals({ ...base, coverage: undefined })).toEqual(complete);
        expect(resolveCardGroupTotals({ ...base, coverage: partial, filterActive: true })).toEqual(complete);
    });

    it('never gives a non-additive measure a total, but keeps the group count of a cut-off ranking', () => {
        expect(resolveCardGroupTotals({ ...base, additive: false, coverage: partial }))
            .toEqual({ overallTotal: null, matchedGroupCount: 52, complete: false });
        expect(resolveCardGroupTotals({ ...base, additive: false, coverage: { status: 'partial', groupCount: null, overallTotal: null } }))
            .toEqual({ overallTotal: null, matchedGroupCount: null, complete: false });
        // Legacy, complete and filtered views are complete over their rows.
        expect(resolveCardGroupTotals({ ...base, additive: false, coverage: undefined }))
            .toEqual({ overallTotal: null, matchedGroupCount: 10, complete: true });
        expect(resolveCardGroupTotals({ ...base, additive: false, coverage: partial, filterActive: true }))
            .toEqual({ overallTotal: null, matchedGroupCount: 10, complete: true });
    });
});

describe('group count of a cut-off non-additive ranking', () => {
    const medianPlan = (overrides: Partial<SqlEvidenceQueryPlan['query']> = {}, plan: Partial<SqlEvidenceQueryPlan> = {}) => rankedPlan({
        aggregates: [{ function: 'median', column: 'Value', as: 'median_value' }],
        orderBy: [{ column: 'median_value', direction: 'desc' }],
        ...overrides,
    }, plan);
    const groupCountCompanion = (count: CsvCellValue) => vi.fn(async () => ({ result: { rows: [{ [GROUP_COUNT_ALIAS]: count }] } }));
    // The engine did not report how many groups matched: only that the limit was filled.
    const filledLimit = (rowValues: CsvRow[]) => ({ rows: rowValues, appliedLimit: rowValues.length });

    it('counts the distinct groups over the same filters and pre-filter, with no total or share', () => {
        const check = buildGroupCountCheckPlan(medianPlan({}, { preFilter: [{ column: 'Period', operator: 'gte', value: '2025-01-01' }] }));
        expect(check).toMatchObject({
            query: {
                where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] },
                aggregates: [{ function: 'count_distinct', column: 'DataSeries', as: GROUP_COUNT_ALIAS }],
                limit: 1,
            },
            preFilter: [{ column: 'Period', operator: 'gte', value: '2025-01-01' }],
        });
        expect(check!.query.groupBy).toBeUndefined();
        // One group column can be counted; several, a HAVING filter or raw SQL are left unmeasured.
        expect(buildGroupCountCheckPlan(medianPlan({ groupBy: ['A', 'B'] }))).toBeNull();
        expect(buildGroupCountCheckPlan(medianPlan({ postAggregateFilter: { predicates: [{ column: 'median_value', operator: 'gt', value: 1 }] } }))).toBeNull();
    });

    it('takes the matched count the engine reports and runs no companion query', async () => {
        const run = groupCountCompanion(99);
        const coverage = await measureGroupCoverage(medianPlan(), cutOff(rows(10, 8, 6), 20), run);
        expect(coverage).toEqual({ status: 'partial', groupCount: 20, overallTotal: null });
        expect(run).not.toHaveBeenCalled();
    });

    it('measures the group count with a companion query when the engine reports none', async () => {
        const run = groupCountCompanion('3,200');
        const coverage = await measureGroupCoverage(medianPlan(), filledLimit(rows(10, 8, 6)), run);
        expect(coverage).toEqual({ status: 'partial', groupCount: 3200, overallTotal: null });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('leaves the count unknown when the companion fails, returns nothing or contradicts the rows', async () => {
        const failing = vi.fn(async () => { throw new Error('boom'); });
        expect(await measureGroupCoverage(medianPlan(), filledLimit(rows(10, 8, 6)), failing))
            .toEqual({ status: 'partial', groupCount: null, overallTotal: null });
        expect(await measureGroupCoverage(medianPlan(), filledLimit(rows(10, 8, 6)), groupCountCompanion(null)))
            .toEqual({ status: 'partial', groupCount: null, overallTotal: null });
        expect(await measureGroupCoverage(medianPlan(), filledLimit(rows(10, 8, 6)), groupCountCompanion(2)))
            .toEqual({ status: 'partial', groupCount: null, overallTotal: null });
    });

    it('records nothing when the query returned every group', async () => {
        const run = groupCountCompanion(99);
        expect(await measureGroupCoverage(medianPlan(), cutOff(rows(3, 2, 1), 3), run)).toBeNull();
        expect(run).not.toHaveBeenCalled();
    });

    it('rethrows a cancellation', async () => {
        const controller = new AbortController();
        controller.abort(new Error('stop'));
        const cancelled = vi.fn(async () => { throw new Error('aborted'); });
        await expect(measureGroupCoverage(medianPlan(), filledLimit(rows(10, 8, 6)), cancelled, { signal: controller.signal })).rejects.toThrow();
    });
});

describe('describeCardGroupCoverage', () => {
    const card = (groupCoverage: AnalysisCardGroupCoverage | undefined, aggregation: 'sum' | 'avg' = 'sum'): AnalysisCardData => ({
        id: 'c',
        plan: { title: 't', description: '', chartType: 'bar', aggregation, groupByColumn: 'DataSeries', valueColumn: 'total_value' },
        aggregatedData: rows(10, 8, 6),
        summary: { language: 'English', text: '' },
        displayChartType: 'bar',
        isDataVisible: false,
        topN: null,
        hideOthers: false,
        groupCoverage,
    });

    it('is silent when the rows are every group', () => {
        expect(describeCardGroupCoverage(card(undefined))).toBeNull();
        expect(describeCardGroupCoverage(card({ status: 'complete', groupCount: 3, overallTotal: 24 }))).toBeNull();
        expect(describeCardGroupCoverage(card(undefined, 'avg'))).toBeNull();
    });

    it('tells the model a cut-off average covers only the top of its ranking and has no shares', () => {
        const note = describeCardGroupCoverage(card({ status: 'partial', groupCount: 9, overallTotal: null }, 'avg'));
        expect(note).toContain('only the top of a ranking of 9 groups');
        expect(note).toContain('Do not state percentages or shares');
    });

    it('gives the model the total to compute shares against, or forbids shares when it is unknown', () => {
        expect(describeCardGroupCoverage(card({ status: 'partial', groupCount: 9, overallTotal: 30 })))
            .toContain('The total over all groups is 30. Compute every percentage or share against 30');
        const unknown = describeCardGroupCoverage(card({ status: 'partial', groupCount: null, overallTotal: null }))!;
        expect(unknown).toContain('the groups the query matched');
        expect(unknown).toContain('Do not state percentages or shares');
    });
});

describe('evaluateAggregationQuality on a cut-off ranking', () => {
    const plan = { title: 't', description: '', chartType: 'bar', aggregation: 'sum', groupByColumn: 'DataSeries', valueColumn: 'total_value' } as const;
    const data = rows(40, 30, 20, 10, 5, 3);

    it('measures concentration against the real total, not the rows returned', () => {
        const rowsOnly = evaluateAggregationQuality(plan, data);
        expect(rowsOnly.metrics.topShare).toBeCloseTo(105 / 108);

        const measured = evaluateAggregationQuality(plan, data, { status: 'partial', groupCount: 40, overallTotal: 300 });
        expect(measured.metrics.total).toBe(300);
        expect(measured.metrics.topShare).toBeCloseTo(105 / 300);
        expect(measured.commentary).toContain('35.0% of the total');
        expect(measured.description).toContain('(6 buckets of 40)');
    });

    it('names the groups returned when the total could not be measured', () => {
        const unmeasured = evaluateAggregationQuality(plan, data, { status: 'partial', groupCount: 40, overallTotal: null });
        expect(unmeasured.commentary).toContain('of the groups returned');
        expect(unmeasured.commentary).not.toContain('of the total');
    });
});

describe('narrative inputs of the executive and initial summaries', () => {
    const card = (groupCoverage: AnalysisCardGroupCoverage | undefined): AnalysisCardData => ({
        id: 'c',
        plan: { title: 'Sum Value by Data Series', description: '', chartType: 'bar', aggregation: 'sum', groupByColumn: 'DataSeries', valueColumn: 'total_value' },
        aggregatedData: rows(10, 8, 6),
        summary: { language: 'English', text: 'Summary' },
        displayChartType: 'bar',
        isDataVisible: false,
        topN: null,
        hideOthers: false,
        groupCoverage,
    });

    it('carry the scope note of a cut-off ranking and nothing for a complete one', () => {
        const [cutOffInput] = buildNarrativeAnalysisIrInputList([card({ status: 'partial', groupCount: 9, overallTotal: 30 })]);
        expect(cutOffInput.scopeNote).toContain('The total over all groups is 30');
        const [completeInput] = buildNarrativeAnalysisIrInputList([card(undefined)]);
        expect(completeInput).not.toHaveProperty('scopeNote');
    });
});
