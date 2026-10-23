import type { ColumnProfile, ColumnSemanticAnnotation, CsvRow } from '../../types';

/** The four stored values of `UserColumnAnnotation.businessRole`. */
export type SuggestedColumnRole = 'dimension' | 'metric' | 'identifier' | 'helper';

const MAX_SAMPLED_VALUES = 500;
const PLACEHOLDER_NAME = /^_?unnamed(?:_column)?(?:_\d+)?$/i;
// "Invoice No", "ITEM CODE", "Customer ID", "Ref": a name that says "identifier"
// is only believed when the values also behave like identifiers (see below).
const IDENTIFIER_NAME = /(?:^|[^a-z])(?:id|code|no|num|number|ref|reference|sku|uuid|#)(?:[^a-z]|$)/i;
const PERIOD_NAME = /(?:^|[^a-z])(?:year|yr|fy|fiscal|period|month|quarter|qtr)(?:[^a-z]|$)/i;
const MONTH_NAMES = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const DATE_VALUE_PATTERNS = [
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ t]\d{1,2}:\d{2}(?::\d{2})?)?$/i,
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/,
    /^\d{4}[-/]\d{1,2}$/,
    new RegExp(`^\\d{1,2}[ -]${MONTH_NAMES}[ -]\\d{2,4}$`, 'i'),
    new RegExp(`^${MONTH_NAMES}[ -]\\d{2,4}$`, 'i'),
    new RegExp(`^\\d{4}[ -]?${MONTH_NAMES}$`, 'i'),
];
const CODE_LIKE_VALUE = /^(?:[A-Za-z]{1,6}[-_]?\d{2,}|\d{4,}|[A-Z]{2,}(?:[-_][A-Z0-9]+)+)$/;

const isDateValue = (value: string) => DATE_VALUE_PATTERNS.some(pattern => pattern.test(value));

const mapSemanticRole = (role: ColumnSemanticAnnotation['semanticRole']): SuggestedColumnRole | null => {
    switch (role) {
        case 'metric':
            return 'metric';
        case 'date':
        case 'time_dimension':
        case 'business_dimension':
        case 'business_entity':
        case 'entity':
        case 'label':
            return 'dimension';
        case 'code':
            return 'identifier';
        case 'helper_dimension':
        case 'descriptor':
        case 'note':
            return 'helper';
        default:
            return null;
    }
};

const sampleValues = (rows: readonly CsvRow[], column: string): string[] => {
    const values: string[] = [];
    for (const row of rows) {
        const raw = row[column];
        const text = raw === null || raw === undefined ? '' : String(raw).trim();
        if (text) values.push(text);
        if (values.length >= MAX_SAMPLED_VALUES) break;
    }
    return values;
};

const suggestForColumn = (
    profile: ColumnProfile,
    values: string[],
    semantic: ColumnSemanticAnnotation | undefined,
): SuggestedColumnRole | null => {
    if (PLACEHOLDER_NAME.test(profile.name.trim())) return null;

    const semanticRole = semantic && semantic.confidence >= 0.6 ? mapSemanticRole(semantic.semanticRole) : null;
    if (semanticRole) return semanticRole;

    const distinct = new Set(values.map(value => value.toLowerCase())).size;
    const distinctRatio = values.length > 0 ? distinct / values.length : 0;
    const hasSample = values.length >= 2;
    // A column whose name says "ID" or "No." and whose values are (nearly) unique per
    // row is a key, whatever its type: summing invoice numbers is never meaningful.
    if (hasSample && IDENTIFIER_NAME.test(profile.name) && distinctRatio >= 0.6) return 'identifier';

    if (profile.type === 'date' || profile.type === 'time') return 'dimension';
    if (profile.type === 'numerical' || profile.type === 'currency' || profile.type === 'percentage') {
        const looksLikeYear = hasSample
            && PERIOD_NAME.test(profile.name)
            && values.every(value => /^(?:19|20)\d{2}$/.test(value));
        return looksLikeYear ? 'dimension' : 'metric';
    }

    // Categorical (text-typed) columns need the values to tell date, key, label and note apart.
    if (!hasSample) return null;
    const dateShare = values.filter(isDateValue).length / values.length;
    if (dateShare >= 0.8) return 'dimension';
    if (distinct <= 30 || distinctRatio <= 0.5) return 'dimension';
    const averageLength = values.reduce((sum, value) => sum + value.length, 0) / values.length;
    if (averageLength > 40) return 'helper';
    const codeShare = values.filter(value => CODE_LIKE_VALUE.test(value)).length / values.length;
    if (distinctRatio >= 0.9 && codeShare >= 0.6) return 'identifier';
    // Many different short texts without a key-like shape: the app has no evidence either way.
    return null;
};

/**
 * Cheap, evidence-based default for every column's role in the guided-repair dialog:
 * measure, label/date, identifier or helper. A column maps to null when nothing in
 * its type, name or values decides the question, so the user is asked only about those.
 * The result is a display suggestion; it is not written to the user's annotations.
 */
export const suggestColumnRoles = (params: {
    profiles: readonly ColumnProfile[];
    rows: readonly CsvRow[] | null | undefined;
    semanticAnnotations?: readonly ColumnSemanticAnnotation[] | null;
}): Record<string, SuggestedColumnRole | null> => {
    const semanticByName = new Map((params.semanticAnnotations ?? []).map(annotation => [annotation.columnName, annotation]));
    const result: Record<string, SuggestedColumnRole | null> = {};
    for (const profile of params.profiles) {
        result[profile.name] = suggestForColumn(
            profile,
            sampleValues(params.rows ?? [], profile.name),
            semanticByName.get(profile.name),
        );
    }
    return result;
};
