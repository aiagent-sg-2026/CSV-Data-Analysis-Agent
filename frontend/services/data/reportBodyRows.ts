import {
        SUBTOTAL_ROW_PATTERN,
    SUMMARY_LABEL_PATTERN,
    TOTAL_ROW_PATTERN,
} from '../agent/reportShapeUtils';

/**
 * Row classification INSIDE a detected report body.
 *
 * Printed ERP reports interleave real records with layout artefacts: page
 * breaks that repeat the title block and the column headers, blank spacer
 * rows, and group subtotals. None of them is a record, and a subtotal that
 * stays in the table makes SUM() double count. The detection here is purely
 * structural so it works on raw cell grids (intake) and on resolved report
 * boundaries (canonicalization) alike:
 *
 * - blank: every cell empty.
 * - repeated_header: the row repeats a header row (or an outer header band)
 *   cell by cell.
 * - page_break: a sparse text row that repeats a title/metadata line from
 *   above the header (digits masked, so "Page 2 of 80" matches "Page 1 of
 *   80"), or an explicit page marker / "Continued" line.
 * - subtotal / total: a row carrying a summary label AND an amount that
 *   equals the sum of the data rows since an earlier summary row (or since
 *   the body start). A label alone is not enough: "Total" is also a valid
 *   word in a business name or category, so a "Total" row in the middle of
 *   valid data stays a data row unless its amounts reconcile.
 */

export type BodyRowKind = 'blank' | 'repeated_header' | 'page_break' | 'subtotal' | 'total';

export interface BodyRowFinding {
    kind: BodyRowKind;
    reason: string;
}

export interface BodyRowBoundary {
    headerRowIndex: number | null;
    headerLayerRowIndexes: number[];
    bodyStartIndex: number | null;
    summaryStartIndex: number | null;
    repeatedHeaderRowIndexes?: number[];
}

const MAX_LABEL_LENGTH = 60;
// Look back over this many earlier summary rows for a matching window; the
// whole body (window 0) is always checked as well.
const MAX_SUMMARY_WINDOWS = 8;
// A page-break line repeats within this many rows of a repeated header.
const PAGE_BREAK_ADJACENCY_ROWS = 6;
const MIN_SIGNATURE_LETTERS = 5;

