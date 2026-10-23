import { isMissingCellValue } from '../duckdb/dimensionNormalization';

/**
 * Locale-aware reading of numbers stored as text.
 *
 * The separators are ambiguous in isolation: `1,234` is one thousand two
 * hundred thirty-four in the US and 1.234 in Germany, `4.567` the reverse, and
 * `1.234.567` may equally be a European quantity or a part code. Rules:
 *  1. A cell that is only valid in one style decides for itself
 *     (`1.234,56`, `161,30` are decimal comma; `1,234.56`, `1,234,567`,
 *     `12,34,567.89` and `18.50` are decimal point).
 *  2. A cell that fits both styles (`1,234`, `4.567`) is "ambiguous". Cells made
 *     only of dotted thousands groups (`1.234.567`) are "dotted groups": they
 *     read as numbers only inside a column that proves the decimal comma.
 *  3. A column proves the decimal comma only with positive evidence that it is a
 *     measure: at least one clearly decimal-comma cell (`161,30`, `1.234,56`,
 *     a comma followed by 1, 2 or 4+ digits), no US-style cell, and a header that
 *     does not name an identifier (code, id, no, sku, ref, zip, phone...).
 *     Dotted-thousands cells alone never prove it.
 *  4. Without proof an ambiguous cell keeps the US reading. When other columns of
 *     the same dataset prove the decimal comma and none proves the decimal point,
 *     a column that has only ambiguous cells inherits the decimal comma.
 */
export type NumberStyle = 'decimal_point' | 'decimal_comma';
export type NumberTextKind = NumberStyle | 'ambiguous' | 'dotted_groups' | 'plain';

