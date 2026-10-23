/**
 * What a person reads about import data-quality issues.
 *
 * The profiler's issue strings are written for the AI ("Strip commas with
 * replace_values, then cast_column ..."), so they never reach a clerk. Each
 * kind of issue becomes one plain sentence in the user's language, with the
 * affected columns kept apart for people who want the detail.
 */
import { getTranslation } from '../../utils/localization';

export type DataQualityNoteKind =
    | 'mostly_empty'
    | 'thousands_separators'
    | 'decimal_comma'
    | 'apostrophe_numbers'
    | 'other';

export interface DataQualityNote {
    kind: DataQualityNoteKind;
    /** One plain sentence in the user's language. */
    sentence: string;
    /** Affected columns, with the share of missing cells for empty columns. */
    columns: string[];
}

export interface DataQualityEndUserSummary {
    userSummary: string;
    /** Raw diagnostics of issues no plain sentence covers, for people who open the details; null when there are none. */
    technicalDetail: string | null;
    notes: DataQualityNote[];
}

const HIGH_MISSING_VALUE_PATTERN = /^Column '(.+)' has a high percentage of missing values \((\d+)%\)\.$/;
const COMMA_FORMATTED_PATTERN = /^Column '(.+)' contains comma-formatted numbers/;
const DECIMAL_COMMA_PATTERN = /^Column '(.+)' uses decimal commas/;
const APOSTROPHE_PATTERN = /^Column '(.+)' contains apostrophe-prefixed numbers/;

export const buildDataQualityNotes = (issues: readonly string[], language: string = 'English'): DataQualityNote[] => {
    const missing: Array<{ column: string; percentage: string }> = [];
    const thousands: string[] = [];
    const decimalComma: string[] = [];
    const apostrophe: string[] = [];
    const other: string[] = [];

    for (const issue of issues) {
        const missingMatch = issue.match(HIGH_MISSING_VALUE_PATTERN);
        const thousandsMatch = issue.match(COMMA_FORMATTED_PATTERN);
        const decimalMatch = issue.match(DECIMAL_COMMA_PATTERN);
        const apostropheMatch = issue.match(APOSTROPHE_PATTERN);
        if (missingMatch) missing.push({ column: missingMatch[1], percentage: missingMatch[2] });
        else if (thousandsMatch) thousands.push(thousandsMatch[1]);
        else if (decimalMatch) decimalComma.push(decimalMatch[1]);
        else if (apostropheMatch) apostrophe.push(apostropheMatch[1]);
        else other.push(issue);
    }

    const notes: DataQualityNote[] = [];
    if (missing.length > 0) {
        notes.push({
            kind: 'mostly_empty',
            sentence: getTranslation('dq_note_mostly_empty', language, { count: missing.length }),
            columns: missing.map(entry => `${entry.column} (${entry.percentage}%)`),
        });
    }
    if (thousands.length > 0) {
        notes.push({ kind: 'thousands_separators', sentence: getTranslation('dq_note_thousands', language), columns: thousands });
    }
    if (decimalComma.length > 0) {
        notes.push({ kind: 'decimal_comma', sentence: getTranslation('dq_note_decimal_comma', language), columns: decimalComma });
    }
    if (apostrophe.length > 0) {
        notes.push({ kind: 'apostrophe_numbers', sentence: getTranslation('dq_note_apostrophe', language), columns: apostrophe });
    }
    if (other.length > 0) {
        notes.push({
            kind: 'other',
            sentence: getTranslation('dq_note_other', language, { count: other.length }),
            columns: [],
        });
    }
    return notes;
};

const MAX_COLUMNS_SHOWN = 3;

/** "A, B, C +2": the first few columns of a note. */
export const formatNoteColumns = (columns: readonly string[]): string => {
    const shown = columns.slice(0, MAX_COLUMNS_SHOWN).join(', ');
    const remainder = columns.length - MAX_COLUMNS_SHOWN;
    return remainder > 0 ? `${shown} +${remainder}` : shown;
};

export const summarizeDataQualityForEndUser = (
    issues: readonly string[],
    language: string = 'English',
): DataQualityEndUserSummary | null => {
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const notes = buildDataQualityNotes(issues, language);
    const knownIssues = issues.filter(issue =>
        HIGH_MISSING_VALUE_PATTERN.test(issue) || COMMA_FORMATTED_PATTERN.test(issue)
        || DECIMAL_COMMA_PATTERN.test(issue) || APOSTROPHE_PATTERN.test(issue));
    const unknownIssues = issues.filter(issue => !knownIssues.includes(issue));
    return {
        userSummary: notes.map(note => note.sentence).join(' '),
        // Known kinds already list their columns on the note; only unrecognised diagnostics stay raw.
        technicalDetail: unknownIssues.length > 0 ? unknownIssues.join(' | ') : null,
        notes,
    };
};
