import { CsvRow } from '../types';

/**
 * Parse a value as a number, stripping thousand-separator commas and trimming whitespace.
 * Handles formatted numbers like "84,267.50", " 1,276,638.48 ", etc.
 * Returns 0 for non-numeric values (null, undefined, empty string, text).
 * Use parseNullableNumericValue where a missing measure must stay distinct from 0.
 */
export const parseNumericValue = (value: unknown): number => {
    if (typeof value === 'number') return value;
    return parseNullableNumericValue(value) ?? 0;
};

/**
 * Same parsing as parseNumericValue, but returns null when the cell holds no
 * number. A NULL aggregate (e.g. the median of a group whose every value is a
 * missing marker) means "no data" and must never be shown, ranked or summed as 0.
 */
export const parseNullableNumericValue = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/,/g, '').trim();
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Keeps the first `topN` groups and folds the rest into one "Others" row.
 *
 * `overallTotal` is the measured total over every group the query matched,
 * passed only when the rows are a cut-off ranking (the query limit dropped
 * groups). "Others" is then the total minus the groups shown, so it also holds
 * the groups the query never returned, not only the returned rows past `topN`.
 */
export const applyTopNWithOthers = (
    data: CsvRow[],
    groupByKey: string,
    valueKey: string,
    topN: number,
    direction: 'asc' | 'desc' = 'desc',
    overallTotal: number | null = null,
): CsvRow[] => {
    if (data.length <= topN && overallTotal === null) {
        return data;
    }

    // An ascending ranking keeps its lowest groups and folds the rest into "Others".
    // Groups without a value sort last in either direction.
    const sign = direction === 'asc' ? -1 : 1;
    const sortedData = data
        .map((row, index) => ({ row, index, value: parseNullableNumericValue(row[valueKey]) }))
        .sort((a, b) => {
            if (a.value === null || b.value === null) {
                return (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) || a.index - b.index;
            }
            return (b.value - a.value) * sign || a.index - b.index;
        });

    const topEntries = sortedData.slice(0, topN);
    const topData = topEntries.map(entry => entry.row);

    if (overallTotal !== null) {
        const shownTotal = topEntries.reduce((acc, entry) => acc + (entry.value ?? 0), 0);
        const remainder = overallTotal - shownTotal;
        // Summing the same numbers in another order leaves float noise; that is not a group.
        if (Math.abs(remainder) <= 1e-9 * Math.max(1, Math.abs(overallTotal))) {
            return topData;
        }
        return [...topData, { [groupByKey]: 'Others', [valueKey]: remainder }];
    }

    // A group without a value adds nothing to "Others"; a bucket of only such
    // groups would otherwise appear as a real total of 0.
    const otherValues = sortedData.slice(topN).flatMap(entry => (entry.value === null ? [] : [entry.value]));

    if (otherValues.length > 0) {
        const othersRow: CsvRow = {
            [groupByKey]: 'Others',
            [valueKey]: otherValues.reduce((acc, value) => acc + value, 0),
        };
        return [...topData, othersRow];
    }

    return topData;
};


export const buildDiverseSample = (rows: CsvRow[], size: number): CsvRow[] => {
    if (rows.length <= size) return rows.map(row => ({ ...row }));
    const sample: CsvRow[] = [];
    const used = new Set<number>();

    const takeRange = (indices: number[]) => {
        indices.forEach(index => {
            if (sample.length >= size) return;
            if (index >= 0 && index < rows.length && !used.has(index)) {
                used.add(index);
                sample.push({ ...rows[index] });
            }
        });
    };

    // Take from the beginning and end to capture headers/footers
    takeRange(Array.from({ length: Math.min(8, size) }, (_, i) => i));
    takeRange(Array.from({ length: Math.min(6, size) }, (_, i) => rows.length - 1 - i));

    // Fill the rest with random samples
    while (sample.length < size) {
        const index = Math.floor(Math.random() * rows.length);
        if (!used.has(index)) {
            used.add(index);
            sample.push({ ...rows[index] });
        }
    }

    return sample;
};