const CURRENCY_AND_PERCENT = /[$\s€£¥%]/g;
// Swiss thousands separator: 1'234.50 or 1’234.50. Mirrored in SQL by
// SWISS_NUMBER_SQL_PATTERN in services/duckdb/queryCompiler.ts.
const SWISS_APOSTROPHE = /(?<=\d)['’](?=\d{3}(?:\D|$))/g;
const NUMERIC_CHARS = /^[\d.,]+$/;
// US grouping by threes (1,234,567) or Indian lakh/crore grouping (12,34,567).
const US_GROUPED_INTEGER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})`;
const US_GROUPED_INTEGER_PATTERN = new RegExp(`^${US_GROUPED_INTEGER}$`);
const US_GROUPED_DECIMAL_PATTERN = new RegExp(`^${US_GROUPED_INTEGER}\\.\\d+$`);

/** Classifies an unsigned run of digits, dots and commas; null when it is not a number. */
export const classifyNumberBody = (body: string): NumberTextKind | null => {
    if (!NUMERIC_CHARS.test(body) || !/\d/.test(body)) return null;
    const commas = body.split(',').length - 1;
    const dots = body.split('.').length - 1;

    if (commas === 0 && dots === 0) return 'plain';

    if (commas > 0 && dots > 0) {
        if (body.lastIndexOf(',') > body.lastIndexOf('.')) {
            return /^\d{1,3}(?:\.\d{3})+,\d+$/.test(body) ? 'decimal_comma' : null;
        }
        return US_GROUPED_DECIMAL_PATTERN.test(body) ? 'decimal_point' : null;
    }

    if (commas > 0) {
        if (commas > 1) return US_GROUPED_INTEGER_PATTERN.test(body) ? 'decimal_point' : null;
        const match = /^(\d+),(\d+)$/.exec(body);
        if (!match) return null;
        const [, before, after] = match;
        // Thousands groups are exactly three digits after a 1-3 digit lead
        // that does not start with zero; anything else is a decimal comma.
        if (after.length !== 3 || before.length > 3 || before.startsWith('0')) return 'decimal_comma';
        return 'ambiguous';
    }

    if (dots > 1) return /^\d{1,3}(?:\.\d{3})+$/.test(body) ? 'dotted_groups' : null;
    const match = /^(\d*)\.(\d*)$/.exec(body);
    if (!match) return null;
    const [, before, after] = match;
    if (after.length !== 3 || before.length === 0 || before.length > 3 || before.startsWith('0')) return 'decimal_point';
    return 'ambiguous';
};

/** A decimal comma that cannot be mistaken for thousands: 1.234,56 or a comma before 1, 2 or 4+ digits. */
const isStrongDecimalCommaBody = (body: string): boolean => {
    if (body.includes('.')) return true;
    const match = /^(\d+),(\d+)$/.exec(body);
    return match !== null && match[2].length !== 3;
};

/**
 * Canonical form of an unsigned number body (digits and at most one `.`), or
 * null when it is not a well-formed number. `style` only resolves ambiguity and
 * is the only thing that lets a dotted-groups body (`1.234.567`) read as a number.
 */
export const canonicalizeNumberBody = (body: string, style?: NumberStyle | null): string | null => {
    const kind = classifyNumberBody(body);
    if (kind === null) return null;
    if (kind === 'plain') return body;
    if (kind === 'dotted_groups') return style === 'decimal_comma' ? body.replace(/\./g, '') : null;
    // Only the two known styles count: callers sometimes pass `.map` indexes by accident.
    const resolved = kind === 'ambiguous' ? (style === 'decimal_comma' ? 'decimal_comma' : 'decimal_point') : kind;
    return resolved === 'decimal_comma'
        ? body.replace(/\./g, '').replace(',', '.')
        : body.replace(/,/g, '');
};

/** Strips currency, percent, spaces and the Swiss apostrophe; keeps sign, digits and separators. */
export const stripNumberDecorations = (text: string): string =>
    text.replace(SWISS_APOSTROPHE, '').replace(CURRENCY_AND_PERCENT, '');

const unsignedBody = (decorated: string) => {
    const signed = /^[+-]/.test(decorated);
    return signed ? decorated.slice(1) : decorated;
};

const cellBody = (value: unknown): string => {
    let text = String(value).trim();
    if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1);
    return unsignedBody(stripNumberDecorations(text));
};

/**
 * Reads the numeric style a single cell proves. Returns null for text that is
 * not a number at all, and 'plain' / 'ambiguous' / 'dotted_groups' when the cell
 * has no decimal-comma or decimal-point evidence of its own.
 */
export const classifyNumberCell = (value: unknown): NumberTextKind | null => {
    if (value === null || value === undefined) return null;
    return classifyNumberBody(cellBody(value));
};

type ColumnNumberAnalysis = {
    present: number;
    junk: number;
    strongComma: number;
    weakComma: number;
    point: number;
    ambiguous: number;
    dottedGroups: number;
};

const isSkippedCell = (value: unknown) =>
    value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '')
    || (typeof value !== 'number' && isMissingCellValue(value));

const analyzeColumnNumbers = (values: Iterable<unknown>): ColumnNumberAnalysis => {
    const analysis: ColumnNumberAnalysis = { present: 0, junk: 0, strongComma: 0, weakComma: 0, point: 0, ambiguous: 0, dottedGroups: 0 };
    for (const value of values) {
        if (isSkippedCell(value)) continue;
        analysis.present += 1;
        if (typeof value === 'number') continue;
        const body = cellBody(value);
        const kind = classifyNumberBody(body);
        if (kind === null) analysis.junk += 1;
        else if (kind === 'decimal_comma') {
            if (isStrongDecimalCommaBody(body)) analysis.strongComma += 1;
            else analysis.weakComma += 1;
        } else if (kind === 'decimal_point') analysis.point += 1;
        else if (kind === 'ambiguous') analysis.ambiguous += 1;
        else if (kind === 'dotted_groups') analysis.dottedGroups += 1;
    }
    return analysis;
};

// Headers that name an identifier or a label, never a measure. Compared per word
// (split on case changes, digits and punctuation); a trailing "number", "nummer",
// "code" or "kode" also counts, so "OrderNumber" and "Kundennummer" match.
const IDENTIFIER_WORDS = new Set([
    'id', 'ids', 'uid', 'guid', 'key', 'code', 'kode', 'no', 'nr', 'num', 'nbr', 'number', 'nummer',
    'sku', 'ref', 'reference', 'zip', 'postcode', 'postal', 'phone', 'tel', 'telephone', 'fax', 'mobile',
    'iban', 'ssn', 'serial', 'barcode', 'ean', 'upc', 'isbn', 'pin',
]);
const IDENTIFIER_SUFFIXES = ['number', 'nummer', 'code', 'kode'];

export const isIdentifierHeader = (header: string): boolean => {
    const words = header
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-zÀ-ɏ]+/)
        .filter(Boolean);
    // "Number of items" counts something; it is a measure, not an identifier.
    if (words.includes('of')) return false;
    return words.some(word => IDENTIFIER_WORDS.has(word) || IDENTIFIER_SUFFIXES.some(suffix => word.length > suffix.length && word.endsWith(suffix)))
        || /#/.test(header);
};

/** A small share of non-numeric cells (a stray TBD) does not turn a measure into text. */
const JUNK_TOLERANCE = 0.05;
const isNumericEnough = (analysis: ColumnNumberAnalysis) =>
    analysis.present - analysis.junk > 0 && analysis.junk <= Math.floor(analysis.present * JUNK_TOLERANCE);

/** The column's own evidence, without any dataset-level prior. */
const resolveOwnStyle = (analysis: ColumnNumberAnalysis, header: string | null): NumberStyle | null => {
    if (!isNumericEnough(analysis)) return null;
    const commaCells = analysis.strongComma + analysis.weakComma + analysis.dottedGroups;
    if (analysis.point > 0) return commaCells > 0 ? null : 'decimal_point';
    if (analysis.strongComma > 0 && !(header !== null && isIdentifierHeader(header))) return 'decimal_comma';
    return null;
};

/**
 * The decimal style a whole column proves on its own, or null when it has no
 * evidence, mixes both styles, is mostly text, or (when `header` is given) is
 * named like an identifier.
 */
export const detectColumnNumberStyle = (values: Iterable<unknown>, header?: string | null): NumberStyle | null =>
    resolveOwnStyle(analyzeColumnNumbers(values), header ?? null);

const PROBE_CELL_COUNT = 50;

/** Cheap pre-check on the first cells so text columns are never scanned in full. */
const looksNumericByProbe = (rows: readonly Record<string, unknown>[], column: string): boolean => {
    let probed = 0;
    let numeric = 0;
    for (const row of rows) {
        const value = row[column];
        if (isSkippedCell(value)) continue;
        probed += 1;
        if (typeof value === 'number' || classifyNumberCell(value) !== null) numeric += 1;
        if (probed >= PROBE_CELL_COUNT) break;
    }
    return probed > 0 && numeric / probed >= 0.8;
};

export type DecimalCommaColumn = { inherited: boolean };

/**
 * Which columns of a dataset are read with the decimal comma. Only columns that
 * prove it (see the rules at the top) qualify, plus, when no column proves the
 * decimal point, columns with only ambiguous cells (`1.000`, `2,500`) that are
 * not named like identifiers, because a file written in a European locale
 * writes all its numbers that way.
 */
export const resolveDecimalCommaColumns = (
    rows: readonly Record<string, unknown>[],
    columns: readonly string[],
): Map<string, DecimalCommaColumn> => {
    const result = new Map<string, DecimalCommaColumn>();
    const analyses = new Map<string, ColumnNumberAnalysis>();
    let datasetPointProof = false;
    for (const column of columns) {
        if (!looksNumericByProbe(rows, column)) continue;
        const analysis = analyzeColumnNumbers((function* () { for (const row of rows) yield row[column]; })());
        analyses.set(column, analysis);
        const own = resolveOwnStyle(analysis, column);
        if (own === 'decimal_comma') result.set(column, { inherited: false });
        // Identifier-named columns still count as proof of the file's style.
        if (analysis.point > 0 && isNumericEnough(analysis)) datasetPointProof = true;
    }
    if (result.size === 0 || datasetPointProof) return result;

    for (const [column, analysis] of analyses) {
        if (result.has(column) || !isNumericEnough(analysis) || isIdentifierHeader(column)) continue;
        const onlyAmbiguous = analysis.ambiguous > 0
            && analysis.strongComma + analysis.weakComma + analysis.dottedGroups + analysis.point === 0;
        if (onlyAmbiguous) result.set(column, { inherited: true });
    }
    return result;
};

// Includes no-break and narrow no-break spaces that thousands groups often use.
const NUMBER_TOKEN = /\d(?:[\d.,\s  ]*\d)?/;

/** Rewrites the number inside a cell to canonical `1234.56` text, keeping sign, currency and percent marks. */
export const canonicalizeNumberCell = (value: string, style: NumberStyle): string => {
    const match = NUMBER_TOKEN.exec(value);
    if (!match) return value;
    const canonical = canonicalizeNumberBody(match[0].replace(/[\s  ]/g, ''), style);
    if (canonical === null) return value;
    return value.slice(0, match.index) + canonical + value.slice(match.index + match[0].length);
};

/**
 * Per-column normalisation of decimal-comma columns to canonical decimal-point
 * text, for consumers that read numbers without any column context (SQL casts).
 * Only columns resolved by `resolveDecimalCommaColumns` are rewritten, and within
 * them only cells that are numbers (a stray `TBD` is left alone). US columns,
 * identifier-named columns and text are returned untouched. Rows are copied only
 * when something changed.
 */
export const normalizeDecimalCommaColumns = <Row extends Record<string, unknown>>(
    rows: readonly Row[],
    columns: readonly string[],
): { rows: readonly Row[]; columns: string[] } => {
    const normalizedColumns = [...resolveDecimalCommaColumns(rows, columns).keys()];
    if (normalizedColumns.length === 0) return { rows, columns: [] };

    const rewritten = rows.map(row => {
        const next: Record<string, unknown> = { ...row };
        for (const column of normalizedColumns) {
            const value = row[column];
            if (typeof value === 'string' && !isSkippedCell(value) && classifyNumberCell(value) !== null) {
                next[column] = canonicalizeNumberCell(value, 'decimal_comma');
            }
        }
        return next as Row;
    });
    return { rows: rewritten, columns: normalizedColumns };
};
