import type { CsvData, CsvRow, DataOperation, RowRoleCandidate } from '../../types';
import {
    PLACEHOLDER_PATTERN,
    SUBTOTAL_ROW_PATTERN,
    getColumns,
    getRows,
    isMissingValueMarker,
    isNumericLike,
} from './reportShapeUtils';

/**
 * Recognition and deterministic reshape of a "period-header wide table":
 * one header row whose label column(s) name a series and every other column
 * is a calendar period of one grain (SingStat-style exports such as
 * `DataSeries,2026Aug,2026Jul,...` or `DataSeries,2025,2024,...`). Child
 * series are often indented under their parent total with leading spaces.
 *
 * The recognition is deliberately strict — every non-label header must parse
 * as a period, and every period cell must be a number or an explicit
 * missing-value marker — so melting such a table is lossless and needs no
 * human judgement. Anything looser stays on the existing review path.
 */

export type PeriodGrain = 'year' | 'quarter' | 'month';

export interface ParsedPeriodLabel {
    grain: PeriodGrain;
    /** ISO date of the first day of the period, e.g. 2026-08-01. */
    start: string;
}

export interface PeriodWideTableDetection {
    labelColumns: string[];
    /** Period columns in chronological order. */
    periodColumns: Array<{ column: string; period: ParsedPeriodLabel }>;
    grain: PeriodGrain;
}

export type PeriodWideRowClass = 'fact' | 'subtotal' | 'total';

export interface PeriodWideRowHierarchy {
    level: number;
    parentIndex: number | null;
    rowClass: PeriodWideRowClass;
}

export interface PeriodWideReshape {
    detection: PeriodWideTableDetection;
    /** Wide body rows with trimmed labels and hierarchy columns added. */
    sourceRows: CsvRow[];
    operations: DataOperation[];
    hasHierarchy: boolean;
}

export const PERIOD_WIDE_OUTPUT_COLUMNS = {
    parent: 'ParentSeries',
    depth: 'HierarchyDepth',
    rowClass: 'RowClass',
    period: 'Period',
    value: 'Value',
    sourceColumn: 'SourceColumnName',
    sourceRow: 'SourceRowIndex',
} as const;

const MIN_PERIOD_COLUMNS = 4;
const MAX_LABEL_COLUMNS = 3;
// Sparse public series legitimately carry many "na" cells; below this share
// of numeric cells the table is more likely a form or a layout grid.
const MIN_NUMERIC_CELL_RATIO = 0.3;
const MIN_YEAR = 1900;
const MAX_YEAR = 2099;

const MONTH_NUMBER_BY_NAME: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
};

const pad2 = (value: number) => String(value).padStart(2, '0');

const toYear = (value: string): number | null => {
    const year = Number(value);
    return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
};

const buildMonth = (yearText: string, month: number | undefined): ParsedPeriodLabel | null => {
    const year = toYear(yearText);
    if (year === null || !month) return null;
    return { grain: 'month', start: `${year}-${pad2(month)}-01` };
};

const buildQuarter = (yearText: string, quarterText: string): ParsedPeriodLabel | null => {
    const year = toYear(yearText);
    const quarter = Number(quarterText);
    if (year === null || quarter < 1 || quarter > 4) return null;
    return { grain: 'quarter', start: `${year}-${pad2(quarter * 3 - 2)}-01` };
};

/**
 * Parses a header label that names exactly one calendar period. Returns null
 * for anything else, including labels that merely contain a year.
 */
export const parsePeriodHeaderLabel = (label: string): ParsedPeriodLabel | null => {
    const text = String(label ?? '').trim();
    if (!text) return null;

    if (/^\d{4}$/.test(text)) {
        const year = toYear(text);
        return year === null ? null : { grain: 'year', start: `${year}-01-01` };
    }
    let match = /^(\d{4})\s*[-_/ ]?\s*([A-Za-z]{3,9})$/.exec(text);
    if (match) return buildMonth(match[1], MONTH_NUMBER_BY_NAME[match[2].toLowerCase()]);
    match = /^([A-Za-z]{3,9})\s*[-_/ ]?\s*(\d{4})$/.exec(text);
    if (match) return buildMonth(match[2], MONTH_NUMBER_BY_NAME[match[1].toLowerCase()]);
    match = /^(\d{4})\s*(?:[-/.]|M)\s*(0[1-9]|1[0-2])$/i.exec(text);
    if (match) return buildMonth(match[1], Number(match[2]));
    match = /^(\d{4})\s*[-_ ]?\s*Q([1-4])$/i.exec(text);
    if (match) return buildQuarter(match[1], match[2]);
    match = /^Q([1-4])\s*[-_ ]?\s*(\d{4})$/i.exec(text);
    if (match) return buildQuarter(match[2], match[1]);
    return null;
};