const DATE_LIKE_PATTERN = /^(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/;
// A page marker is a cell that IS the marker ("Page 2 of 80", "Page 2",
// "- 2 -", "2 / 80"). A phrase that merely contains "page 3" ("Fix page 3
// header") is ordinary text. Cells longer than MAX_MARKER_LENGTH cannot be a
// marker, which also bounds every regex below on huge cells.
const PAGE_MARKER_CELL_PATTERN = /^(?:page\s*[:#]?\s*\d+(?:\s*(?:of|\/)\s*\d+)?|[-–]\s*\d+\s*[-–]|\d+\s*(?:of|\/)\s*\d+)$/i;
// A print footer starts with its phrase ("Printed by: ADMIN  Page 2 of 80"); a
// note that mentions "printed by" further in is not one.
const FOOTER_CELL_PATTERN = /^(?:reporting date|reporting currency|printed by|printed on|generated on)\b/i;
// "Continued...", "(continued)", "Cont'd", "Continued from previous page"; a heading
// such as "Continued operations" is a group label and must not match. The
// tail after from/on/to is free text, so no other part of the pattern overlaps it.
const CONTINUED_MARKER_PATTERN = /^[(\[\-–\s.…]*(?:continued|cont['’.]?d)\b(?:\s+(?:from|on|to)\b.*|[)\]\-–\s.…]*)$/i;
const MAX_MARKER_LENGTH = 120;
// Digits, separators and a sign never need more than this many characters.
const MAX_AMOUNT_LENGTH = 40;

// Nothing this module looks for (labels, markers, amounts, header labels) is
// longer than a few hundred characters, so a huge cell is cut before any
// normalisation: it stays non-empty but costs no more than a short one.
const MAX_CELL_TEXT = 2000;
const cellText = (value: unknown) => String(value ?? '').slice(0, MAX_CELL_TEXT).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const nonEmptyCells = (row: readonly unknown[]) => row.map(cellText).filter(Boolean);

const AMOUNT_PATTERN = /^(\()?\s*([-+])?\s*[$€£¥]?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)\s*(\))?\s*(-)?$/;

/**
 * Parses a printed amount: thousands separators, a leading currency symbol,
 * accounting negatives "(1,234.00)" and a trailing minus. Dates and anything
 * with letters are not amounts.
 */
export const parseReportAmount = (value: unknown): number | null => {
    const text = cellText(value);
    if (!text || text.length > MAX_AMOUNT_LENGTH || DATE_LIKE_PATTERN.test(text)) return null;
    const match = AMOUNT_PATTERN.exec(text);
    if (!match) return null;
    const [, openParen, sign, digits, closeParen, trailingMinus] = match;
    if (Boolean(openParen) !== Boolean(closeParen)) return null;
    const parsed = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(parsed)) return null;
    const negative = Boolean(openParen) || sign === '-' || Boolean(trailingMinus);
    return negative ? -parsed : parsed;
};

const countDecimals = (value: unknown) => /\.(\d+)\D*$/.exec(cellText(value))?.[1].length ?? 0;

const maskDigits = (text: string) => text.toLowerCase().replace(/\d+/g, '#');

const isMarkerCell = (text: string) =>
    text.length <= MAX_MARKER_LENGTH
    && (PAGE_MARKER_CELL_PATTERN.test(text) || CONTINUED_MARKER_PATTERN.test(text) || FOOTER_CELL_PATTERN.test(text));

/**
 * A page marker, continuation or print-footer line: at most three filled cells,
 * every one of them a marker or a date. A row with real data in another column
 * (a task name next to an owner) is never one.
 */
const isMarkerRow = (cells: string[]) =>
    cells.length > 0
    && cells.length <= 3
    && cells.some(isMarkerCell)
    && cells.every(cell => isMarkerCell(cell) || DATE_LIKE_PATTERN.test(cell));

const isSparseTextRow = (cells: string[]) =>
    cells.length > 0 && cells.length <= 2 && cells.every(cell => parseReportAmount(cell) === null);

const buildSignature = (cells: string[]) => cells.map(maskDigits).join(' | ');

const countLetters = (text: string) => (text.match(/[A-Za-zÀ-￿]/g) ?? []).length;

const isLabelCell = (text: string) =>
    text.length > 0
    && text.length <= MAX_LABEL_LENGTH
    && (SUBTOTAL_ROW_PATTERN.test(text) || TOTAL_ROW_PATTERN.test(text) || SUMMARY_LABEL_PATTERN.test(text));

/** True when the non-empty cells repeat the header row at the same columns. */
const repeatsHeader = (row: readonly unknown[], header: readonly string[]) => {
    const headerCells = header.map((text, index) => ({ text: text.toLowerCase(), index })).filter(cell => cell.text);
    if (headerCells.length === 0) return false;
    const rowCellsByIndex = row.map(cell => cellText(cell).toLowerCase());
    const present = rowCellsByIndex.filter(Boolean).length;
    if (present < 2) return false;
    const matched = headerCells.filter(cell => rowCellsByIndex[cell.index] === cell.text).length;
    // Every filled cell must be a header label, and most of the header must be
    // present: a data row that merely shares a word with the header is not an echo.
    return matched >= Math.max(2, Math.ceil(headerCells.length * 0.6)) && matched >= present - 1;
};

interface WindowSums {
    all: Float64Array;
    clean: Float64Array;
}

const snapshot = (sums: WindowSums): WindowSums => ({
    all: Float64Array.from(sums.all),
    clean: Float64Array.from(sums.clean),
});

/**
 * Finds the body rows that are not records. Only rows in
 * [bodyStartIndex, summaryStartIndex) are reported; the result maps the raw
 * row index to its finding.
 */
export const classifyBodyRows = (
    rows: readonly (readonly string[])[],
    boundary: BodyRowBoundary,
): Map<number, BodyRowFinding> => {
    const findings = new Map<number, BodyRowFinding>();
    const bodyStart = boundary.bodyStartIndex;
    if (bodyStart === null || bodyStart < 0) return findings;
    const bodyEnd = Math.min(boundary.summaryStartIndex ?? rows.length, rows.length);
    if (bodyEnd <= bodyStart) return findings;

    const headerIndexes = Array.from(new Set([
        boundary.headerRowIndex,
        ...boundary.headerLayerRowIndexes,
    ].filter((value): value is number => typeof value === 'number' && value >= 0 && value < bodyStart)));
    const headerRows = headerIndexes.map(index => (rows[index] ?? []).map(cellText));
    const knownRepeated = new Set(boundary.repeatedHeaderRowIndexes ?? []);

    // Title and metadata lines above the header. A page break prints them again.
    const titleSignatures = new Set<string>();
    for (let index = 0; index < bodyStart; index += 1) {
        if (headerIndexes.includes(index)) continue;
        const cells = nonEmptyCells(rows[index] ?? []);
        if (!isSparseTextRow(cells)) continue;
        const signature = buildSignature(cells);
        if (countLetters(signature) >= MIN_SIGNATURE_LETTERS) titleSignatures.add(signature);
    }

    // Pass 1: structure rows that need no running state.
    const repeatedHeaderRows = new Set<number>();
    // Title lines and marker lines are page breaks only when they repeat or sit
    // next to a repeated header: a single heading that happens to match a title
    // above the header (a group heading such as "Region: ASEAN"), or a lone
    // "Page 2" cell, is kept.
    const lineCandidates: Array<{ index: number; signature: string; reason: string }> = [];
    const signatureCounts = new Map<string, number>();
    for (let index = bodyStart; index < bodyEnd; index += 1) {
        const row = rows[index] ?? [];
        const cells = nonEmptyCells(row);
        if (cells.length === 0) {
            findings.set(index, { kind: 'blank', reason: 'Every cell is empty.' });
            continue;
        }
        if (knownRepeated.has(index) || headerRows.some(header => repeatsHeader(row, header))) {
            repeatedHeaderRows.add(index);
            findings.set(index, { kind: 'repeated_header', reason: 'Repeats the column header cell by cell.' });
            continue;
        }
        const signature = buildSignature(cells);
        let reason: string | null = null;
        if (isMarkerRow(cells)) {
            reason = 'Page marker, continuation line or print footer inside the body.';
        } else if (isSparseTextRow(cells) && titleSignatures.has(signature)) {
            reason = 'Repeats a title or parameter line from above the header.';
        }
        if (reason) {
            lineCandidates.push({ index, signature, reason });
            signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
        }
    }
    for (const { index, signature, reason } of lineCandidates) {
        const recurs = (signatureCounts.get(signature) ?? 0) >= 2;
        const nearRepeatedHeader = [...repeatedHeaderRows].some(headerIndex => Math.abs(headerIndex - index) <= PAGE_BREAK_ADJACENCY_ROWS);
        if (recurs || nearRepeatedHeader) findings.set(index, { kind: 'page_break', reason });
    }

    // Pass 2: summary rows that reconcile with the data rows above them.
    let width = 0;
    for (let index = bodyStart; index < bodyEnd; index += 1) width = Math.max(width, rows[index]?.length ?? 0);
    if (width === 0) return findings;
    const running: WindowSums = { all: new Float64Array(width), clean: new Float64Array(width) };
    // windows[0] is the body start; every verified summary row opens a new one.
    const windows: WindowSums[] = [snapshot(running)];

    for (let index = bodyStart; index < bodyEnd; index += 1) {
        if (findings.has(index)) continue;
        const row = rows[index] ?? [];
        const texts = row.map(cellText);
        const labelIndexes = texts.flatMap((text, column) => (isLabelCell(text) ? [column] : []));

        if (labelIndexes.length > 0 && !texts.some(text => DATE_LIKE_PATTERN.test(text))) {
            const labelText = texts[labelIndexes[0]];
            const candidateWindows = [
                ...windows.slice(Math.max(1, windows.length - MAX_SUMMARY_WINDOWS)).reverse(),
                windows[0],
            ];
            // Printed totals are often shifted a column or two away from the
            // column they add up (a total printed under a spacer column), so
            // each amount is compared with the window sum of every column,
            // the same column first.
            let reconciledColumn = -1;
            for (let column = 0; column < width && reconciledColumn < 0; column += 1) {
                if (labelIndexes.includes(column)) continue;
                const amount = parseReportAmount(texts[column]);
                if (amount === null || amount === 0) continue;
                // Equal at the precision the report prints the summary with.
                const tolerance = 0.5 * 10 ** -countDecimals(texts[column]) + 1e-7;
                const matches = (target: number, current: Float64Array, base: Float64Array) => {
                    const windowSum = current[target] - base[target];
                    return windowSum !== 0 && Math.abs(windowSum - amount) <= tolerance;
                };
                const targets = [column, ...Array.from({ length: width }, (_, target) => target).filter(target => target !== column)];
                // "all" counts every non-summary row; "clean" also leaves out
                // summary-labelled rows that did not reconcile themselves.
                const target = targets.find(candidate =>
                    candidateWindows.some(start =>
                        matches(candidate, running.all, start.all) || matches(candidate, running.clean, start.clean)),
                );
                if (target !== undefined) reconciledColumn = target;
            }
            if (reconciledColumn >= 0) {
                const kind: BodyRowKind = SUBTOTAL_ROW_PATTERN.test(labelText) ? 'subtotal' : 'total';
                findings.set(index, {
                    kind,
                    reason: `"${labelText}" row; its amount equals the sum of column ${reconciledColumn + 1} over the rows above it.`,
                });
                windows.push(snapshot(running));
                continue;
            }
        }

        // A data row (including a summary-labelled row that did not reconcile).
        texts.forEach((text, column) => {
            const amount = parseReportAmount(text);
            if (amount === null) return;
            running.all[column] += amount;
            if (labelIndexes.length === 0) running.clean[column] += amount;
        });
    }
    return findings;
};

export interface BodyWithoutNoise {
    rows: string[][];
    bodyStartIndex: number;
    summaryStartIndex: number;
    findings: Map<number, BodyRowFinding>;
}

/**
 * The raw grid with the body's non-record rows removed. Column-role
 * statistics (carry-forward, fact density, row identity) must be computed on
 * records only: page-break blocks and spacer rows would otherwise dilute them.
 * Row indexes before the body are unchanged, so only the end shifts.
 */
export const withoutBodyNoise = (
    rows: readonly (readonly string[])[],
    boundary: BodyRowBoundary,
): BodyWithoutNoise => {
    const findings = classifyBodyRows(rows, boundary);
    const bodyStartIndex = boundary.bodyStartIndex ?? 0;
    const summaryStartIndex = Math.min(boundary.summaryStartIndex ?? rows.length, rows.length);
    if (findings.size === 0) {
        return { rows: rows.map(row => [...row]), bodyStartIndex, summaryStartIndex, findings };
    }
    return {
        rows: rows.filter((_, index) => !findings.has(index)).map(row => [...row]),
        bodyStartIndex,
        summaryStartIndex: summaryStartIndex - findings.size,
        findings,
    };
};
