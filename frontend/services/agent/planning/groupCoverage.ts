import type {
    AnalysisCardGroupCoverage,
    CsvRow,
    DataQueryResult,
    QueryAggregateClause,
    SqlEvidenceQueryPlan,
} from '../../../types';
import { parseNullableNumericValue } from '../../../utils/dataHelpers';
import { isVolumeCheckCancellation } from './volumeDrivenSum';

/**
 * A ranked evidence query returns only its first `limit` groups, so the sum of
 * its rows is not the total of the measure: with 52 groups and a limit of 10
 * the rows hold 74% of it, and a share computed against them is overstated.
 *
 * For an additive aggregate (SUM, COUNT) the true total is one more read-only
 * aggregate over the same population, with no grouping and no limit. It is
 * measured only when the query was actually cut off; a result that holds every
 * group already carries its own total.
 */

export const GROUP_TOTAL_ALIAS = 'group_coverage_total';
export const GROUP_COUNT_ALIAS = 'group_coverage_group_count';

/** Value-gate reasons for measures that must not be added across series: a total over them means nothing. */
export const SERIES_NON_ADDITIVE_REASON_CODES: ReadonlySet<string> = new Set([
    'cross_series_aggregate',
    'series_hierarchy_double_count',
    'mixed_unit_series_comparison',
    'series_hierarchy_mix',
]);

const ADDITIVE_FUNCTIONS = new Set<QueryAggregateClause['function']>(['sum', 'count']);
/** Rounding noise of summing floats in a different order. */
const TOTAL_TOLERANCE = 1e-6;

const findRowKey = (row: CsvRow | undefined, column: string): string => {
    if (!row || column in row) return column;
    const lower = column.toLowerCase();
    return Object.keys(row).find(key => key.toLowerCase() === lower) ?? column;
};

/** The aggregate the card shows: the bound value column when it names one, else the first. */
const resolveCardAggregate = (plan: SqlEvidenceQueryPlan, valueColumn?: string | null): QueryAggregateClause | null => {
    const aggregates = plan.query.aggregates ?? [];
    const key = valueColumn?.trim().toLowerCase();
    return (key ? aggregates.find(aggregate => aggregate.as.trim().toLowerCase() === key) : undefined) ?? aggregates[0] ?? null;
};

/**
 * The total check applies to a grouped aggregate evidence query whose shown
 * measure is a SUM or COUNT. A post-aggregate filter (HAVING) defines "all
 * groups" differently from the plain population, so it is left unmeasured.
 */
export const buildGroupTotalCheckPlan = (
    plan: SqlEvidenceQueryPlan,
    valueColumn?: string | null,
): SqlEvidenceQueryPlan | null => {
    const query = plan.query;
    if (plan.queryMode !== 'aggregate' || query.rawSql || !query.groupBy?.length || query.postAggregateFilter) return null;
    const aggregate = resolveCardAggregate(plan, valueColumn);
    if (!aggregate || !ADDITIVE_FUNCTIONS.has(aggregate.function)) return null;
    return {
        title: `Total check for ${plan.title}`,
        queryMode: 'aggregate',
        intentSummary: 'Total of the shown measure over every group, ignoring the group limit.',
        query: {
            select: [GROUP_TOTAL_ALIAS],
            // Same population as the evidence query: its filters, and the plan's pre-filter below.
            ...(query.where ? { where: query.where } : {}),
            aggregates: [{ ...aggregate, as: GROUP_TOTAL_ALIAS }],
            limit: 1,
        },
        ...(plan.preFilter ? { preFilter: plan.preFilter } : {}),
    };
};

/**
 * A cut-off ranking of a non-additive measure (median, average, min, max) has
 * no total, but its group count is a fact: one distinct count over the same
 * population, without grouping or limit. A single group column is needed to
 * count; groups with a missing label are not counted by it.
 */
export const buildGroupCountCheckPlan = (plan: SqlEvidenceQueryPlan): SqlEvidenceQueryPlan | null => {
    const query = plan.query;
    if (plan.queryMode !== 'aggregate' || query.rawSql || query.groupBy?.length !== 1 || query.postAggregateFilter) return null;
    return {
        title: `Group count for ${plan.title}`,
        queryMode: 'aggregate',
        intentSummary: 'Number of distinct groups the shown measure is ranked over, ignoring the group limit.',
        query: {
            select: [GROUP_COUNT_ALIAS],
            ...(query.where ? { where: query.where } : {}),
            aggregates: [{ function: 'count_distinct', column: query.groupBy[0], as: GROUP_COUNT_ALIAS }],
            limit: 1,
        },
        ...(plan.preFilter ? { preFilter: plan.preFilter } : {}),
    };
};

type CoverageResult = Pick<DataQueryResult, 'rows'> & Partial<Pick<DataQueryResult, 'totalMatchedRows' | 'truncated' | 'appliedLimit'>>;