const isBlankCells = (cells: string[]) => cells.every(cell => cell.trim() === '');

/**
 * Detects a period-header wide table from header labels and body rows given
 * as cells aligned with the headers. Column order is not relied on, because
 * CsvData rows enumerate integer-like keys ("2025") before other keys.
 */
export const detectPeriodWideTable = (
    headers: string[],
    bodyRows: string[][],
): PeriodWideTableDetection | null => {
    const trimmedHeaders = headers.map(header => String(header ?? '').trim());
    if (trimmedHeaders.length < MIN_PERIOD_COLUMNS + 1) return null;
    if (trimmedHeaders.some(header => !header || PLACEHOLDER_PATTERN.test(header))) return null;
    if (new Set(trimmedHeaders.map(header => header.toLowerCase())).size !== trimmedHeaders.length) return null;

    const parsed = trimmedHeaders.map(parsePeriodHeaderLabel);
    const periodIndexes = parsed.flatMap((period, index) => (period ? [index] : []));
    const labelIndexes = parsed.flatMap((period, index) => (period ? [] : [index]));
    if (periodIndexes.length < MIN_PERIOD_COLUMNS) return null;
    if (labelIndexes.length < 1 || labelIndexes.length > MAX_LABEL_COLUMNS) return null;

    const grain = parsed[periodIndexes[0]]!.grain;
    if (periodIndexes.some(index => parsed[index]!.grain !== grain)) return null;
    const starts = periodIndexes.map(index => parsed[index]!.start);
    if (new Set(starts).size !== starts.length) return null;

    const rows = bodyRows.filter(row => !isBlankCells(row.map(cell => String(cell ?? ''))));
    if (rows.length === 0) return null;

    let numericCells = 0;
    let periodCells = 0;
    for (const row of rows) {
        const labels = labelIndexes.map(index => String(row[index] ?? '').trim()).filter(Boolean);
        // Every record needs a textual series name; a numeric "label" means
        // the header is not a label column (or the row is misaligned).
        if (!labels.some(label => !isNumericLike(label))) return null;
        for (const index of periodIndexes) {
            const cell = String(row[index] ?? '').trim();
            periodCells += 1;
            if (isNumericLike(cell)) {
                numericCells += 1;
            } else if (cell !== '' && !isMissingValueMarker(cell)) {
                return null;
            }
        }
    }
    if (periodCells === 0 || numericCells / periodCells < MIN_NUMERIC_CELL_RATIO) return null;
    // A mostly numeric non-period column (a "Total" or "Change %" column) is a
    // measure, not a series label; repeating it on every melted row would be
    // wrong, so such tables stay on the generic wide-table path.
    const hasMeasureLikeLabelColumn = labelIndexes.some(index => {
        const values = rows.map(row => String(row[index] ?? '').trim()).filter(Boolean);
        return values.filter(value => isNumericLike(value) || isMissingValueMarker(value)).length * 2 > values.length;
    });
    if (hasMeasureLikeLabelColumn) return null;

    const periodColumns = periodIndexes
        .map(index => ({ column: trimmedHeaders[index], period: parsed[index]! }))
        .sort((left, right) => left.period.start.localeCompare(right.period.start));
    return {
        labelColumns: labelIndexes.map(index => trimmedHeaders[index]),
        periodColumns,
        grain,
    };
};

const getCsvBodyCells = (data: CsvData | null, columns: string[]) =>
    getRows(data).map(row => columns.map(column => String(row[column] ?? '')));

const isSingleHeaderCsvData = (data: CsvData | null) => Boolean(
    data
    && (data.headerDepth ?? 1) === 1
    && (data.headerLayers?.length ?? 0) === 0,
);

