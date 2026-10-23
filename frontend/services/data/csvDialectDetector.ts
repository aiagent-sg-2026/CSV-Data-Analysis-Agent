import * as Papa from 'papaparse';
import type {
    CsvIntakeConfidence,
    CsvIntakeDetectionResult,
    CsvIntakeWarning,
    CsvIntakeWarningCode,
} from '../../types';

type RawCsvRow = string[];

type DialectCandidate = {
    delimiter: string;
    quoteChar: string;
};

type CandidateScore = DialectCandidate & {
    score: number;
    errorCount: number;
    rowCount: number;
    nonEmptyRowCount: number;
    dominantWidth: number;
    dominantWidthCount: number;
    delimiterHits: number;
    unbalancedQuote: boolean;
    widthConsistency: number;
    usableCoverage: number;
    headerPlausibility: number;
    quotedStability: number;
};

type CsvDetectionParseResult = {
    rawRows: RawCsvRow[];
    detection: CsvIntakeDetectionResult;
};

const SAMPLE_BYTE_LIMIT = 128 * 1024;
const SAMPLE_NON_EMPTY_LINE_LIMIT = 200;
// A legitimate quoted cell rarely spans more than a few lines. Beyond this a
// quote is treated as runaway (a stray quote swallowing the following rows).
const MAX_QUOTED_FIELD_LINE_BREAKS = 40;
const DELIMITER_CANDIDATES = [',', ';', '\t', '|', ':'] as const;
const QUOTE_CHAR_CANDIDATES = ['"', '\'', ''] as const;
const MIN_SCORED_CANDIDATE_SCORE = 0.42;
const WORD_CHAR_PATTERN = /[A-Za-z0-9]/;

const coerceRowToArray = (row: unknown): string[] => {
    if (Array.isArray(row)) {
        return row.map(value => (value === undefined || value === null ? '' : String(value)));
    }
    if (row && typeof row === 'object') {
        return Object.values(row).map(value => (value === undefined || value === null ? '' : String(value)));
    }
    return [];
};

const parseCsvText = (
    text: string,
    config: {
        delimiter?: string;
        quoteChar?: string;
    } = {},
): Papa.ParseResult<unknown> => Papa.parse<unknown>(text, {
    header: false,
    skipEmptyLines: false,
    delimiter: config.delimiter,
    quoteChar: config.quoteChar,
});

const isRowNonEmpty = (row: RawCsvRow) => row.some(cell => String(cell ?? '').trim().length > 0);

const countNonEmptyLines = (text: string) =>
    text.split(/\r\n|\n|\r/).filter(line => line.trim().length > 0).length;

type DetectionSample = {
    text: string;
    /** True when the sample ends before the end of the file. */
    truncated: boolean;
};

const stripBom = (text: string) => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);

const buildDetectionSample = (rawText: string): DetectionSample => {
    // A BOM sits in front of the first field, so a quoted first header cell
    // would no longer start with its quote character.
    const text = stripBom(rawText);
    const byteLimited = text.length > SAMPLE_BYTE_LIMIT;
    const lines = (byteLimited ? text.slice(0, SAMPLE_BYTE_LIMIT) : text).split(/\r\n|\n|\r/);
    const collected: string[] = [];
    let nonEmptyLines = 0;
    let truncated = false;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const isLastLine = index === lines.length - 1;
        if (byteLimited && isLastLine && collected.length > 0) {
            // The byte cut lands mid-line; a partial record would only add noise.
            truncated = true;
            break;
        }
        collected.push(line);
        if (line.trim().length > 0) {
            nonEmptyLines += 1;
        }
        if (nonEmptyLines >= SAMPLE_NON_EMPTY_LINE_LIMIT) {
            truncated = !isLastLine || byteLimited;
            break;
        }
    }
    if (byteLimited) truncated = true;

    return { text: collected.join('\n'), truncated };
};

const pushWarning = (
    warnings: CsvIntakeWarning[],
    code: CsvIntakeWarningCode,
    message: string,
) => {
    if (!warnings.some(existing => existing.code === code && existing.message === message)) {
        warnings.push({ code, message });
    }
};

const mergeWarnings = (...warningGroups: Array<CsvIntakeWarning[] | undefined>): CsvIntakeWarning[] => {
    const warnings: CsvIntakeWarning[] = [];
    warningGroups.forEach(group => {
        (group ?? []).forEach(warning => pushWarning(warnings, warning.code, warning.message));
    });
    return warnings;
};