/**
 * Whether groups were cut off by the query limit. The engine reports
 * `truncated` and the matched group count; a result without them is treated as
 * cut off when it filled the limit exactly.
 */
export const isGroupResultTruncated = (result: CoverageResult): boolean => {
    const returned = result.rows.length;
    if (typeof result.truncated === 'boolean' && Number.isFinite(result.totalMatchedRows)) {
        return result.truncated || (result.totalMatchedRows as number) > returned;
    }
    return Number.isFinite(result.appliedLimit) && returned >= (result.appliedLimit as number);
};

const sumRows = (rows: readonly CsvRow[], key: string): { total: number; hasNegative: boolean } => {
    let total = 0;
    let hasNegative = false;
    rows.forEach(row => {
        const value = parseNullableNumericValue(row[key]);
        if (value === null) return;
        total += value;
        if (value < 0) hasNegative = true;
    });
    return { total, hasNegative };
};

/**
 * Records what the result's rows cover. Returns null when the plan is not a
 * grouped additive aggregate (nothing to claim about a share), `complete` when
 * the query returned every group, and `partial` otherwise, with the measured
 * overall total when the companion query succeeds. A failed companion query
 * leaves a `partial` coverage without a total; a cancellation is rethrown.
 */
export const measureGroupCoverage = async (
    plan: SqlEvidenceQueryPlan,
    result: CoverageResult,
    runQuery: (checkPlan: SqlEvidenceQueryPlan) => Promise<{ result: { rows: CsvRow[] } }>,
    options: { valueColumn?: string | null; signal?: AbortSignal; totalSuppressed?: boolean } = {},
): Promise<AnalysisCardGroupCoverage | null> => {
    const aggregate = resolveCardAggregate(plan, options.valueColumn);
    if (plan.queryMode !== 'aggregate' || plan.query.rawSql || !plan.query.groupBy?.length || !aggregate) return null;
    if (!ADDITIVE_FUNCTIONS.has(aggregate.function)) {
        return measureNonAdditiveGroupCount(plan, result, runQuery, options.signal);
    }
    const valueKey = findRowKey(result.rows[0], aggregate.as);
    const shown = sumRows(result.rows, valueKey);
    if (!isGroupResultTruncated(result)) {
        return { status: 'complete', groupCount: result.rows.length, overallTotal: shown.total };
    }
    // A matched count equal to the returned rows is the engine reporting only what it returned.
    const matched = result.totalMatchedRows;
    const groupCount = typeof matched === 'number' && Number.isFinite(matched) && matched > result.rows.length ? matched : null;
    const unmeasured: AnalysisCardGroupCoverage = { status: 'partial', groupCount, overallTotal: null };

    const checkPlan = options.totalSuppressed ? null : buildGroupTotalCheckPlan(plan, options.valueColumn);
    if (!checkPlan) return unmeasured;
    try {
        const execution = await runQuery(checkPlan);
        const row = execution.result.rows[0];
        const overallTotal = row ? parseNullableNumericValue(row[GROUP_TOTAL_ALIAS]) : null;
        if (overallTotal === null) return unmeasured;
        // With only non-negative groups the total cannot be below the rows already shown;
        // a smaller one means the two queries did not read the same data.
        if (!shown.hasNegative && overallTotal < shown.total - TOTAL_TOLERANCE * Math.max(1, Math.abs(shown.total))) {
            return unmeasured;
        }
        return { status: 'partial', groupCount, overallTotal };
    } catch (error) {
        if (isVolumeCheckCancellation(error, options.signal)) throw error;
        return unmeasured;
    }
};

/** Coverage of a non-additive ranking: only the group count, never a total or a share. Null when nothing was cut off. */
const measureNonAdditiveGroupCount = async (
    plan: SqlEvidenceQueryPlan,
    result: CoverageResult,
    runQuery: (checkPlan: SqlEvidenceQueryPlan) => Promise<{ result: { rows: CsvRow[] } }>,
    signal?: AbortSignal,
): Promise<AnalysisCardGroupCoverage | null> => {
    if (!isGroupResultTruncated(result)) return null;
    const matched = result.totalMatchedRows;
    const reported = typeof matched === 'number' && Number.isFinite(matched) && matched > result.rows.length ? matched : null;
    const unmeasured: AnalysisCardGroupCoverage = { status: 'partial', groupCount: reported, overallTotal: null };
    if (reported !== null) return unmeasured;
    const checkPlan = buildGroupCountCheckPlan(plan);
    if (!checkPlan) return unmeasured;
    try {
        const execution = await runQuery(checkPlan);
        const row = execution.result.rows[0];
        const groupCount = row ? parseNullableNumericValue(row[GROUP_COUNT_ALIAS]) : null;
        // A count below the rows already returned means the two queries did not read the same data.
        return groupCount !== null && groupCount >= result.rows.length ? { ...unmeasured, groupCount } : unmeasured;
    } catch (error) {
        if (isVolumeCheckCancellation(error, signal)) throw error;
        return unmeasured;
    }
};
