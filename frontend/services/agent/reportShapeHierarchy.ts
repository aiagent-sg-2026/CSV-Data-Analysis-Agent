import type { CsvRow, RowRole, RowRoleCandidate } from '../../types';
import {
    buildUniqueSeriesKeys,
    measureIndent,
    resolvePeriodWideHierarchy,
    verifyParentSum,
    type PeriodWideRowClass,
} from './reportShapePeriodWide';
import {
    getNonEmptyValues,
    getRowCells,
    isBlankRow,
    isFooterLikeRow,
    isNumericLike,
    SUBTOTAL_ROW_PATTERN,
    TOTAL_ROW_PATTERN,
    type IndexedCell,
} from './reportShapeUtils';
import type { HeaderLayoutCandidate } from './reportShapeHeaderBands';
import type { RowRoleSignalBundle } from './runtime/rowRoleSignals';

const STRUCTURAL_IDENTIFIER_COLUMN_PATTERN = /\b(?:code|id)\b/i;
// A hierarchical/WBS-style item code ("14.01") carries 2+ decimal digits;
// its section/category-level ancestor ("14" or "14.0") carries at most 1.
// Narrow, data-driven carve-out — only fires for codes already matching
// this specific decimal-precision convention (common in cost/budget
// reports), so it never reclassifies non-numeric or single-segment codes.
const LEAF_HIERARCHY_CODE_PATTERN = /^\d+\.\d{2,}$/;

const hasLeafHierarchyCode = (
    cells: IndexedCell[],
    layout: HeaderLayoutCandidate,
) => layout.descriptorColumnIndexes.some((columnIndex, position) => (
    STRUCTURAL_IDENTIFIER_COLUMN_PATTERN.test(layout.descriptorColumns[position] ?? '')
    && LEAF_HIERARCHY_CODE_PATTERN.test((cells[columnIndex]?.value ?? '').trim())
));

export const detectMatrixRowRole = (
    row: CsvRow | undefined,
    layout: HeaderLayoutCandidate | null,
    signalBundle?: RowRoleSignalBundle | null,
): { role: RowRole; confidence: number } => {
    if (!row) return { role: 'unknown', confidence: 0 };
    if (isBlankRow(row) || isFooterLikeRow(row)) return { role: 'noise', confidence: 0.98 };
    const values = getNonEmptyValues(row);
    // Structural: singleton long text at document edge → comment.
    if (signalBundle?.sparsity.isSingletonLongText && signalBundle.sparsity.isDocumentEdge) {
        return { role: 'comment', confidence: 0.84 };
    }
    // Structural: singleton long text → comment.
    if (values.length === 1 && values[0].length >= 16) {
        return { role: 'comment', confidence: 0.82 };
    }
    // Structural: sparse non-numeric row with colon key-value or long text → comment.
    // Uses /:.+/ to require content after colon — avoids matching trailing-colon section labels.
    if (values.length <= 2 && !values.some(isNumericLike)
        && (values.some(v => /:.+/.test(v)) || values.join(' ').length >= 30)) {
        return { role: 'comment', confidence: 0.76 };
    }
    if (!layout) return { role: 'unknown', confidence: 0.2 };
    const cells = getRowCells(row);
    const descriptorValues = layout.descriptorColumnIndexes.map(index => cells[index]?.value ?? '').filter(Boolean);
    const numericCount = layout.detailSeriesIndexes.filter(index => isNumericLike(cells[index]?.value ?? '')).length;
    // Structural signal first, regex fallback for subtotal/total.
    if (signalBundle?.sumVerification.sumMatchType === 'section_subtotal'
        || descriptorValues.some(value => SUBTOTAL_ROW_PATTERN.test(value.trim()))) {
        return { role: 'subtotal', confidence: 0.92 };
    }
    if (signalBundle?.sumVerification.sumMatchType === 'grand_total'
        || descriptorValues.some(value => TOTAL_ROW_PATTERN.test(value.trim()))) {
        return { role: 'total', confidence: 0.94 };
    }
    if (numericCount === 0 && descriptorValues.length > 0) {
        // GAP-3 residual fix (2026-07-24): a hierarchical WBS-style item code
        // is a leaf item's identity even with every fact value blank — only
        // a coarser section/category code is a genuine heading.
        if (hasLeafHierarchyCode(cells, layout)) {
            return { role: 'fact', confidence: 0.6 };
        }
        return { role: 'group_header', confidence: 0.75 };
    }
    if (numericCount > 0 && descriptorValues.length > 0) {
        return { role: 'fact', confidence: 0.88 };
    }
    // GAP-3 fix: numeric continuation rows with no descriptor text are
    // carry-forward details (the section identity lives on a prior row),
    // not unknowns — e.g. per-customer item rows in grouped sales reports.
    if (numericCount > 0) {
        return { role: 'fact', confidence: 0.6 };
    }
    return { role: 'unknown', confidence: 0.25 };
};