const isApostropheWithinWord = (text: string, index: number) => {
    const previous = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    return WORD_CHAR_PATTERN.test(previous) && WORD_CHAR_PATTERN.test(next);
};

const isStructuralQuoteChar = (text: string, index: number, quoteChar: string) => {
    if (quoteChar !== '\'') return true;
    // Apostrophe within a word (e.g., "don't") — not structural
    if (isApostropheWithinWord(text, index)) return false;
    // Apostrophe followed by a dash/hyphen is a zero-value placeholder (e.g., '-) — not structural
    const next = text[index + 1] ?? '';
    if (next === '-' || next === '\u2013' || next === '\u2014') return false;
    return true;
};

type QuoteScan = {
    /** Stray closing quote, runaway quoted field, or a quote still open at the end. */
    malformed: boolean;
    openAtEnd: boolean;
    /** True when the open quote already spans more lines than a real cell would. */
    runaway: boolean;
    /** Index where the record holding the still-open quote starts. */
    openRecordStart: number;
    delimiterHits: number;
    /** Line breaks inside quoted fields that closed cleanly (one record, several lines). */
    quotedLineBreaks: number;
};

/**
 * Quote-aware scan that follows RFC 4180 / PapaParse rules: a quote opens a
 * quoted field only at the start of a field, `""` is an escaped quote, and a
 * closing quote must be followed by a delimiter, a line break or the end.
 * Line breaks inside a quoted field are valid and do not make the quoting
 * malformed; only a quote that never closes sensibly does.
 */
const scanQuoting = (text: string, delimiter: string, quoteChar: string): QuoteScan => {
    let delimiterHits = 0;
    let inQuote = false;
    let fieldStart = true;
    let recordStart = 0;
    let openRecordStart = 0;
    let quotedLineBreaks = 0;
    let closedQuotedLineBreaks = 0;
    let malformed = false;
    let runaway = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inQuote) {
            if (char === quoteChar && isStructuralQuoteChar(text, index, quoteChar)) {
                const next = text[index + 1];
                if (next === quoteChar) {
                    index += 1;
                } else if (next === undefined || next === delimiter || next === '\n' || next === '\r') {
                    inQuote = false;
                    fieldStart = false;
                    closedQuotedLineBreaks += quotedLineBreaks;
                } else {
                    // A quote that closes a field but is followed by more text.
                    malformed = true;
                }
            } else if (char === '\n' || char === '\r') {
                if (char === '\r' && text[index + 1] === '\n') index += 1;
                quotedLineBreaks += 1;
                if (quotedLineBreaks > MAX_QUOTED_FIELD_LINE_BREAKS) {
                    runaway = true;
                    malformed = true;
                }
            }
            continue;
        }
        if (quoteChar && char === quoteChar && fieldStart && isStructuralQuoteChar(text, index, quoteChar)) {
            inQuote = true;
            fieldStart = false;
            quotedLineBreaks = 0;
            openRecordStart = recordStart;
            continue;
        }
        if (char === delimiter) {
            delimiterHits += 1;
            fieldStart = true;
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[index + 1] === '\n') index += 1;
            fieldStart = true;
            recordStart = index + 1;
        } else {
            fieldStart = false;
        }
    }

    if (inQuote) malformed = true;
    return { malformed, openAtEnd: inQuote, runaway, openRecordStart, delimiterHits, quotedLineBreaks: closedQuotedLineBreaks };
};

/**
 * When the sample was cut inside a multi-line quoted field the last record is
 * simply incomplete, not malformed. Drop it so the candidate is judged on whole
 * records only. Returns the (possibly shortened) text and its scan.
 */
const scanSampleForCandidate = (sample: DetectionSample, delimiter: string, quoteChar: string) => {
    const scan = scanQuoting(sample.text, delimiter, quoteChar);
    if (sample.truncated && scan.openAtEnd && !scan.runaway && scan.openRecordStart > 0) {
        const trimmed = sample.text.slice(0, scan.openRecordStart);
        return { text: trimmed, scan: scanQuoting(trimmed, delimiter, quoteChar) };
    }
    return { text: sample.text, scan };
};

const toWidthSummary = (rows: RawCsvRow[]) => {
    const widthCounts = new Map<number, number>();
    rows.forEach(row => {
        widthCounts.set(row.length, (widthCounts.get(row.length) ?? 0) + 1);
    });

    let dominantWidth = 0;
    let dominantWidthCount = 0;
    widthCounts.forEach((count, width) => {
        if (count > dominantWidthCount) {
            dominantWidth = width;
            dominantWidthCount = count;
        }
    });

    return { dominantWidth, dominantWidthCount };
};

