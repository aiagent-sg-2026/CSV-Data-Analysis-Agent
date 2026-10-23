/**
 * Recognises a text report saved with a .csv extension: space-aligned columns,
 * `-----` rules, form-feed page breaks, no delimiter at all.
 *
 * Detection is deliberately conservative. A layout is only reported when the
 * file has a header line directly above a rule line AND the whitespace gaps
 * that run through every sampled data line cut the header into exactly the same
 * number of columns. Anything weaker is reported as "unsplittable" so the
 * caller can say the file is not delimited without guessing at columns.
 */

type RawRow = string[];

export type FixedWidthLayout =
    | {
        kind: 'split';
        /** Start offset of every column; the first entry is always 0. */
        cuts: number[];
        /** Positions that are blank in (nearly) every data line; text found there spans columns. */
        isGap: boolean[];
        headerText: string;
        dataLineCount: number;
    }
    | { kind: 'unsplittable'; reason: string };

const MIN_COLUMNS = 3;
const MIN_DATA_LINES = 5;
/** Share of data lines allowed to overflow into a gap before it stops being a gap. */
const GAP_OVERFLOW_TOLERANCE = 0.03;
const RULE_PATTERN = /^[-=_*~\s]+$/;
const SEGMENT_PATTERN = /\S+(?: \S+)*/g;
const NUMERIC_TOKEN_PATTERN = /^[-+(]?[\d.,]+\)?%?$/;

const stripPageBreaks = (line: string) => line.replace(/\f/g, '');

/** A line made only of rule characters, long enough to be a divider and not a stray dash. */
export const isRuleLine = (line: string): boolean => {
    const stripped = stripPageBreaks(line);
    const marks = stripped.replace(/\s/g, '');
    return marks.length >= 8 && RULE_PATTERN.test(stripped);
};

const isBlank = (line: string) => stripPageBreaks(line).trim().length === 0;

const findSegments = (line: string) =>
    Array.from(line.matchAll(SEGMENT_PATTERN), match => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));

type Gaps = { isGap: boolean[]; width: number };

const buildGaps = (header: string, dataLines: string[], segments: Array<{ start: number; end: number }>): Gaps => {
    const lines = [header, ...dataLines];
    const width = Math.max(...lines.map(line => line.length));
    const counts = new Array<number>(width).fill(0);
    for (const line of lines) {
        for (let position = 0; position < line.length; position += 1) {
            if (line[position] !== ' ') counts[position] += 1;
        }
    }
    const tolerance = Math.floor(lines.length * GAP_OVERFLOW_TOLERANCE);
    const isGap = counts.map(count => count <= tolerance);
    // The header's own words, including the single spaces inside multi-word
    // labels such as "UNIT COST", always belong to a column.
    for (const segment of segments) {
        for (let position = segment.start; position < segment.end; position += 1) isGap[position] = false;
    }
    return { isGap, width };
};

const blocksOf = (gaps: Gaps) => {
    const blocks: Array<{ start: number; end: number }> = [];
    let start = -1;
    for (let position = 0; position <= gaps.width; position += 1) {
        const inside = position < gaps.width && !gaps.isGap[position];
        if (inside && start < 0) start = position;
        if (!inside && start >= 0) {
            blocks.push({ start, end: position });
            start = -1;
        }
    }
    return blocks;
};

/**
 * Probes the detection sample's lines. Returns null unless the text shows both a
 * rule line and a multi-column header line above it, so ordinary CSVs that merely
 * contain a dashed row are never labelled as text reports.
 */
