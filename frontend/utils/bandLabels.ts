/**
 * Display meaning of the band columns a melt creates (`SeriesLabelL1`, ...).
 * The column keeps its name for data and queries; people read what its values
 * are: `FY2025` / `FY2026` -> "Fiscal year", `Q1`..`Q4` -> "Quarter", else "Group".
 */
import type { CsvRow } from '../types';

const BAND_COLUMN_PATTERN = /^serieslabell(\d+)$/i;
const MIN_MATCH_SHARE = 0.9;
const MAX_VALUES_SCANNED = 5000;

const MONTH_PATTERN = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:[\s-]*'?\d{2,4})?$/i;

const BAND_KINDS: Array<{ label: string; pattern: RegExp }> = [
    { label: 'Fiscal year', pattern: /^(?:fy|f\.y\.?|fiscal\s*year)\s*[-']?\s*\d{2,4}(?:\s*[/-]\s*\d{2,4})?$/i },
    { label: 'Quarter', pattern: /^(?:q[1-4]|[1-4]q|quarter\s*[1-4])(?:\s*[-']?\s*(?:fy)?\d{2,4})?$/i },
    { label: 'Half year', pattern: /^(?:h[12]|[12]h)(?:\s*[-']?\s*(?:fy)?\d{2,4})?$/i },
    { label: 'Year', pattern: /^(?:19|20)\d{2}$/ },
    { label: 'Month', pattern: MONTH_PATTERN },
    { label: 'Week', pattern: /^(?:w|wk|week)\s*\d{1,2}$/i },
];

/** The layer number of a melt band column (`SeriesLabelL2` -> 2), or null for any other column. */
export const getBandColumnLayer = (column: string | undefined | null): number | null => {
    const match = column ? column.replace(/[^A-Za-z0-9]/g, '').match(BAND_COLUMN_PATTERN) : null;
    return match ? Number(match[1]) : null;
};

export const isBandColumnName = (column: string | undefined | null): boolean => getBandColumnLayer(column) !== null;

/** What a band's values are, or null when they follow no known pattern. */
export const inferBandLabel = (values: Iterable<unknown>): string | null => {
    const distinct = new Set<string>();
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (text) distinct.add(text);
        if (distinct.size >= MAX_VALUES_SCANNED) break;
    }
    if (distinct.size === 0) return null;
    const entries = [...distinct];
    const kind = BAND_KINDS.find(candidate =>
        entries.filter(entry => candidate.pattern.test(entry)).length / entries.length >= MIN_MATCH_SHARE);
    return kind?.label ?? null;
};

/** Neutral label when the values say nothing: "Group", then "Group 2" for a second band layer. */
export const fallbackBandLabel = (layer: number): string => (layer <= 1 ? 'Group' : `Group ${layer}`);

let registeredBandLabels: Record<string, string> = {};

/** Replaces the labels of the dataset being analysed (a new dataset has its own bands). */
export const setBandColumnLabels = (labels: Record<string, string>): void => {
    registeredBandLabels = { ...labels };
};

export const deriveBandColumnLabels = (rows: readonly CsvRow[] | null | undefined): Record<string, string> => {
    const first = rows?.[0];
    if (!rows || !first) return {};
    const labels: Record<string, string> = {};
    Object.keys(first).filter(isBandColumnName).forEach(column => {
        labels[column] = inferBandLabel(rows.slice(0, MAX_VALUES_SCANNED).map(row => row[column]))
            ?? fallbackBandLabel(getBandColumnLayer(column) ?? 1);
    });
    return labels;
};

export const syncBandColumnLabels = (rows: readonly CsvRow[] | null | undefined): void => {
    setBandColumnLabels(deriveBandColumnLabels(rows));
};

/** Display label of a melt band column; always a meaningful word, never "Series Label 1". */
export const resolveBandColumnLabel = (column: string): string | null => {
    const layer = getBandColumnLayer(column);
    if (layer === null) return null;
    const key = Object.keys(registeredBandLabels).find(name => name.toLowerCase() === column.toLowerCase());
    return (key ? registeredBandLabels[key] : null) ?? fallbackBandLabel(layer);
};

/** Replaces `SeriesLabelL1`-style names inside a sentence with their display label. */
export const replaceBandColumnNames = (text: string): string =>
    text.replace(/\bSeries\s?Label\s?(?:L\s?)?(\d+)\b/gi, (_match, layer: string) =>
        resolveBandColumnLabel(`SeriesLabelL${layer}`) ?? fallbackBandLabel(Number(layer)));

/** True when the label shown for a band column is only the neutral "Group": its values gave it no meaning. */
export const isBandColumnWithoutMeaning = (column: string | undefined | null, displayLabel: string): boolean => {
    const layer = column ? getBandColumnLayer(column) : null;
    return layer !== null && displayLabel.trim().toLowerCase() === fallbackBandLabel(layer).toLowerCase();
};