const NUMERIC_LIKE_PATTERN = /^[\s$€£¥+-]?\d[\d,\s]*(?:\.\d+)?%?$/;

const isNumericLike = (value: string) => {
    const normalized = value.trim();
    return normalized.length > 0 && NUMERIC_LIKE_PATTERN.test(normalized);
};

const buildHeaderPlausibility = (rows: RawCsvRow[]) => {
    const nonEmptyRows = rows.filter(isRowNonEmpty);
    if (nonEmptyRows.length === 0) return 0;
    if (nonEmptyRows.length === 1) return nonEmptyRows[0].length > 1 ? 0.55 : 0.35;

    const header = nonEmptyRows[0].map(cell => String(cell ?? '').trim()).filter(Boolean);
    const next = nonEmptyRows[1].map(cell => String(cell ?? '').trim()).filter(Boolean);
    if (header.length === 0) return 0.1;

    const headerNumericRatio = header.filter(isNumericLike).length / header.length;
    const nextNumericRatio = next.length > 0 ? next.filter(isNumericLike).length / next.length : 0;
    let score = 0.25;

    if (header.length > 1) score += 0.15;
    if (headerNumericRatio <= 0.35) score += 0.25;
    if (nextNumericRatio >= headerNumericRatio) score += 0.2;
    if (header.length === next.length) score += 0.15;

    return Math.min(1, score);
};

const scoreCandidate = (detectionSample: DetectionSample, candidate: DialectCandidate): CandidateScore => {
    const { text: sample, scan } = scanSampleForCandidate(detectionSample, candidate.delimiter, candidate.quoteChar);
    const parsed = parseCsvText(sample, {
        delimiter: candidate.delimiter,
        quoteChar: candidate.quoteChar,
    });
    const rows = parsed.data.map(coerceRowToArray);
    const nonEmptyRows = rows.filter(isRowNonEmpty);
    const { dominantWidth, dominantWidthCount } = toWidthSummary(nonEmptyRows);
    const sampleNonEmptyLineCount = Math.max(countNonEmptyLines(sample), 1);
    // A record with an embedded line break spans several lines, so lines inside
    // well-formed quoted fields must not count against this candidate's coverage.
    const expectedRecordCount = Math.max(sampleNonEmptyLineCount - scan.quotedLineBreaks, 1);
    const widthConsistency = nonEmptyRows.length > 0 ? dominantWidthCount / nonEmptyRows.length : 0;
    const usableCoverage = Math.min(1, nonEmptyRows.length / expectedRecordCount);
    const headerPlausibility = buildHeaderPlausibility(nonEmptyRows);
    const unbalancedQuote = scan.malformed;
    const delimiterHits = scan.delimiterHits;
    // The sample covers only the first lines of the file. When it contains no
    // quotes, RFC 4180 double quoting is the safe default: an unused `"`
    // changes nothing in the sample, but a quoted field further down
    // ("1,438") would be split and shift every later value if the file were
    // parsed without quoting. Ties keep candidate order, so `"` wins over the
    // no-quote parse. Single quotes stay a weaker guess without evidence.
    const quotedStability = candidate.quoteChar
        ? sample.includes(candidate.quoteChar)
            ? (unbalancedQuote ? 0.15 : 1)
            : candidate.quoteChar === '"' ? 1 : 0.8
        : 1;
    const delimiterStrength = delimiterHits === 0
        ? (dominantWidth > 1 ? 0.2 : 0.35)
        : Math.min(1, delimiterHits / sampleNonEmptyLineCount);
    const errorPenalty = Math.min(parsed.errors.length * 0.15, 0.45);
    const unbalancedPenalty = unbalancedQuote ? 0.25 : 0;

    let score = (
        widthConsistency * 0.42
        + usableCoverage * 0.18
        + quotedStability * 0.14
        + headerPlausibility * 0.12
        + delimiterStrength * 0.14
    ) - errorPenalty - unbalancedPenalty;

    // Hard floor: a single-column parse is almost never the correct CSV
    // interpretation. Cap the score so multi-column candidates win, or the
    // system falls through to PapaParse auto-detection.
    if (dominantWidth <= 1) {
        score = Math.min(score, delimiterHits === 0 ? 0.18 : 0.25);
    }

    return {
        ...candidate,
        score: Number(score.toFixed(4)),
        errorCount: parsed.errors.length,
        rowCount: rows.length,
        nonEmptyRowCount: nonEmptyRows.length,
        dominantWidth,
        dominantWidthCount,
        delimiterHits,
        unbalancedQuote,
        widthConsistency,
        usableCoverage,
        headerPlausibility,
        quotedStability,
    };
};