export const detectPeriodWideTableFromCsvData = (data: CsvData | null): PeriodWideTableDetection | null => {
    if (!isSingleHeaderCsvData(data)) return null;
    const columns = getColumns(data);
    return detectPeriodWideTable(columns, getCsvBodyCells(data, columns));
};

const measureIndent = (label: string) => {
    const leading = /^[\s ]*/.exec(label)?.[0] ?? '';
    return [...leading].reduce((width, char) => width + (char === '\t' ? 4 : 1), 0);
};

const TOTAL_LABEL_PATTERN = /^(?:grand\s+|net\s+)?total\b/i;

const classifyParent = (label: string): PeriodWideRowClass =>
    TOTAL_LABEL_PATTERN.test(label.trim()) && !SUBTOTAL_ROW_PATTERN.test(label.trim()) ? 'total' : 'subtotal';

/**
 * Resolves parent/child structure from label indentation. A row followed by
 * more-indented rows is a parent whose value aggregates those children, so it
 * is classed as subtotal/total to keep it out of detail-level aggregation.
 * Without indentation, only explicitly total-labelled rows are flagged.
 * Returns null when the labels carry no hierarchy at all.
 */
export const resolvePeriodWideHierarchy = (labels: string[]): PeriodWideRowHierarchy[] | null => {
    if (labels.length === 0) return null;
    const indents = labels.map(measureIndent);
    const distinctIndents = [...new Set(indents)].sort((left, right) => left - right);

    if (distinctIndents.length > 1) {
        const levels = indents.map(indent => distinctIndents.indexOf(indent));
        const parents: Array<number | null> = [];
        const stack: number[] = [];
        for (let index = 0; index < labels.length; index += 1) {
            while (stack.length > 0 && indents[stack[stack.length - 1]] >= indents[index]) {
                stack.pop();
            }
            const parentIndex = stack.length > 0 ? stack[stack.length - 1] : null;
            // An indented row without any less-indented row above it has no
            // recoverable parent, so the indentation is not a hierarchy.
            if (parentIndex === null && levels[index] > 0) return null;
            parents.push(parentIndex);
            stack.push(index);
        }
        const parentSet = new Set(parents.filter((value): value is number => value !== null));
        return labels.map((label, index) => ({
            level: levels[index],
            parentIndex: parents[index],
            rowClass: parentSet.has(index) ? classifyParent(label) : 'fact',
        }));
    }

    const totalRows = labels.filter(label => TOTAL_LABEL_PATTERN.test(label.trim()) || SUBTOTAL_ROW_PATTERN.test(label.trim()));
    // A table made only of total-labelled rows has no detail rows to protect.
    if (totalRows.length === 0 || totalRows.length === labels.length) return null;
    return labels.map(label => ({
        level: 0,
        parentIndex: null,
        rowClass: SUBTOTAL_ROW_PATTERN.test(label.trim())
            ? 'subtotal'
            : TOTAL_LABEL_PATTERN.test(label.trim()) ? 'total' : 'fact',
    }));
};

/**
 * Builds the deterministic reshape for a detected period-header wide table:
 * hierarchy-annotated wide rows plus the unpivot and numeric cast that turn
 * them into one row per (series, period). Missing markers become NULL.
 */
