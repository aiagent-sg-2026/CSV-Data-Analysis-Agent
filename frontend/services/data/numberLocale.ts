import { isMissingCellValue } from '../duckdb/dimensionNormalization';

/**
 * Locale-aware reading of numbers stored as text.
 *
 * The separators are ambiguous in isolation: `1,234` is one thousand two
 * hundred thirty-four in the US and 1.234 in Germany, `4.567` the reverse.
 * Rules, in order of authority:
 *  1. A cell that is only valid in one style decides for itself
 *     (`1.234,56`, `161,30`, `1.234.567` are decimal comma;
 *     `1,234.56`, `1,234,567`, `18.50` are decimal point).
 *  2. A cell that fits both styles (`1,234`, `4.567`) is "ambiguous". A column
 *     that contains unambiguous cells of exactly one style resolves it that
 *     way, per column, never per cell.
 *  3. With no column evidence an ambiguous cell keeps the US reading
 *     (`1,234` is thousands, `4.567` is a decimal).
 */
export type NumberStyle = 'decimal_point' | 'decimal_comma';
export type NumberTextKind = NumberStyle | 'ambiguous' | 'plain';

const CURRENCY_AND_PERCENT = /[$\s€£¥%]/g;
// Swiss thousands separator: 1'234.50 or 1’234.50.
const SWISS_APOSTROPHE = /(?<=\d)['’](?=\d{3}(?:\D|$))/g;
const NUMERIC_CHARS = /^[\d.,]+$/;

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
        return /^\d{1,3}(?:,\d{3})+\.\d+$/.test(body) ? 'decimal_point' : null;
    }

    if (commas > 0) {
        if (commas > 1) return /^\d{1,3}(?:,\d{3})+$/.test(body) ? 'decimal_point' : null;
        const match = /^(\d+),(\d+)$/.exec(body);
        if (!match) return null;
        const [, before, after] = match;
        // Thousands groups are exactly three digits after a 1-3 digit lead
        // that does not start with zero; anything else is a decimal comma.
        if (after.length !== 3 || before.length > 3 || before.startsWith('0')) return 'decimal_comma';
        return 'ambiguous';
    }

    if (dots > 1) return /^\d{1,3}(?:\.\d{3})+$/.test(body) ? 'decimal_comma' : null;
    const match = /^(\d*)\.(\d*)$/.exec(body);
    if (!match) return null;
    const [, before, after] = match;
    if (after.length !== 3 || before.length === 0 || before.length > 3 || before.startsWith('0')) return 'decimal_point';
    return 'ambiguous';
};

/**
 * Canonical form of an unsigned number body (digits and at most one `.`), or
 * null when it is not a well-formed number. `style` only resolves ambiguity.
 */
export const canonicalizeNumberBody = (body: string, style?: NumberStyle | null): string | null => {
    const kind = classifyNumberBody(body);
    if (kind === null) return null;
    if (kind === 'plain') return body;
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
    return { sign: signed ? decorated[0] : '', body: signed ? decorated.slice(1) : decorated };
};

/**
 * Reads the numeric style a single cell proves. Returns null for text that is
 * not a number at all, and 'plain' / 'ambiguous' when the cell has no evidence.
 */
export const classifyNumberCell = (value: unknown): NumberTextKind | null => {
    if (value === null || value === undefined) return null;
    let text = String(value).trim();
    if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1);
    return classifyNumberBody(unsignedBody(stripNumberDecorations(text)).body);
};

/**
 * The decimal style a whole column proves, or null when it has no evidence or
 * mixes both styles. Blank cells and missing markers are ignored; any other
 * non-number makes the column non-numeric, so the answer is null.
 */
export const detectColumnNumberStyle = (values: Iterable<unknown>): NumberStyle | null => {
    let decimalComma = 0;
    let decimalPoint = 0;
    for (const value of values) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        if (typeof value === 'number') continue;
        if (isMissingCellValue(value)) continue;
        const kind = classifyNumberCell(value);
        if (kind === null) return null;
        if (kind === 'decimal_comma') decimalComma += 1;
        else if (kind === 'decimal_point') decimalPoint += 1;
    }
    if (decimalComma > 0 && decimalPoint === 0) return 'decimal_comma';
    if (decimalPoint > 0 && decimalComma === 0) return 'decimal_point';
    return null;
};

const NUMBER_TOKEN = /\d(?:[\d.,\s  ]*\d)?/;

/** Rewrites the number inside a cell to canonical `1234.56` text, keeping sign, currency and percent marks. */
export const canonicalizeNumberCell = (value: string, style: NumberStyle): string => {
    const match = NUMBER_TOKEN.exec(value);
    if (!match) return value;
    const canonical = canonicalizeNumberBody(match[0].replace(/[\s  ]/g, ''), style);
    if (canonical === null) return value;
    return value.slice(0, match.index) + canonical + value.slice(match.index + match[0].length);
};

const PROBE_CELL_COUNT = 50;

/**
 * Per-column normalisation of decimal-comma columns to canonical decimal-point
 * text, for consumers that read numbers without any column context (SQL casts).
 * Only columns that prove the decimal comma through at least one unambiguous
 * cell and contain nothing but numbers are rewritten; US columns and text are
 * returned untouched. Rows are copied only when something changed.
 */
export const normalizeDecimalCommaColumns = <Row extends Record<string, unknown>>(
    rows: readonly Row[],
    columns: readonly string[],
): { rows: readonly Row[]; columns: string[] } => {
    const normalizedColumns: string[] = [];
    for (const column of columns) {
        // Cheap probe first: skip text columns without scanning every row.
        let probed = 0;
        let looksNumeric = true;
        for (const row of rows) {
            const value = row[column];
            if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) continue;
            if (typeof value !== 'string' || (classifyNumberCell(value) === null && !isMissingCellValue(value))) {
                looksNumeric = false;
                break;
            }
            probed += 1;
            if (probed >= PROBE_CELL_COUNT) break;
        }
        if (!looksNumeric || probed === 0) continue;
        const style = detectColumnNumberStyle((function* () { for (const row of rows) yield row[column]; })());
        if (style === 'decimal_comma') normalizedColumns.push(column);
    }
    if (normalizedColumns.length === 0) return { rows, columns: [] };

    const rewritten = rows.map(row => {
        const next: Record<string, unknown> = { ...row };
        for (const column of normalizedColumns) {
            const value = row[column];
            if (typeof value === 'string' && value.trim() !== '' && !isMissingCellValue(value)) {
                next[column] = canonicalizeNumberCell(value, 'decimal_comma');
            }
        }
        return next as Row;
    });
    return { rows: rewritten, columns: normalizedColumns };
};
