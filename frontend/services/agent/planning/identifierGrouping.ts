import type { ColumnProfile } from '../../../types';
import { isTimeLikeDimensionColumn } from '../analysisColumnRoles';

/**
 * A column that tells every row apart (an invoice number, a product code) is an
 * identifier. Ranking or counting by it gives one-row groups: "Top 8 of 3,200
 * invoices" with every remaining invoice in "Others" at 0.1% each, or a
 * "count per product" where every count is 7. Such a plan is not a finding.
 */

/** Share of rows that carry a distinct value from which a column counts as an identifier. */
export const IDENTIFIER_DISTINCT_SHARE = 0.8;
/** Below this many rows a high distinct share says little (a 10-row table of 8 names is a legitimate list). */
export const IDENTIFIER_MIN_ROWS = 30;

// The reader asked to look records up or list them; a detail table is then the right answer.
const LOOKUP_REQUEST_PATTERN = /\b(look[\s-]?up|details?|detailed|list(?:ing)?\s+(?:of\s+)?(?:all|every)|drill[\s-]?down|find|search\s+for|raw\s+records?|each\s+record|one\s+by\s+one)\b/i;

export const userAskedForLookup = (text: string | null | undefined): boolean =>
    typeof text === 'string' && LOOKUP_REQUEST_PATTERN.test(text);

/** Whether grouping by this column would produce (almost) one group per row. */
export const isIdentifierLikeGrouping = (
    profile: Pick<ColumnProfile, 'name' | 'type' | 'uniqueValues'> | null | undefined,
    rowCount: number | null | undefined,
): boolean => {
    if (!profile || typeof rowCount !== 'number' || rowCount < IDENTIFIER_MIN_ROWS) return false;
    // One row per day or month is a time series, not an identifier.
    if (profile.type === 'date' || profile.type === 'time' || isTimeLikeDimensionColumn(profile.name)) return false;
    return typeof profile.uniqueValues === 'number' && profile.uniqueValues >= IDENTIFIER_DISTINCT_SHARE * rowCount;
};

export interface IdentifierGroupingAssessment {
    decision: 'accept' | 'reject';
    reasonCodes: string[];
    /** Planner-facing explanation used for the replan and as the rejection reason. */
    feedback: string | null;
}

/** Checks the grouping columns of an aggregate plan; `requestText` is the topic or title the reader asked for. */
export const assessIdentifierGrouping = (params: {
    groupBy: readonly string[];
    profiles: readonly ColumnProfile[];
    rowCount: number | null | undefined;
    requestText?: string | null;
}): IdentifierGroupingAssessment => {
    const accept: IdentifierGroupingAssessment = { decision: 'accept', reasonCodes: [], feedback: null };
    if (userAskedForLookup(params.requestText)) return accept;
    for (const column of params.groupBy) {
        const profile = params.profiles.find(candidate => candidate.name === column);
        if (!isIdentifierLikeGrouping(profile, params.rowCount)) continue;
        return {
            decision: 'reject',
            reasonCodes: ['identifier_grouping'],
            feedback: `"${column}" has ${profile!.uniqueValues!.toLocaleString('en-US')} distinct values over ${params.rowCount!.toLocaleString('en-US')} rows, so it identifies single records `
                + 'and every group would hold about one row. Group by a category a reader compares (a customer, a type, a period) instead, '
                + 'or measure the column without grouping by it.',
        };
    }
    return accept;
};
