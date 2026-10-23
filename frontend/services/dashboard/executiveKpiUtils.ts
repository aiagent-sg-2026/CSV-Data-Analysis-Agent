import { compactIfLarge } from '../../utils/compactNumber';
import type { ColumnProfile, CsvRow } from '../../types';
import { robustParseFloat } from '../data/dataProfiler';
import {
    NEUTRAL_GROUPS_WORD,
    hasHeaderLayers,
    naturalizeLayeredText,
    pluralizeLabelOrNull,
} from '../../utils/displayText';
import { replaceBandColumnNames } from '../../utils/bandLabels';

const PERCENTAGE_LIKE_PATTERN = /pct|percent|percentage|rate|ratio|share|margin/i;
const TOTAL_PREFIX_PATTERN = /^total\b/i;
const TRAILING_PUNCTUATION_PATTERN = /[\s._:;,-]+$/;
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
const FIXED_HELPER_LABEL_PATTERN = /^(source row|source column|row class|series key|series label \d+|hierarchy depth)$/i;
const STANDARD_BUSINESS_LABELS: Record<string, string> = {
    CCY: 'Currency',
};

const countOf = (value: string, char: string): number => value.split(char).length - 1;

// A closing bracket that matches an opener belongs to the text ("... (median of Value by Category)").
const hasUnmatchedTrailingCloser = (value: string): boolean =>
    (value.endsWith(')') && countOf(value, ')') > countOf(value, '('))
    || (value.endsWith(']') && countOf(value, ']') > countOf(value, '['));

const trimTrailingPunctuation = (value: string): string => {
    let nextValue = value.trim();
    for (;;) {
        if (TRAILING_PUNCTUATION_PATTERN.test(nextValue)) {
            nextValue = nextValue.replace(TRAILING_PUNCTUATION_PATTERN, '').trim();
        } else if (hasUnmatchedTrailingCloser(nextValue)) {
            nextValue = nextValue.slice(0, -1).trim();
        } else {
            return nextValue;
        }
    }
};

export const normalizeDisplayLabel = (value: string | undefined, fallback: string): string => {
    if (!value) return fallback;
    // Header layers ("Order :: Date") are a data detail; people read "Order date".
    const layered = hasHeaderLayers(value) ? naturalizeLayeredText(value) : value;
    // A melt's band column (SeriesLabelL1) reads as what its values are, never as "Series Label 1".
    const trimmed = trimTrailingPunctuation(replaceBandColumnNames(layered));
    if (!trimmed) return fallback;
    if (STANDARD_BUSINESS_LABELS[trimmed]) return STANDARD_BUSINESS_LABELS[trimmed];
    return trimmed
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

export const isNeutralHelperDisplayLabel = (value: string): boolean =>
    FIXED_HELPER_LABEL_PATTERN.test(trimTrailingPunctuation(value));

export const toDisplayLabel = (value: string | undefined, fallback: string): string => {
    return normalizeDisplayLabel(value, fallback)
        .replace(/\b\w/g, char => char.toUpperCase());
};

/**
 * Plural of a group label for a sentence ("Distinct Customers"). Only words the
 * helper knows are pluralised; anything else reads as the neutral "Groups".
 */
export const pluralizeLabel = (value: string): string => {
    const cleanedValue = trimTrailingPunctuation(value || '');
    if (!cleanedValue || /[\u3400-\u9FBF]/.test(cleanedValue) || isNeutralHelperDisplayLabel(cleanedValue)) {
        return cleanedValue || 'Groups';
    }

    const words = cleanedValue.split(' ');
    if (words.length > 4) {
        return cleanedValue;
    }
    const lastWord = words[words.length - 1];
    if (!lastWord || NON_ASCII_PATTERN.test(lastWord) || !/^[A-Za-z]+$/.test(lastWord)) {
        return cleanedValue;
    }
    // A name taken from the user's own column ("Kunde") is not a word we know: never guess "Kundes".
    return pluralizeLabelOrNull(cleanedValue)
        ?? (lastWord === lastWord.toLowerCase() ? NEUTRAL_GROUPS_WORD : 'Groups');
};

/** Plural for a title ("Top Customers by ..."); the label itself when it cannot be pluralised safely. */
export const pluralizeLabelOrSelf = (value: string): string => pluralizeLabelOrNull(value) ?? value;

export const getColumnProfile = (columnProfiles: ColumnProfile[], columnName: string | undefined): ColumnProfile | undefined => {
    if (!columnName) return undefined;
    return columnProfiles.find(profile => profile.name.toLowerCase() === columnName.toLowerCase());
};

export const getRowValue = (row: CsvRow, columnName: string | undefined): CsvRow[string] => {
    if (!columnName) return undefined;
    if (columnName in row) {
        return row[columnName];
    }

    const lowered = columnName.toLowerCase();
    const matchingKey = Object.keys(row).find(key => key.toLowerCase() === lowered);
    return matchingKey ? row[matchingKey] : undefined;
};

export const toNumericValue = (value: CsvRow[string]): number | null => robustParseFloat(value);

const KPI_COMPACT_MIN_ABS = 1_000_000;

export const formatMetricValue = (value: number, columnName: string | undefined, columnProfiles: ColumnProfile[]): string => {
    const profile = getColumnProfile(columnProfiles, columnName);
    const normalizedName = (columnName ?? '').toLowerCase();
    const maximumFractionDigits = Math.abs(value) >= 100 ? 0 : 2;

    if (profile?.type === 'percentage' || PERCENTAGE_LIKE_PATTERN.test(normalizedName)) {
        const percentValue = Math.abs(value) <= 1 ? value * 100 : value;
        return `${percentValue.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    }

    // Headline tiles abbreviate millions and above; the cards below keep exact values.
    return compactIfLarge(value, KPI_COMPACT_MIN_ABS) ?? value.toLocaleString(undefined, { maximumFractionDigits });
};

export const formatShareValue = (ratio: number): string =>
    `${(ratio * 100).toLocaleString(undefined, { maximumFractionDigits: ratio >= 0.1 ? 0 : 1 })}%`;

export const buildMetricLabel = (columnName: string | undefined): string => {
    if (!columnName || columnName === 'count') {
        return 'Records';
    }
    return toDisplayLabel(columnName, 'Metric');
};

// "Sum Resale Price" reads as "Total Sum Resale Price" otherwise.
const SUM_PREFIX_PATTERN = /^sum\s+(?:of\s+)?/i;

export const buildTotalMetricLabel = (metricLabel: string): string => {
    if (TOTAL_PREFIX_PATTERN.test(metricLabel)) return metricLabel;
    return `Total ${metricLabel.replace(SUM_PREFIX_PATTERN, '')}`;
};
