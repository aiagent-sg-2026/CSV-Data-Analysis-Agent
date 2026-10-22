import type { CsvRow, QueryPlan, SqlEvidenceQueryPlan } from '../../../types';

/**
 * Detects a SUM comparison whose group ranking is essentially the ranking of
 * how many rows each group has. When one row is one event (a sale, a visit),
 * "total price by group" then mostly says which group had the most events, so
 * it is a weak headline unless the question is explicitly about total volume.
 *
 * The check uses only the computed numbers (per-group SUM and row COUNT), never
 * column names, so it applies the same way to any dataset. When every group
 * has the same row count (for example one row per region per month), the
 * ranking cannot be volume-driven and the check does not apply.
 */

/** Spearman rank correlation at or above this marks the SUM ranking as volume-driven. */
export const VOLUME_DRIVEN_RANK_CORRELATION = 0.9;
/** Fewer groups than this make a rank correlation too unstable to act on. */
export const MIN_VOLUME_CHECK_GROUPS = 4;
/** The companion query reads at most this many groups (largest by row count). */
export const MAX_VOLUME_CHECK_GROUPS = 100;

export const VOLUME_CHECK_SUM_ALIAS = 'volume_check_sum';
export const VOLUME_CHECK_ROWS_ALIAS = 'volume_check_rows';

export interface GroupSumAndCount {
    sum: number;
    count: number;
}

export interface VolumeDependence {
    /** Spearman rank correlation between per-group SUM and per-group row COUNT. */
    rankCorrelation: number;
    groupCount: number;
    volumeDriven: boolean;
}

/** Average ranks (1-based) so that ties do not inflate or deflate the correlation. */
const averageRanks = (values: readonly number[]): number[] => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const ranks = new Array<number>(values.length);
    let start = 0;
    while (start < order.length) {
        let end = start;
        while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
        const rank = (start + end) / 2 + 1;
        for (let position = start; position <= end; position += 1) ranks[order[position].index] = rank;
        start = end + 1;
    }
    return ranks;
};

/** Spearman's rho as the Pearson correlation of average ranks; null when either side has no variation. */
export const spearmanRankCorrelation = (left: readonly number[], right: readonly number[]): number | null => {
    if (left.length !== right.length || left.length < 2) return null;
    const leftRanks = averageRanks(left);
    const rightRanks = averageRanks(right);
    const mean = (left.length + 1) / 2;
    let covariance = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (let index = 0; index < left.length; index += 1) {
        const leftDelta = leftRanks[index] - mean;
        const rightDelta = rightRanks[index] - mean;
        covariance += leftDelta * rightDelta;
        leftVariance += leftDelta * leftDelta;
        rightVariance += rightDelta * rightDelta;
    }
    if (leftVariance === 0 || rightVariance === 0) return null;
    return covariance / Math.sqrt(leftVariance * rightVariance);
};

/**
 * Returns null when the check does not apply: too few groups, or no variation
 * in group size (rows are not one-per-event) or in the sums.
 */
export const assessVolumeDependence = (groups: readonly GroupSumAndCount[]): VolumeDependence | null => {
    const usable = groups.filter(group => Number.isFinite(group.sum) && Number.isFinite(group.count) && group.count > 0);
    if (usable.length < MIN_VOLUME_CHECK_GROUPS) return null;
    const rankCorrelation = spearmanRankCorrelation(usable.map(group => group.sum), usable.map(group => group.count));
    if (rankCorrelation === null) return null;
    return {
        rankCorrelation,
        groupCount: usable.length,
        volumeDriven: rankCorrelation >= VOLUME_DRIVEN_RANK_CORRELATION,
    };
};

/** Companion query: the per-group SUM and row COUNT over the same population as the evidence query. */
export const buildVolumeCheckQuery = (params: {
    dimension: string;
    metric: string;
    where?: QueryPlan['where'];
}): QueryPlan => ({
    select: [params.dimension, VOLUME_CHECK_SUM_ALIAS, VOLUME_CHECK_ROWS_ALIAS],
    ...(params.where ? { where: params.where } : {}),
    groupBy: [params.dimension],
    aggregates: [
        { function: 'sum', column: params.metric, as: VOLUME_CHECK_SUM_ALIAS },
        { function: 'count', as: VOLUME_CHECK_ROWS_ALIAS },
    ],
    orderBy: [{ column: VOLUME_CHECK_ROWS_ALIAS, direction: 'desc' }],
    limit: MAX_VOLUME_CHECK_GROUPS,
});

/**
 * The volume check applies to an aggregate evidence query that compares groups
 * of one dimension by one unconditional SUM. Anything else (no grouping,
 * several dimensions, conditional sums, raw SQL) is left alone.
 */
export const buildVolumeCheckPlan = (plan: SqlEvidenceQueryPlan): SqlEvidenceQueryPlan | null => {
    const query = plan.query;
    if (plan.queryMode !== 'aggregate' || query.rawSql || query.groupBy?.length !== 1) return null;
    const sums = (query.aggregates ?? []).filter(aggregate => aggregate.function === 'sum');
    if (sums.length !== 1 || !sums[0].column || sums[0].where) return null;
    return {
        title: `Volume check for ${plan.title}`,
        queryMode: 'aggregate',
        intentSummary: 'Compare the per-group sum with the per-group row count.',
        query: buildVolumeCheckQuery({ dimension: query.groupBy[0], metric: sums[0].column, where: query.where }),
        ...(plan.preFilter ? { preFilter: plan.preFilter } : {}),
    };
};

/** Reads the companion query rows; non-numeric cells are skipped. */
export const readVolumeCheckRows = (rows: readonly CsvRow[]): GroupSumAndCount[] =>
    rows.map(row => ({ sum: Number(row[VOLUME_CHECK_SUM_ALIAS]), count: Number(row[VOLUME_CHECK_ROWS_ALIAS]) }))
        .filter(group => Number.isFinite(group.sum) && Number.isFinite(group.count));

/**
 * Runs the companion query for a grouped-SUM evidence plan and assesses it.
 * Returns null when the plan is not a grouped SUM, the check does not apply,
 * or the companion query fails; a cancellation is rethrown.
 */
export const measureEvidenceVolumeDependence = async (
    plan: SqlEvidenceQueryPlan,
    runQuery: (checkPlan: SqlEvidenceQueryPlan) => Promise<{ result: { rows: CsvRow[] } }>,
): Promise<{ dependence: VolumeDependence; metric: string; dimension: string } | null> => {
    const checkPlan = buildVolumeCheckPlan(plan);
    if (!checkPlan) return null;
    try {
        const execution = await runQuery(checkPlan);
        const dependence = assessVolumeDependence(readVolumeCheckRows(execution.result.rows));
        if (!dependence) return null;
        return {
            dependence,
            metric: checkPlan.query.aggregates?.[0]?.column ?? '',
            dimension: checkPlan.query.groupBy?.[0] ?? '',
        };
    } catch (error) {
        if ((error as { name?: unknown } | null)?.name === 'AbortError') throw error;
        return null;
    }
};

/** One sentence for users and for the model, stating what the ranking reflects. */
export const describeVolumeDependence = (params: {
    metric: string;
    dimension: string;
    dependence: VolumeDependence;
}): string =>
    `The sum of ${params.metric} ranks the ${params.dependence.groupCount} ${params.dimension} groups almost exactly like their row counts `
    + `(Spearman rank correlation ${params.dependence.rankCorrelation.toFixed(2)}), so the ranking mostly reflects how many rows each group has, not the typical value per row.`;
