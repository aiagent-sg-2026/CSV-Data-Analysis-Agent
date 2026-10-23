import type { AnalysisCardData, AnalysisCardGroupCoverage } from '../types';
import { isAdditiveAggregation } from './analysisCardPresentation';
import { parseNumericValue } from './dataHelpers';
import { resolveCardValueKey } from './rankedPresentation';

export interface CardGroupTotals {
    /**
     * The total over every group the query matched: the base of every share and
     * the card's "Overall". Null when a cut-off result could not be measured, so
     * no share may be shown. Always null for non-additive measures.
     */
    overallTotal: number | null;
    /** Groups the query matched; null when unknown. Equals the row count when complete. */
    matchedGroupCount: number | null;
    /** True when the card rows are every matched group. */
    complete: boolean;
}

/**
 * Resolves the totals a card may state. Only an additive measure (SUM, COUNT)
 * has a total at all. Cards without recorded coverage (saved earlier, or
 * aggregated in the client from every row) are complete by construction, and so
 * is a view the user narrowed with a filter: its scope is the filter, which the
 * card names.
 */
export const resolveCardGroupTotals = (params: {
    additive: boolean;
    coverage: AnalysisCardGroupCoverage | null | undefined;
    /** Sum of the card rows (after the card filter). */
    rowsTotal: number;
    rowCount: number;
    filterActive: boolean;
}): CardGroupTotals => {
    const { additive, coverage, rowsTotal, rowCount, filterActive } = params;
    if (!additive) {
        // A cut-off ranking of a non-additive measure has no total or share, but may know how many groups it was cut from.
        return coverage?.status === 'partial' && !filterActive
            ? { overallTotal: null, matchedGroupCount: coverage.groupCount, complete: false }
            : { overallTotal: null, matchedGroupCount: rowCount, complete: true };
    }
    if (!coverage || coverage.status === 'complete' || filterActive) {
        return { overallTotal: rowsTotal, matchedGroupCount: rowCount, complete: true };
    }
    return { overallTotal: coverage.overallTotal, matchedGroupCount: coverage.groupCount, complete: false };
};

const formatForModel = (value: number): string =>
    value.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * One instruction for the summary model when a card shows only the top of a
 * ranking. The model sees the card rows alone, so without it every share it
 * writes would be relative to those rows. Null when the rows are every group.
 */
export const describeCardGroupCoverage = (
    card: Pick<AnalysisCardData, 'plan' | 'aggregatedData' | 'groupCoverage' | 'filter'>,
): string | null => {
    const { plan, aggregatedData, groupCoverage, filter } = card;
    const totals = resolveCardGroupTotals({
        additive: isAdditiveAggregation(plan.aggregation),
        coverage: groupCoverage,
        rowsTotal: 0,
        rowCount: aggregatedData.length,
        filterActive: Boolean(filter?.column && filter.values.length > 0),
    });
    if (totals.complete) return null;
    const valueKey = resolveCardValueKey(plan, aggregatedData);
    const shownTotal = aggregatedData.reduce((sum, row) => sum + parseNumericValue(row[valueKey]), 0);
    const groups = totals.matchedGroupCount !== null ? `${totals.matchedGroupCount} groups` : 'the groups the query matched';
    if (totals.overallTotal === null) {
        return `Scope: these ${aggregatedData.length} rows are only the top of a ranking of ${groups}, and the total over all groups is unknown. `
            + 'Do not state percentages or shares of a total, and do not describe these rows as the whole dataset.';
    }
    return `Scope: these ${aggregatedData.length} rows are only the top of a ranking of ${groups}; together they total ${formatForModel(shownTotal)}. `
        + `The total over all groups is ${formatForModel(totals.overallTotal)}. `
        + `Compute every percentage or share against ${formatForModel(totals.overallTotal)}, never against the rows shown, and do not describe these rows as the whole dataset.`;
};
