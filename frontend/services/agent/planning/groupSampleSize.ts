import type {
    CsvRow,
    EvidenceSampleSizeCaveat,
    EvidenceSmallGroupLeader,
    QueryAggregateClause,
    SqlEvidenceQueryPlan,
} from '../../../types';
import { rankRowsByValue, resolveRankDirectionFromQuery } from '../../../utils/rankedPresentation';
import { isTimeDimension, isVolumeCheckCancellation, type TimeDimensionContext } from './volumeDrivenSum';

/**
 * Detects a ranking whose leading groups rest on very few source rows, such as
 * a "median price by storey range" card led by a range with two sales. The
 * value is computed correctly, but a reader takes the leader as typical, so the
 * card carries a visible caveat and is not used as a trusted headline.
 *
 * The check uses only the per-group counts of a read-only companion COUNT
 * query over the same population, never column names. It counts the rows with
 * a reported value of the ranked measure, since a group of 40 rows with 38
 * missing (`na`) values is a median of two.
 */

/** Groups with fewer rows than this are always thin. */
export const SMALL_GROUP_MIN_ROWS = 5;
/** A group below this share of the median group size is thin relative to its peers. */
export const SMALL_GROUP_MEDIAN_FRACTION = 0.1;
/** The relative threshold never exceeds this many rows, so large datasets do not flag adequate groups. */
export const SMALL_GROUP_RELATIVE_CAP_ROWS = 30;
/** Only the leading positions of the ranking are checked: the leader and its closest followers. */
export const SAMPLE_SIZE_LEADING_GROUPS = 3;
/** The companion query reads at most this many groups. */
export const MAX_SAMPLE_SIZE_CHECK_GROUPS = 1000;

export const SAMPLE_SIZE_ROWS_ALIAS = 'sample_size_rows';

const COUNT_FUNCTIONS = new Set<QueryAggregateClause['function']>(['count', 'count_distinct']);

const normalizeLabel = (value: unknown): string => String(value ?? '').trim();

const findRowKey = (row: CsvRow | undefined, column: string): string => {
    if (!row || column in row) return column;
    const lower = column.toLowerCase();
    return Object.keys(row).find(key => key.toLowerCase() === lower) ?? column;
};

/** The aggregate the card ranks: the one the query sorts by, else the first. */
const resolveRankedAggregate = (plan: SqlEvidenceQueryPlan): QueryAggregateClause | null => {
    const aggregates = plan.query.aggregates ?? [];
    const orderKey = plan.query.orderBy?.[0]?.column?.trim().toLowerCase();
    return aggregates.find(aggregate => aggregate.as.trim().toLowerCase() === orderKey) ?? aggregates[0] ?? null;
};

/**
 * The check applies to an aggregate evidence query that compares groups of one
 * non-time dimension by one unconditional non-count measure. A COUNT leader is
 * by definition the largest group, and conditional aggregates count a
 * different population than the companion query would.
 */
export const buildSampleSizeCheckPlan = (
    plan: SqlEvidenceQueryPlan,
    timeContext: TimeDimensionContext = {},
): SqlEvidenceQueryPlan | null => {
    const query = plan.query;
    if (plan.queryMode !== 'aggregate' || query.rawSql || query.groupBy?.length !== 1) return null;
    if (plan.preferredResultShape === 'time_series' || isTimeDimension(query.groupBy[0], timeContext)) return null;
    const ranked = resolveRankedAggregate(plan);
    if (!ranked || COUNT_FUNCTIONS.has(ranked.function) || ranked.where) return null;
    const dimension = query.groupBy[0];
    return {
        title: `Sample size check for ${plan.title}`,
        queryMode: 'aggregate',
        intentSummary: 'Count the source rows with a reported value behind each compared group.',
        query: {
            select: [dimension, SAMPLE_SIZE_ROWS_ALIAS],
            ...(query.where ? { where: query.where } : {}),
            groupBy: [dimension],
            aggregates: [{ function: 'count', ...(ranked.column ? { column: ranked.column } : {}), as: SAMPLE_SIZE_ROWS_ALIAS }],
            orderBy: [{ column: SAMPLE_SIZE_ROWS_ALIAS, direction: 'desc' }],
            limit: MAX_SAMPLE_SIZE_CHECK_GROUPS,
        },
        ...(plan.preFilter ? { preFilter: plan.preFilter } : {}),
    };
};