export const buildPeriodWideReshape = (data: CsvData | null): PeriodWideReshape | null => {
    const detection = detectPeriodWideTableFromCsvData(data);
    if (!detection) return null;
    const columns = getColumns(data);
    const reserved = new Set<string>(Object.values(PERIOD_WIDE_OUTPUT_COLUMNS).map(column => column.toLowerCase()));
    if (columns.some(column => reserved.has(column.trim().toLowerCase()))) return null;

    const periodColumnSet = new Set(detection.periodColumns.map(entry => entry.column));
    const bodyRows = getRows(data).filter(row =>
        columns.some(column => String(row[column] ?? '').trim() !== ''),
    );
    const hierarchyLabelColumn = detection.labelColumns.length === 1 ? detection.labelColumns[0] : null;
    const hierarchy = hierarchyLabelColumn
        ? resolvePeriodWideHierarchy(bodyRows.map(row => String(row[hierarchyLabelColumn] ?? '')))
        : null;

    const sourceRows: CsvRow[] = bodyRows.map((row, rowIndex) => {
        const nextRow: CsvRow = {};
        detection.labelColumns.forEach(column => {
            const value = row[column];
            nextRow[column] = typeof value === 'string' ? value.trim() : value ?? null;
        });
        if (hierarchy && hierarchyLabelColumn) {
            const entry = hierarchy[rowIndex];
            nextRow[PERIOD_WIDE_OUTPUT_COLUMNS.parent] = entry.parentIndex === null
                ? null
                : String(bodyRows[entry.parentIndex][hierarchyLabelColumn] ?? '').trim();
            nextRow[PERIOD_WIDE_OUTPUT_COLUMNS.depth] = entry.level;
            nextRow[PERIOD_WIDE_OUTPUT_COLUMNS.rowClass] = entry.rowClass;
        }
        columns.filter(column => periodColumnSet.has(column)).forEach(column => {
            nextRow[column] = row[column] ?? null;
        });
        return nextRow;
    });

    const keepColumns = [
        ...detection.labelColumns,
        ...(hierarchy
            ? [PERIOD_WIDE_OUTPUT_COLUMNS.parent, PERIOD_WIDE_OUTPUT_COLUMNS.depth, PERIOD_WIDE_OUTPUT_COLUMNS.rowClass]
            : []),
    ];
    const operations: DataOperation[] = [
        {
            id: 'period-wide-unpivot',
            type: 'unpivot_columns',
            reason: `Melt ${detection.periodColumns.length} ${detection.grain} period columns into one row per series and period.`,
            sourceColumns: detection.periodColumns.map(entry => entry.column),
            // The raw period label doubles as the unpivot key and the source
            // coordinate; the parsed period start is the analysis-facing time axis.
            keyColumn: PERIOD_WIDE_OUTPUT_COLUMNS.sourceColumn,
            valueColumn: PERIOD_WIDE_OUTPUT_COLUMNS.value,
            keepColumns,
            labelColumns: [{
                outputColumn: PERIOD_WIDE_OUTPUT_COLUMNS.period,
                mappings: detection.periodColumns.map(entry => ({
                    sourceColumn: entry.column,
                    label: entry.period.start,
                })),
            }],
            sourceColumnNameColumn: PERIOD_WIDE_OUTPUT_COLUMNS.sourceColumn,
            sourceRowIndexColumn: PERIOD_WIDE_OUTPUT_COLUMNS.sourceRow,
        },
        {
            id: 'period-wide-cast-value',
            type: 'cast_column',
            reason: 'Parse period values as numbers; missing-value markers such as "na" and "-" become NULL, never 0.',
            column: PERIOD_WIDE_OUTPUT_COLUMNS.value,
            targetType: 'number',
        },
    ];

    return { detection, sourceRows, operations, hasHierarchy: Boolean(hierarchy) };
};

/**
 * Row roles for the shape detector, aligned with the reshape's hierarchy so
 * the reshape hypothesis expects exactly the hierarchy columns it will emit.
 */
export const buildPeriodWideRowRoles = (
    data: CsvData | null,
    detection: PeriodWideTableDetection,
): RowRoleCandidate[] => {
    const rows = getRows(data);
    const columns = getColumns(data);
    const labelColumn = detection.labelColumns.length === 1 ? detection.labelColumns[0] : null;
    const bodyIndexes = rows.flatMap((row, index) =>
        columns.some(column => String(row[column] ?? '').trim() !== '') ? [index] : []);
    const hierarchy = labelColumn
        ? resolvePeriodWideHierarchy(bodyIndexes.map(index => String(rows[index][labelColumn] ?? '')))
        : null;
    const byRowIndex = new Map(bodyIndexes.map((rowIndex, position) => [rowIndex, hierarchy?.[position] ?? null]));
    return rows.map((_, rowIndex) => {
        if (!byRowIndex.has(rowIndex)) {
            return { rowIndex, role: 'noise' as const, confidence: 0.98 };
        }
        const entry = byRowIndex.get(rowIndex);
        return {
            rowIndex,
            role: entry?.rowClass ?? 'fact',
            confidence: 0.9,
            depth: entry?.level ?? 0,
        };
    });
};