export const assignHierarchyDepths = (rowRoles: RowRoleCandidate[]): RowRoleCandidate[] => {
    let activeDepth = 0;
    return rowRoles.map(candidate => {
        if (!['group_header', 'fact', 'subtotal', 'total'].includes(candidate.role)) {
            return candidate;
        }
        if (candidate.role === 'group_header') {
            activeDepth += 1;
            return { ...candidate, depth: activeDepth };
        }
        if (candidate.role === 'fact') {
            return { ...candidate, depth: activeDepth };
        }
        if (candidate.role === 'subtotal') {
            const depth = activeDepth;
            activeDepth = Math.max(0, activeDepth - 1);
            return { ...candidate, depth };
        }
        const depth = activeDepth;
        activeDepth = 0;
        return { ...candidate, depth: Math.max(0, depth) };
    });
};

export interface IndentHierarchyEvidence {
    /** Parents (rows followed by deeper-indented rows) whose numbers could be compared with their children. */
    parentsChecked: number;
    /** Checked parents whose published values equal the sum of their children. */
    parentsVerified: number;
    levels: number;
}

export interface IndentHierarchyEntry {
    /** Label with indentation trimmed, made unique across repeats (same convention as the melted path). */
    key: string;
    level: number;
    parentKey: string | null;
    rowClass: PeriodWideRowClass;
}

// A parent counts as verified when most of its comparable measure columns
// equal the sum of its children; non-additive columns (unit prices, rates)
// are allowed to disagree.
const MIN_PARENT_COLUMN_MATCH = 0.5;
// Indentation is accepted as a hierarchy only when nearly every comparable
// parent reconciles. Cosmetic leading spaces never reconcile.
const MIN_VERIFIED_PARENT_SHARE = 0.8;

/**
 * Resolves a parent/child hierarchy from label indentation in a row table
 * (for example "Region / Country / Customer" with 4 spaces per level) and
 * only accepts it when the published parent values reconcile with the sum of
 * their children. Returns null when the labels carry no indentation, the
 * indentation does not form a tree, or the numbers contradict it.
 *
 * `rows[i]` holds the numeric measures of label i, or null for a heading row
 * that has none.
 */
export const resolveIndentHierarchy = (params: {
    labels: string[];
    rows: Array<CsvRow | null>;
    measureColumns: string[];
}): { entries: IndentHierarchyEntry[]; evidence: IndentHierarchyEvidence } | null => {
    const { labels, rows, measureColumns } = params;
    if (labels.length < 3 || measureColumns.length === 0) return null;
    if (new Set(labels.map(measureIndent)).size < 2) return null;
    const hierarchy = resolvePeriodWideHierarchy(labels);
    if (!hierarchy || hierarchy.every(entry => entry.parentIndex === null)) return null;

    const childrenByParent = new Map<number, number[]>();
    hierarchy.forEach((entry, index) => {
        if (entry.parentIndex === null) return;
        childrenByParent.set(entry.parentIndex, [...(childrenByParent.get(entry.parentIndex) ?? []), index]);
    });
    let parentsChecked = 0;
    let parentsVerified = 0;
    childrenByParent.forEach((childIndexes, parentIndex) => {
        const parentRow = rows[parentIndex];
        const childRows = childIndexes.map(index => rows[index]).filter((row): row is CsvRow => row !== null);
        if (!parentRow || childRows.length === 0) return;
        const { checked, matched } = verifyParentSum(parentRow, childRows, measureColumns);
        if (checked === 0) return;
        parentsChecked += 1;
        if (matched / checked >= MIN_PARENT_COLUMN_MATCH) parentsVerified += 1;
    });
    if (parentsChecked === 0 || parentsVerified / parentsChecked < MIN_VERIFIED_PARENT_SHARE) return null;

    const keys = buildUniqueSeriesKeys(labels.map(label => label.trim()), hierarchy);
    return {
        entries: hierarchy.map((entry, index) => ({
            key: keys[index],
            level: entry.level,
            parentKey: entry.parentIndex === null ? null : keys[entry.parentIndex],
            rowClass: entry.rowClass,
        })),
        evidence: {
            parentsChecked,
            parentsVerified,
            levels: Math.max(...hierarchy.map(entry => entry.level)) + 1,
        },
    };
};