const buildConfidence = (best: CandidateScore, runnerUp: CandidateScore | null): CsvIntakeConfidence => {
    const gap = best.score - (runnerUp?.score ?? 0);
    if (best.score >= 0.78 && gap >= 0.12 && !best.unbalancedQuote && best.errorCount === 0) {
        return 'high';
    }
    if (best.score >= 0.52 && gap >= 0.05 && !best.unbalancedQuote) {
        return 'medium';
    }
    return 'low';
};

const buildBaseWarnings = (
    sample: DetectionSample,
    best: CandidateScore,
    runnerUp: CandidateScore | null,
    confidence: CsvIntakeConfidence,
): CsvIntakeWarning[] => {
    const warnings: CsvIntakeWarning[] = [];
    const malformedQuotedSample = ['"', '\''].some(quoteChar =>
        scanSampleForCandidate(sample, best.delimiter, quoteChar).scan.malformed);
    if (best.errorCount > 0) {
        pushWarning(warnings, 'parse_errors', `Parser reported ${best.errorCount} issue${best.errorCount === 1 ? '' : 's'} while evaluating the selected CSV dialect.`);
    }
    if (best.unbalancedQuote || malformedQuotedSample) {
        pushWarning(warnings, 'malformed_quote', 'Quoted fields appear malformed or unbalanced, so CSV parsing may require fallback behavior.');
    }
    const delimiterHits = DELIMITER_CANDIDATES
        .map(delimiter => ({ delimiter, hits: scanSampleForCandidate(sample, delimiter, best.quoteChar).scan.delimiterHits }))
        .sort((left, right) => right.hits - left.hits);
    const strongestAlternate = delimiterHits.find(entry => entry.delimiter !== best.delimiter && entry.hits > 0) ?? null;
    if (confidence !== 'high') {
        pushWarning(warnings, 'low_confidence', 'CSV dialect detection confidence is limited, so the imported structure should be reviewed in diagnostics.');
    }
    // A parse in which every record has the same width cannot be mixed: the
    // other delimiter's hits are inside fields (decimal commas, free text).
    const uniformBest = best.widthConsistency >= 0.98 && best.errorCount === 0 && !best.unbalancedQuote;
    if (uniformBest) {
        return warnings;
    }
    if (
        strongestAlternate
        && strongestAlternate.hits >= Math.max(1, best.delimiterHits * 0.35)
    ) {
        pushWarning(warnings, 'mixed_delimiter', `The file looks mixed between "${best.delimiter}" and "${strongestAlternate.delimiter}" delimiters, so the selected parser may be approximate.`);
    } else if (
        runnerUp
        && runnerUp.delimiter !== best.delimiter
        && runnerUp.score >= best.score - 0.08
        && runnerUp.delimiterHits > 0
    ) {
        pushWarning(warnings, 'mixed_delimiter', `The file looks mixed between "${best.delimiter}" and "${runnerUp.delimiter}" delimiters, so the selected parser may be approximate.`);
    }
    return warnings;
};

// Comma doubles as the decimal mark and thousands separator, so a file that
// uses another delimiter and has decimal commas can look just as regular as
// the real parse. These are the delimiters that never appear inside numbers.
const COMMA_DOMINATING_DELIMITERS = new Set([';', '\t', '|']);
const NESTED_COMMA_PENALTY = 0.25;

const isCleanUniformParse = (candidate: CandidateScore) =>
    candidate.widthConsistency === 1 && candidate.errorCount === 0 && !candidate.unbalancedQuote;

/**
 * A comma parse is "nested" when another delimiter splits every sampled record
 * (header included) into the same, larger number of fields. The commas then
 * sit inside those fields (decimal commas such as `1.234,56`), so they are not
 * the separator even though each record has a constant comma count.
 */
const isNestedCommaCandidate = (candidate: CandidateScore, all: CandidateScore[]) =>
    candidate.delimiter === ','
    && all.some(other =>
        COMMA_DOMINATING_DELIMITERS.has(other.delimiter)
        && other.dominantWidth > Math.max(candidate.dominantWidth, 1)
        && isCleanUniformParse(other));

