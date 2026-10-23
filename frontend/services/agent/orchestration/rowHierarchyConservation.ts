import type { CsvRow } from '../../../types';

/**
 * Detail-row conservation for hierarchy tables.
 *
 * A table that carries an explicit `RowClass` column (written by the
 * deterministic hierarchy canonicalization) states exactly which rows are
 * detail ("fact") rows. Every aggregate in the app is required to read only
 * those rows, so a cleaning step that silently removes one of them changes
 * business totals without any visible error. The programs that remove rows by
 * index or by predicate are produced by an AI model that never sees the row
 * indexes of the full table, so their output must be checked against the
 * structural contract instead of being trusted.
 */

const ROW_CLASS_COLUMN = 'RowClass';
const SOURCE_ROW_COLUMN = 'SourceRowIndex';
const MAX_REPORTED_LOSSES = 20;

export interface FactRowLoss {
    factRowsBefore: number;
    factRowsAfter: number;
    lostFactRows: number;
    /** Source coordinates of lost rows when the table carries SourceRowIndex. */
    lostSourceRowIndexes: number[];
}

const isFactRow = (row: CsvRow): boolean => {
    const value = row[ROW_CLASS_COLUMN];
    return typeof value === 'string' && value.trim().toLowerCase() === 'fact';
};

const sourceRowOf = (row: CsvRow): number | null => {
    const value = row[SOURCE_ROW_COLUMN];
    const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isFinite(numeric) ? numeric : null;
};

/**
 * Returns null when no detail row was lost (or the input has no explicit
 * detail-row contract), otherwise a description of the loss.
 */
export const findFactRowLoss = (before: readonly CsvRow[], after: readonly CsvRow[]): FactRowLoss | null => {
    const beforeFacts = before.filter(isFactRow);
    if (beforeFacts.length === 0) {
        return null;
    }
    const afterFacts = after.filter(isFactRow);
    if (afterFacts.length >= beforeFacts.length) {
        return null;
    }

    const afterSources = new Set(afterFacts.map(sourceRowOf).filter((value): value is number => value !== null));
    const lostSourceRowIndexes = afterSources.size === afterFacts.length
        ? beforeFacts
            .map(sourceRowOf)
            .filter((value): value is number => value !== null && !afterSources.has(value))
            .slice(0, MAX_REPORTED_LOSSES)
        : [];

    return {
        factRowsBefore: beforeFacts.length,
        factRowsAfter: afterFacts.length,
        lostFactRows: beforeFacts.length - afterFacts.length,
        lostSourceRowIndexes,
    };
};

export class FactRowLossError extends Error {
    readonly loss: FactRowLoss;

    constructor(loss: FactRowLoss, stage: string) {
        super(
            `fact_rows_lost: ${stage} removed ${loss.lostFactRows} of ${loss.factRowsBefore} detail rows`
            + (loss.lostSourceRowIndexes.length > 0 ? ` (source rows ${loss.lostSourceRowIndexes.join(', ')})` : '')
            + '. Detail rows of a hierarchy table must survive cleaning.',
        );
        this.name = 'FactRowLossError';
        this.loss = loss;
    }
}

export const assertFactRowsPreserved = (
    before: readonly CsvRow[] | null | undefined,
    after: readonly CsvRow[],
    stage: string,
): void => {
    if (!before) {
        return;
    }
    const loss = findFactRowLoss(before, after);
    if (loss) {
        throw new FactRowLossError(loss, stage);
    }
};
