/**
 * Which preamble line of a report is its title.
 *
 * A report starts with a company name, the report name, a period ("From
 * 01-01-2026 To 30-06-2026"), key/value parameters ("As At | 30-06-2026") and
 * print stamps. Only the first two can name the report; the rest is context
 * that belongs in a subtitle.
 */

const MONTH_NAME = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_SOURCE = [
    '\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}',
    '\\d{4}[/.-]\\d{1,2}[/.-]\\d{1,2}',
    `\\d{1,2}\\s+${MONTH_NAME}\\s+\\d{2,4}`,
    `${MONTH_NAME}\\s+\\d{1,2},?\\s+\\d{4}`,
    `${MONTH_NAME}[\\s-]+\\d{2,4}`,
].join('|');

const PERIOD_WORDS = new Set([
    'from', 'to', 'until', 'till', 'through', 'thru', 'as', 'at', 'of', 'on', 'for', 'the', 'period', 'date', 'dated',
    'between', 'and', 'up', 'ending', 'end', 'start', 'starting', 'month', 'year', 'fy', 'ytd', 'by', 'all', 'dates',
]);

// Words that mark a line as naming the report itself.
const TITLE_WORD_PATTERN = /\b(report|statement|summary|listing|details?|analysis|aging|ageing|ledger|register|schedule|outstanding|forecast|overview|breakdown|balance sheet|trial balance)\b/i;
const TITLE_KEY_PATTERN = /^(?:report\s*)?(?:name|title)$/i;
const PRINT_STAMP_PATTERN = /\bpage\s+\d+\s+of\s+\d+\b|^(?:printed|run|generated|created|prepared|exported)\b|\b(?:printed|run|generated|exported)\s+(?:by|on|at)\b/i;
const FILE_NAME_PATTERN = /^\S+\.(?:csv|tsv|txt|xlsx?|xlsm)$/i;
const ENTITY_SUFFIX_PATTERN = /\b(limited|ltd|inc|llc|corp|corporation|company|co|pte|plc|group|sdn\.?\s*bhd|bhd|gmbh|ag|sa)\b/i;

const compact = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

/** "From 01-01-2026 To 30-06-2026", "As At | 30-06-2026", "30-06-2026": a period, not a name. */
export const isDateOrPeriodLine = (line: string): boolean => {
    const text = compact(line);
    if (!text) return false;
    const withoutDates = text.replace(new RegExp(DATE_SOURCE, 'gi'), ' ');
    if (withoutDates === text) return false;
    const words = withoutDates
        .toLowerCase()
        .replace(/[|:,\-\u2013\u2014/()]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    return words.every(word => PERIOD_WORDS.has(word) || /^\d+$/.test(word));
};

/** "Key | value" (cells of one preamble row) or "Key: value": a parameter, not a title. */
const MAX_KEY_WORDS = 3;

const splitKeyValue = (line: string): { key: string; value: string } | null => {
    const text = compact(line);
    const match = text.match(/^([^|]{1,60}?)\s*\|\s*(.+)$/) ?? text.match(/^([^:]{1,60}?)\s*:\s*(\S.*)$/);
    // A longer left side is a title with a parameter glued on ("Sales Order Daily Report Reporting Date : ..."),
    // which still carries the title.
    return match && match[1].trim().split(' ').length <= MAX_KEY_WORDS
        ? { key: match[1].trim(), value: match[2].trim() }
        : null;
};

export const isParameterPairLine = (line: string): boolean => {
    const pair = splitKeyValue(line);
    return Boolean(pair) && !TITLE_KEY_PATTERN.test(pair!.key);
};

/**
 * The title a preamble line offers, or null when the line cannot be one:
 * a rule of dashes, a period, a parameter pair, a print stamp or a file name.
 * "Report Name | AR Aging Analysis" offers "AR Aging Analysis".
 */
export const extractTitleCandidate = (line: string): string | null => {
    const text = compact(line);
    if (!text || !/\p{L}/u.test(text)) return null;
    const pair = splitKeyValue(text);
    if (pair) return TITLE_KEY_PATTERN.test(pair.key) && !isDateOrPeriodLine(pair.value) ? pair.value : null;
    if (isDateOrPeriodLine(text) || PRINT_STAMP_PATTERN.test(text) || FILE_NAME_PATTERN.test(text)) return null;
    return (text.match(/\p{L}/gu) ?? []).length >= 3 ? text : null;
};

/**
 * True for text that is clearly not a report title: a period, a "key | value" pair, a print
 * stamp, a file name or a rule. Used to vet a title the AI chose; a colon in an otherwise
 * ordinary title ("Income Statement: Project X") stays allowed.
 */
export const isNonTitleLine = (line: string | null | undefined): boolean => {
    const text = compact(line);
    if (!text || !/\p{L}/u.test(text)) return true;
    const pair = text.includes('|') ? splitKeyValue(text) : null;
    if (pair && !TITLE_KEY_PATTERN.test(pair.key)) return true;
    return isDateOrPeriodLine(text) || PRINT_STAMP_PATTERN.test(text) || FILE_NAME_PATTERN.test(text);
};

const scoreTitleCandidate = (line: string): number => {
    let score = 0;
    if (TITLE_WORD_PATTERN.test(line)) score += 3;
    const letters = line.replace(/[^\p{L}]/gu, '');
    if (letters.length > 2 && letters === letters.toUpperCase() && line.split(/\s+/).length >= 2) score += 1;
    if (ENTITY_SUFFIX_PATTERN.test(line)) score += 1;
    return score;
};

/**
 * The most title-like of several candidate lines. A line that says "report",
 * "statement" or "analysis" names the report; a bare company name is the
 * fallback. Ties keep the earlier line.
 */
export const pickMostTitleLikeLine = (lines: readonly string[]): string | null => {
    let best: string | null = null;
    let bestScore = -1;
    for (const line of lines) {
        const score = scoreTitleCandidate(line);
        if (score > bestScore) {
            best = line;
            bestScore = score;
        }
    }
    return best;
};