const scoreCandidates = (sample: DetectionSample) => {
    const scored = DELIMITER_CANDIDATES.flatMap(delimiter =>
        QUOTE_CHAR_CANDIDATES.map(quoteChar => scoreCandidate(sample, { delimiter, quoteChar })));
    return scored
        .map(candidate => isNestedCommaCandidate(candidate, scored)
            ? { ...candidate, score: Number(Math.max(candidate.score - NESTED_COMMA_PENALTY, 0).toFixed(4)) }
            : candidate)
        .sort((left, right) => right.score - left.score);
};

const getAlternateDelimiterCandidate = (candidates: CandidateScore[], best: CandidateScore) =>
    candidates.find(candidate => candidate.delimiter !== best.delimiter) ?? null;

const createDetection = (
    strategy: CsvIntakeDetectionResult['strategy'],
    candidate: CandidateScore | null,
    runnerUp: CandidateScore | null,
    confidence: CsvIntakeConfidence,
    warnings: CsvIntakeWarning[],
    sampledNonEmptyLines: number,
    parserErrorCount?: number,
): CsvIntakeDetectionResult => ({
    strategy,
    confidence,
    delimiter: candidate?.delimiter ?? null,
    quoteChar: candidate?.quoteChar || null,
    warnings,
    candidateCount: DELIMITER_CANDIDATES.length * QUOTE_CHAR_CANDIDATES.length,
    parserErrorCount: parserErrorCount ?? candidate?.errorCount ?? 0,
    sampledNonEmptyLines,
    topScore: candidate?.score ?? null,
    runnerUpScore: runnerUp?.score ?? null,
});

/**
 * Reports padded with a trailing delimiter on every line (`a;b;c;`) parse into
 * one extra field that is empty in every record. It carries no data, so drop it
 * instead of letting it become an `_unnamed_column_N` further down the pipeline.
 */
export const dropTrailingEmptyColumns = (rows: RawCsvRow[]): RawCsvRow[] => {
    let lastUsedWidth = 0;
    let maxWidth = 0;
    for (const row of rows) {
        maxWidth = Math.max(maxWidth, row.length);
        let width = row.length;
        while (width > lastUsedWidth && String(row[width - 1] ?? '').trim().length === 0) {
            width -= 1;
        }
        lastUsedWidth = Math.max(lastUsedWidth, width);
    }
    if (lastUsedWidth === 0 || lastUsedWidth >= maxWidth) {
        return rows;
    }
    return rows.map(row => (row.length > lastUsedWidth ? row.slice(0, lastUsedWidth) : row));
};

const parseCandidateRows = (text: string, candidate: CandidateScore) => {
    const parsed = parseCsvText(text, {
        delimiter: candidate.delimiter,
        quoteChar: candidate.quoteChar,
    });

    return {
        rawRows: dropTrailingEmptyColumns(parsed.data.map(coerceRowToArray)),
        errorCount: parsed.errors.length,
    };
};

const parseAutoFallbackRows = (text: string) => {
    const parsed = parseCsvText(text);
    const autoDelimiter = typeof parsed.meta.delimiter === 'string' && parsed.meta.delimiter.length > 0
        ? parsed.meta.delimiter
        : null;

    return {
        rawRows: dropTrailingEmptyColumns(parsed.data.map(coerceRowToArray)),
        errorCount: parsed.errors.length,
        delimiter: autoDelimiter,
    };
};

const buildRawLineFallbackRows = (text: string, delimiter: string | null): RawCsvRow[] => {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    return lines
        .filter((line, index) => !(index === lines.length - 1 && line === ''))
        .map(line => (delimiter && line.includes(delimiter) ? line.split(delimiter) : [line]));
};

const buildFallbackCandidate = (delimiter: string | null, quoteChar: string | null): CandidateScore | null => {
    if (!delimiter) {
        return null;
    }
    return {
        delimiter,
        quoteChar: quoteChar ?? '',
        score: 0,
        errorCount: 0,
        rowCount: 0,
        nonEmptyRowCount: 0,
        dominantWidth: 0,
        dominantWidthCount: 0,
        delimiterHits: 0,
        unbalancedQuote: false,
        widthConsistency: 0,
        usableCoverage: 0,
        headerPlausibility: 0,
        quotedStability: 0,
    };
};

