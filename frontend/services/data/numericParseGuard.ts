import type {
    ColumnRegistry,
    CsvData,
    CsvRow,
    NumericParseCheck,
    NumericParseFinding,
    QueryPlan,
} from '../../types';
import { buildSemanticDatasetVersion } from '../agent/datasetSemantics';
import { isMissingCellValue } from '../duckdb/dimensionNormalization';
import { executeManagedDataQuery } from '../duckdb/queryEngine';
import { buildColumnNumberParser } from './dataProfiler';
import { isIdentifierHeader } from './numberLocale';

/**
 * Numeric parse reconciliation.
 *
 * A measure column is read twice by independent code: (a) the query engine sums
 * the column that was loaded for analysis (what every card uses), (b) this module
 * parses the same column from the original imported text with the JS number
 * parser and the column's style decision. When the totals or medians disagree,
 * some step (cleaning, canonicalization, a SQL cast) changed the numbers, and
 * cards that aggregate the column must not be shown as verified. This catches the
 * whole class of silent errors, such as a decimal comma read as a thousands
 * separator, rather than one known cause.
 */

// Over this many parsed cells the check is skipped: it must stay cheap, and a very
// large file is loaded through a preview path whose rows are not the whole file.
const MAX_CHECKED_CELLS = 4_000_000;
const AGGREGATE_CHUNK_COLUMNS = 20;
const RELATIVE_TOLERANCE = 1e-6;
const ABSOLUTE_TOLERANCE = 1e-6;
const MIN_NUMERIC_SHARE = 0.5;
// Lineage and helper columns the pipeline adds; they have no original text.
const PIPELINE_COLUMN_PATTERN = /^(sourcerowindex|hierarchydepth|rowrole|resolvedrowrole|rowclass|sectionlabel|headerpath|carryforwardappliedcolumns|sourcecolumnname)$/i;

export type ColumnAggregates = { sum: number | null; median: number | null };
export type LoadedAggregateReader = (columns: string[]) => Promise<Map<string, ColumnAggregates> | null>;

const isClose = (left: number | null, right: number | null) => {
    if (left === null || right === null) return left === right;
    return Math.abs(left - right) <= RELATIVE_TOLERANCE * Math.max(Math.abs(left), Math.abs(right)) + ABSOLUTE_TOLERANCE;
};

const medianOf = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

const buildSkipped = (datasetVersion: string | null, note: string, startedAt: number): NumericParseCheck => ({
    datasetVersion,
    status: 'skipped',
    checkedColumns: [],
    findings: [],
    note,
    durationMs: Math.round(performance.now() - startedAt),
});

/**
 * Compares the loaded columns with the original imported rows. The two row sets
 * are only comparable when they have the same length, because a cleaned or
 * canonical dataset may legitimately drop non-data rows; otherwise the check is
 * skipped and says why.
 */
export const reconcileNumericColumns = async (input: {
    datasetVersion: string | null;
    sourceRows: readonly CsvRow[];
    loadedRows: readonly CsvRow[];
    readLoadedAggregates: LoadedAggregateReader;
}): Promise<NumericParseCheck> => {
    const startedAt = performance.now();
    const { datasetVersion, sourceRows, loadedRows } = input;
    if (sourceRows.length === 0 || loadedRows.length === 0) {
        return buildSkipped(datasetVersion, 'No rows to compare.', startedAt);
    }
    if (sourceRows.length !== loadedRows.length) {
        return buildSkipped(
            datasetVersion,
            `Row counts differ (original ${sourceRows.length}, loaded ${loadedRows.length}), so the columns cannot be compared row for row.`,
            startedAt,
        );
    }

    const loadedColumns = new Set(Object.keys(loadedRows[0] ?? {}));
    const candidateColumns = Object.keys(sourceRows[0] ?? {})
        .filter(column => loadedColumns.has(column) && !PIPELINE_COLUMN_PATTERN.test(column) && !isIdentifierHeader(column));
    if (candidateColumns.length * sourceRows.length > MAX_CHECKED_CELLS) {
        return buildSkipped(datasetVersion, 'The dataset is too large for the numeric parse check.', startedAt);
    }

    const parse = buildColumnNumberParser(sourceRows, candidateColumns);
    const source = new Map<string, { sum: number; median: number | null }>();
    for (const column of candidateColumns) {
        let present = 0;
        let sum = 0;
        const values: number[] = [];
        for (const row of sourceRows) {
            const cell = row[column];
            if (isBlank(cell) || isMissingCellValue(cell)) continue;
            present += 1;
            const parsed = typeof cell === 'number' ? (Number.isFinite(cell) ? cell : null) : parse(column, cell);
            if (parsed === null) continue;
            sum += parsed;
            values.push(parsed);
        }
        if (values.length > 0 && values.length / present >= MIN_NUMERIC_SHARE) {
            source.set(column, { sum, median: medianOf(values) });
        }
    }
    const measureColumns = [...source.keys()];
    if (measureColumns.length === 0) {
        return { datasetVersion, status: 'passed', checkedColumns: [], findings: [], note: null, durationMs: Math.round(performance.now() - startedAt) };
    }

    const loaded = await input.readLoadedAggregates(measureColumns);
    if (!loaded) {
        return buildSkipped(datasetVersion, 'The query engine was not available for the numeric parse check.', startedAt);
    }

    const findings: NumericParseFinding[] = [];
    for (const column of measureColumns) {
        const original = source.get(column)!;
        const actual = loaded.get(column);
        if (!actual) continue;
        const ratio = actual.sum !== null && original.sum !== 0 ? actual.sum / original.sum : null;
        const base = {
            column,
            sourceSum: original.sum,
            loadedSum: actual.sum,
            ratio,
            sourceMedian: original.median,
            loadedMedian: actual.median,
        };
        // A median that moved while the total did not is a different parse error
        // (a few cells read differently), so it is reported separately.
        if (!isClose(original.sum, actual.sum)) findings.push({ ...base, kind: 'sum' });
        else if (!isClose(original.median, actual.median)) findings.push({ ...base, kind: 'median' });
    }

    return {
        datasetVersion,
        status: findings.length > 0 ? 'mismatch' : 'passed',
        checkedColumns: measureColumns,
        findings,
        note: null,
        durationMs: Math.round(performance.now() - startedAt),
    };
};