const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/** The row count below which a leading group is flagged, given the median group size. */
export const resolveMinAdequateRows = (medianGroupRows: number): number =>
    Math.max(SMALL_GROUP_MIN_ROWS, Math.min(SMALL_GROUP_RELATIVE_CAP_ROWS, Math.ceil(medianGroupRows * SMALL_GROUP_MEDIAN_FRACTION)));

/**
 * Flags the leading groups (in the query's ranking direction) that have fewer
 * rows than the threshold. Returns null when no leader is thin, or when the
 * typical group is itself below the absolute floor: then the comparison is at
 * row grain (for example one row per entity) and no leader is unusually thin.
 */
export const assessSmallGroupLeaders = (params: {
    evidenceRows: readonly CsvRow[];
    dimension: string;
    valueKey: string;
    direction: 'asc' | 'desc' | undefined;
    groupRowCounts: ReadonlyMap<string, number>;
}): EvidenceSampleSizeCaveat | null => {
    const counts = [...params.groupRowCounts.values()].filter(count => Number.isFinite(count) && count > 0);
    if (counts.length < 2 || params.evidenceRows.length === 0) return null;
    const medianGroupRows = median(counts);
    if (medianGroupRows < SMALL_GROUP_MIN_ROWS) return null;
    const minAdequateRows = resolveMinAdequateRows(medianGroupRows);
    const dimensionKey = findRowKey(params.evidenceRows[0], params.dimension);
    const leaders: EvidenceSmallGroupLeader[] = [];
    rankRowsByValue(params.evidenceRows, params.valueKey, params.direction)
        .slice(0, SAMPLE_SIZE_LEADING_GROUPS)
        .forEach((row, index) => {
            const label = normalizeLabel(row[dimensionKey]);
            const rows = params.groupRowCounts.get(label);
            if (rows !== undefined && rows < minAdequateRows) leaders.push({ label, rows, rank: index + 1 });
        });
    return leaders.length > 0 ? { leaders, medianGroupRows, minAdequateRows } : null;
};

/** Reads the companion query rows into label → row count; non-numeric counts are skipped. */
export const readSampleSizeRows = (rows: readonly CsvRow[], dimension: string): Map<string, number> => {
    const dimensionKey = findRowKey(rows[0], dimension);
    const counts = new Map<string, number>();
    rows.forEach(row => {
        const count = Number(row[SAMPLE_SIZE_ROWS_ALIAS]);
        if (Number.isFinite(count)) counts.set(normalizeLabel(row[dimensionKey]), count);
    });
    return counts;
};

/**
 * Runs the companion COUNT query for a grouped evidence plan and assesses its
 * leading groups. Returns null when the check does not apply, finds nothing,
 * or the companion query fails; a cancellation is rethrown.
 */
export const measureLeadingGroupSampleSize = async (
    plan: SqlEvidenceQueryPlan,
    evidenceRows: readonly CsvRow[],
    runQuery: (checkPlan: SqlEvidenceQueryPlan) => Promise<{ result: { rows: CsvRow[] } }>,
    options: TimeDimensionContext & { signal?: AbortSignal } = {},
): Promise<EvidenceSampleSizeCaveat | null> => {
    const checkPlan = buildSampleSizeCheckPlan(plan, options);
    const ranked = resolveRankedAggregate(plan);
    if (!checkPlan || !ranked) return null;
    const dimension = checkPlan.query.groupBy?.[0] ?? '';
    try {
        const execution = await runQuery(checkPlan);
        return assessSmallGroupLeaders({
            evidenceRows,
            dimension,
            valueKey: findRowKey(evidenceRows[0], ranked.as),
            direction: resolveRankDirectionFromQuery(plan.query, ranked.as),
            groupRowCounts: readSampleSizeRows(execution.result.rows, dimension),
        });
    } catch (error) {
        if (isVolumeCheckCancellation(error, options.signal)) throw error;
        return null;
    }
};

/** One sentence for users and for the model, naming the thin leaders. */
export const describeSmallGroupLeaders = (caveat: EvidenceSampleSizeCaveat): string => {
    const leaders = caveat.leaders
        .map(leader => `#${leader.rank} ${leader.label} (${leader.rows} ${leader.rows === 1 ? 'row' : 'rows'})`)
        .join(', ');
    return `Leading groups rest on very few rows: ${leaders}; the median group has ${caveat.medianGroupRows} rows, `
        + `so these values may not be typical.`;
};