export const detectCsvDialect = (sample: string): CsvIntakeDetectionResult => {
    const sampleText = buildDetectionSample(sample);
    const sampledNonEmptyLines = countNonEmptyLines(sampleText.text);
    const candidates = scoreCandidates(sampleText);
    const best = candidates[0];
    const runnerUp = getAlternateDelimiterCandidate(candidates, best);
    const confidence = buildConfidence(best, runnerUp);
    const warnings = buildBaseWarnings(sampleText, best, runnerUp, confidence);
    const adjustedConfidence: CsvIntakeConfidence = warnings.some(warning => warning.code === 'malformed_quote')
        ? 'low'
        : confidence;
    if (adjustedConfidence !== 'high') {
        pushWarning(warnings, 'low_confidence', 'CSV dialect detection confidence is limited, so the imported structure should be reviewed in diagnostics.');
    }
    return createDetection('scored_candidate', best, runnerUp, adjustedConfidence, warnings, sampledNonEmptyLines);
};

export const parseCsvTextWithDetection = (text: string): CsvDetectionParseResult => {
    const sample = buildDetectionSample(text);
    const sampledNonEmptyLines = countNonEmptyLines(sample.text);
    const scoredCandidates = scoreCandidates(sample);
    const best = scoredCandidates[0];
    const runnerUp = getAlternateDelimiterCandidate(scoredCandidates, best);
    const confidence = buildConfidence(best, runnerUp);
    const scoredWarnings = buildBaseWarnings(sample, best, runnerUp, confidence);
    const effectiveBaseConfidence: CsvIntakeConfidence = scoredWarnings.some(warning => warning.code === 'malformed_quote')
        ? 'low'
        : confidence;

    if (best.score >= MIN_SCORED_CANDIDATE_SCORE) {
        const candidateParse = parseCandidateRows(text, best);
        const candidateWarnings = [...scoredWarnings];
        if (candidateParse.errorCount > 0) {
            pushWarning(candidateWarnings, 'parse_errors', `The selected CSV dialect produced ${candidateParse.errorCount} parser issue${candidateParse.errorCount === 1 ? '' : 's'} during full parsing.`);
        }
        const finalConfidence: CsvIntakeConfidence = candidateParse.errorCount > 0 && effectiveBaseConfidence === 'high'
            ? 'medium'
            : candidateParse.errorCount > 0
                ? 'low'
                : effectiveBaseConfidence;
        if (finalConfidence !== 'high') {
            pushWarning(candidateWarnings, 'low_confidence', 'CSV dialect detection confidence is limited, so the imported structure should be reviewed in diagnostics.');
        }

        if (candidateParse.rawRows.length > 0) {
            return {
                rawRows: candidateParse.rawRows,
                detection: createDetection(
                    'scored_candidate',
                    best,
                    runnerUp ?? null,
                    finalConfidence,
                    candidateWarnings,
                    sampledNonEmptyLines,
                    candidateParse.errorCount,
                ),
            };
        }
    }

    const autoParse = parseAutoFallbackRows(text);
    const autoWarnings = [...scoredWarnings];
    pushWarning(autoWarnings, 'low_confidence', 'CSV parsing fell back to PapaParse auto-detection because scored dialect selection was inconclusive.');
    if (autoParse.errorCount > 0) {
        pushWarning(autoWarnings, 'parse_errors', `PapaParse auto-detection reported ${autoParse.errorCount} parser issue${autoParse.errorCount === 1 ? '' : 's'}.`);
    }

    if (autoParse.rawRows.length > 0) {
        const autoCandidate = buildFallbackCandidate(autoParse.delimiter ?? best.delimiter, null);
        const autoConfidence: CsvIntakeConfidence = autoParse.errorCount === 0 && autoParse.delimiter ? 'medium' : 'low';
        return {
            rawRows: autoParse.rawRows,
            detection: createDetection(
                'papaparse_auto_fallback',
                autoCandidate,
                runnerUp ?? null,
                autoConfidence,
                autoWarnings,
                sampledNonEmptyLines,
                autoParse.errorCount,
            ),
        };
    }

    const fallbackDelimiter = autoParse.delimiter ?? best.delimiter ?? ',';
    const rawLineRows = buildRawLineFallbackRows(text, fallbackDelimiter);
    const rawLineWarnings = mergeWarnings(
        scoredWarnings,
        autoWarnings,
        [{
            code: 'low_confidence',
            message: 'CSV parsing fell back to raw line splitting, so quoted fields may not be preserved exactly.',
        }],
    );
    const rawLineCandidate = buildFallbackCandidate(fallbackDelimiter, null);

    return {
        rawRows: rawLineRows,
        detection: createDetection(
            'raw_line_fallback',
            rawLineCandidate,
            runnerUp ?? null,
            'low',
            rawLineWarnings,
            sampledNonEmptyLines,
            autoParse.errorCount,
        ),
    };
};
