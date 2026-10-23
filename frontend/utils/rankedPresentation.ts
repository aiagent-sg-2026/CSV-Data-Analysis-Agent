import type { AnalysisPlan, CsvRow, QueryPlan } from '../types';
import { parseNullableNumericValue } from './dataHelpers';
import { isTemporalDisplayColumn } from './temporalDisplay';

/**
 * Ranking direction shared by the card chart, table, top-N window and KPI
 * headline. The evidence query decides it: a query ordered ascending by its
 * measure asks for the lowest groups, so every view must keep the lowest first
 * instead of re-sorting to the largest values.
 */
export type RankDirection = 'asc' | 'desc';

const normalizeKey = (value: string | undefined | null): string => String(value ?? '').trim().toLowerCase();

/**
 * Returns the direction of the query's leading sort when that sort ranks the
 * measure (an aggregate alias or the bound value column). A sort on the group
 * label, or no sort, says nothing about the ranking and returns undefined.
 */
export const resolveRankDirectionFromQuery = (
    query: Pick<QueryPlan, 'orderBy' | 'aggregates'> | null | undefined,
    valueColumn?: string | null,
): RankDirection | undefined => {
    const leading = query?.orderBy?.[0];
    if (!leading || (leading.direction !== 'asc' && leading.direction !== 'desc')) return undefined;
    const orderKey = normalizeKey(leading.column);
    const aliases = (query?.aggregates ?? []).map(aggregate => normalizeKey(aggregate.as));
    const valueKey = normalizeKey(valueColumn);
    // When the bound value column is one of several aggregates, only a sort on
    // that aggregate ranks what the card shows.
    const ranksMeasure = valueKey && aliases.includes(valueKey)
        ? orderKey === valueKey
        : orderKey === valueKey || (aliases.length > 0 && orderKey === aliases[0]);
    return ranksMeasure ? leading.direction : undefined;
};

/** A measure cell as a number, or null when it is empty or not numeric (e.g. a NULL median). */
const toRankValue = (value: unknown): number | null => parseNullableNumericValue(value);

/**
 * Stable sort by the measure; the default is the existing largest-first
 * ranking. Groups without a value go last in either direction, so a NULL
 * median never leads a lowest-first ranking as if it were zero.
 */
export const rankRowsByValue = <T extends CsvRow>(
    rows: readonly T[],
    valueKey: string,
    direction: RankDirection | undefined,
): T[] => {
    const sign = direction === 'asc' ? 1 : -1;
    return rows
        .map((row, index) => ({ row, index, value: toRankValue(row[valueKey]) }))
        .sort((left, right) => {
            if (left.value === null || right.value === null) {
                return (left.value === null ? 1 : 0) - (right.value === null ? 1 : 0) || left.index - right.index;
            }
            return (left.value - right.value) * sign || left.index - right.index;
        })
        .map(entry => entry.row);
};

export interface TiedLeadingWindow {
    /** Number of leading groups shown in the window, all with the same value. */
    count: number;
    value: number;
    /** Groups in the full result that share the tied value (at least `count`). */
    tiedGroupCount: number;
    totalGroupCount: number;
}

/**
 * Detects a ranked window whose shown groups all carry one value, such as a
 * "Top 8" view where every bar is 3,000. Such a window does not rank anything,
 * and when more groups share the value the choice of which ones are shown is
 * arbitrary. Returns null when the window has fewer than two groups, covers the
 * whole result, or its values differ.
 */
export const detectTiedLeadingWindow = (
    rankedRows: readonly CsvRow[],
    valueKey: string,
    windowSize: number | null | undefined,
): TiedLeadingWindow | null => {
    if (!windowSize || windowSize < 2 || rankedRows.length <= windowSize) return null;
    const values = rankedRows.map(row => toRankValue(row[valueKey]));
    const leadingValue = values[0];
    if (leadingValue === null || !values.slice(0, windowSize).every(value => value === leadingValue)) return null;
    return {
        count: windowSize,
        value: leadingValue,
        tiedGroupCount: values.filter(value => value === leadingValue).length,
        totalGroupCount: values.length,
    };
};

/**
 * The row key that holds the card's measure. SQL-first cards may name the
 * aggregate alias (e.g. "Sum Total") differently from plan.valueColumn, so the
 * key is reconciled against the rows.
 */
export const resolveCardValueKey = (
    plan: Pick<AnalysisPlan, 'valueColumn' | 'groupByColumn'> | null | undefined,
    rows: readonly CsvRow[] | null | undefined,
): string => {
    const planned = plan?.valueColumn || 'count';
    if (!rows?.length) return planned;
    if (planned in rows[0]) return planned;

    const groupBy = plan?.groupByColumn;
    const columns = Object.keys(rows[0]);
    const plannedLower = planned.toLowerCase();
    const aliasMatch = columns.find(column => {
        if (column === groupBy) return false;
        const columnLower = column.toLowerCase();
        return columnLower === plannedLower
            || columnLower.endsWith(` ${plannedLower}`)
            || columnLower.startsWith(`${plannedLower} `);
    });
    if (aliasMatch) return aliasMatch;

    const numericColumn = columns.find(column => column !== groupBy && typeof rows[0][column] === 'number');
    return numericColumn || planned;
};

/**
 * A non-additive measure compared across categories (median, average, ...) is
 * shown as a ranking. Additive measures fold a remainder into "Others", and
 * time-ordered views keep their sequence.
 */
export const isRankedMeasureView = (
    plan: Pick<AnalysisPlan, 'aggregation' | 'chartType'> | null | undefined,
    groupByKey: string,
    isAdditive: (aggregation: AnalysisPlan['aggregation']) => boolean,
): boolean => Boolean(plan?.aggregation
    && !isAdditive(plan.aggregation)
    && !isTemporalDisplayColumn(groupByKey)
    && !['line', 'area', 'multi_line'].includes(plan.chartType));