/** Reads SUM and MEDIAN of the loaded columns through the same compiler and engine the cards use. */
export const createQueryEngineAggregateReader = (
    dataset: CsvData,
    columnRegistry?: ColumnRegistry | null,
): LoadedAggregateReader => async columns => {
    const allowedColumns = Object.keys(dataset.data[0] ?? {});
    const result = new Map<string, ColumnAggregates>();
    for (let start = 0; start < columns.length; start += AGGREGATE_CHUNK_COLUMNS) {
        const chunk = columns.slice(start, start + AGGREGATE_CHUNK_COLUMNS);
        const plan: QueryPlan = {
            aggregates: chunk.flatMap((column, index) => [
                { function: 'sum' as const, column, as: `numeric_check_sum_${start + index}` },
                { function: 'median' as const, column, as: `numeric_check_median_${start + index}` },
            ]),
            limit: 1,
        };
        const execution = await executeManagedDataQuery(dataset, plan, allowedColumns, {
            allowNativeFallback: false,
            columnRegistry: columnRegistry ?? null,
        });
        if (execution.engine !== 'duckdb') return null;
        const row = execution.result.rows[0] ?? {};
        const toNumber = (value: unknown) => (value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null);
        chunk.forEach((column, index) => {
            result.set(column, {
                sum: toNumber(row[`numeric_check_sum_${start + index}`]),
                median: toNumber(row[`numeric_check_median_${start + index}`]),
            });
        });
    }
    return result;
};

type GuardStore = {
    getState: () => { rawCsvData?: CsvData | null; columnRegistry?: ColumnRegistry | null; numericParseCheck?: NumericParseCheck | null };
    setState: (partial: { numericParseCheck: NumericParseCheck }) => void;
};

/**
 * Runs the reconciliation for the dataset that was just bound to the query
 * engine and stores the outcome. Never throws: the check is a safeguard and must
 * not break loading. Large-file (preview) datasets are skipped.
 */
export const runNumericParseCheck = async (store: GuardStore, dataset: CsvData): Promise<NumericParseCheck | null> => {
    try {
        const datasetVersion = buildSemanticDatasetVersion(dataset);
        const existing = store.getState().numericParseCheck;
        if (existing && existing.datasetVersion === datasetVersion && existing.status !== 'skipped') return existing;
        const startedAt = performance.now();
        const rawCsvData = store.getState().rawCsvData;
        const check = dataset.backing?.mode === 'duckdb_file'
            ? buildSkipped(datasetVersion, 'Large files are loaded through a preview path and are not compared with the original text.', startedAt)
            : !rawCsvData
                ? buildSkipped(datasetVersion, 'The original imported rows are not available.', startedAt)
                : await reconcileNumericColumns({
                    datasetVersion,
                    sourceRows: rawCsvData.data,
                    loadedRows: dataset.data,
                    readLoadedAggregates: createQueryEngineAggregateReader(dataset, store.getState().columnRegistry),
                });
        store.setState({ numericParseCheck: check });
        if (check.status === 'mismatch') {
            console.warn('[NumericParseGuard] numeric columns do not reconcile with the original text:', check.findings);
        }
        return check;
    } catch (error) {
        console.warn('[NumericParseGuard] check failed, continuing without it.', error);
        return null;
    }
};

export { findNumericParseMismatches } from './numericParseFindings';