export const detectFixedWidthLayout = (sampleLines: string[]): FixedWidthLayout | null => {
    const lines = sampleLines.map(stripPageBreaks);
    if (!lines.some(isRuleLine)) return null;
    // Tabs are delimiters, not alignment; a rule line alone does not make a text report.
    if (lines.some(line => line.includes('\t'))) return null;

    // Data lines are the runs that follow a rule placed under the header (the
    // header repeats on every page). Titles and totals sit outside those runs.
    const collectDataLines = (headerText: string) => {
        const collected: string[] = [];
        for (let index = 1; index < lines.length; index += 1) {
            if (!isRuleLine(lines[index]) || lines[index - 1].trim() !== headerText) continue;
            for (let next = index + 1; next < lines.length; next += 1) {
                if (isBlank(lines[next]) || isRuleLine(lines[next])) break;
                collected.push(lines[next]);
            }
        }
        return collected;
    };

    // A title above its own rule looks like a header too; the real header is the
    // candidate with the longest run of lines underneath it.
    let header = '';
    let dataLines: string[] = [];
    for (let index = 0; index + 2 < lines.length; index += 1) {
        if (
            isBlank(lines[index]) || isRuleLine(lines[index])
            || !isRuleLine(lines[index + 1])
            || isBlank(lines[index + 2]) || isRuleLine(lines[index + 2])
            || findSegments(lines[index]).length < MIN_COLUMNS
        ) continue;
        const candidateLines = collectDataLines(lines[index].trim());
        if (candidateLines.length > dataLines.length || header === '') {
            header = lines[index];
            dataLines = candidateLines;
        }
    }
    if (header === '') return null;

    const headerText = header.trim();
    const segments = findSegments(header);
    if (dataLines.length < MIN_DATA_LINES) return { kind: 'unsplittable', reason: 'too few data lines under the header' };

    const gaps = buildGaps(header, dataLines, segments);
    const blocks = blocksOf(gaps);
    const segmentsPerBlock = blocks.map(block =>
        segments.filter(segment => segment.start >= block.start && segment.end <= block.end).length);
    if (blocks.length !== segments.length || segmentsPerBlock.some(count => count !== 1)) {
        return { kind: 'unsplittable', reason: 'the gaps between data lines do not match the header columns' };
    }

    return {
        kind: 'split',
        cuts: blocks.map((block, index) => (index === 0 ? 0 : block.start)),
        isGap: gaps.isGap,
        headerText,
        dataLineCount: dataLines.length,
    };
};

const columnAt = (cuts: number[], position: number) => {
    let column = 0;
    for (let index = 0; index < cuts.length; index += 1) {
        if (cuts[index] <= position) column = index;
    }
    return column;
};

const sliceLine = (line: string, cuts: number[], isGap: boolean[]): RawRow => {
    const fits = !Array.from(line).some((char, position) => char !== ' ' && isGap[position] === true);
    if (fits) {
        return cuts.map((cut, index) => line.slice(cut, index + 1 < cuts.length ? cuts[index + 1] : undefined).trim());
    }
    // A title, total or footer that runs across the gaps. Without a number it is
    // plain prose (title, note): keep it as one cell instead of tearing it apart
    // at positions that mean nothing for it. With numbers (a TOTAL line), place
    // each phrase in the column it starts in; numbers go by their right edge
    // because they are right-aligned.
    const phrases = Array.from(line.matchAll(/\S+(?: \S+)*/g));
    if (!phrases.some(match => NUMERIC_TOKEN_PATTERN.test(match[0]))) {
        return cuts.map((_, index) => (index === 0 ? phrases.map(match => match[0]).join(' ') : ''));
    }
    const cells = cuts.map(() => '');
    for (const match of phrases) {
        const start = match.index ?? 0;
        const end = start + match[0].length - 1;
        const column = columnAt(cuts, NUMERIC_TOKEN_PATTERN.test(match[0]) ? end : start);
        cells[column] = cells[column] ? `${cells[column]} ${match[0]}` : match[0];
    }
    return cells;
};

/** Slices the whole text by the detected columns. Rules and page-break lines are dropped. */
export const sliceFixedWidthRows = (text: string, layout: Extract<FixedWidthLayout, { kind: 'split' }>): RawRow[] => {
    const lines = text.split(/\r\n|\n|\r/);
    const { cuts, isGap } = layout;
    const rows: RawRow[] = [];
    for (const rawLine of lines) {
        const hadPageBreak = rawLine.includes('\f');
        const line = stripPageBreaks(rawLine);
        if (isRuleLine(line)) continue;
        if (line.trim() === '') {
            // A line holding only a form feed is a page break, not an empty record.
            if (!hadPageBreak) rows.push(['']);
            continue;
        }
        rows.push(sliceLine(line, cuts, isGap));
    }
    return rows;
};
