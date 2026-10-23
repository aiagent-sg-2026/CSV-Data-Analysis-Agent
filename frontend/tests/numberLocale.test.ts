import { describe, expect, it } from 'vitest';
import { profileData, profileDataLightweight, robustParseFloat, summarizeDataQualityForEndUser } from '../services/data/dataProfiler';
import {
    classifyNumberCell,
    detectColumnNumberStyle,
    normalizeDecimalCommaColumns,
} from '../services/data/numberLocale';
import { compileQueryPlanToDuckDbSql } from '../services/duckdb/queryCompiler';

describe('robustParseFloat per cell', () => {
    it.each([
        ['1.234,56', 1234.56],
        ['-1.234,56', -1234.56],
        ['(1.234,56)', -1234.56],
        ['€ 1.234,56', 1234.56],
        ['161,30', 161.3],
        ['0,5', 0.5],
        ['0,500', 0.5],
        ['1234,567', 1234.567],
        ['12,3456', 12.3456],
        ['12,5 %', 12.5],
        ['1.234.567', 1234567],
        ['1.234.567,89', 1234567.89],
        ['1 234,56', 1234.56],
        ['1 234,56', 1234.56],
        ["1'234.50", 1234.5],
    ])('reads European or grouped %s as %d', (text, expected) => {
        expect(robustParseFloat(text)).toBeCloseTo(expected, 6);
    });

    it.each([
        ['1,234.56', 1234.56],
        ['1,234,567', 1234567],
        ['1,234,567.89', 1234567.89],
        ['-4,010.85', -4010.85],
        ['$1,234.56', 1234.56],
        ['18.50', 18.5],
        ['0.500', 0.5],
        ['1234.567', 1234.567],
        ['1,234', 1234],
        ['4.567', 4.567],
    ])('keeps US reading for %s', (text, expected) => {
        expect(robustParseFloat(text)).toBeCloseTo(expected, 6);
    });

    it('rejects text that only looks numeric', () => {
        expect(robustParseFloat('04.03.2026')).toBeNull();
        expect(robustParseFloat('2026-03-04')).toBeNull();
        expect(robustParseFloat('1,2,3')).toBeNull();
        expect(robustParseFloat('1.234,56,7')).toBeNull();
        expect(robustParseFloat('A00003')).toBeNull();
    });

    it('lets the column style resolve ambiguous cells only', () => {
        expect(robustParseFloat('1,234', 'decimal_comma')).toBeCloseTo(1.234, 6);
        expect(robustParseFloat('4.567', 'decimal_comma')).toBe(4567);
        expect(robustParseFloat('1,234', 'decimal_point')).toBe(1234);
        // Unambiguous cells ignore the column style.
        expect(robustParseFloat('1,234.56', 'decimal_comma')).toBeCloseTo(1234.56, 6);
        expect(robustParseFloat('161,30', 'decimal_point')).toBeCloseTo(161.3, 6);
        // A stray .map index must not be mistaken for a style.
        expect(['1,234', '4.567'].map(robustParseFloat as unknown as (value: string, index: number) => number | null)).toEqual([1234, 4.567]);
    });
});

describe('column number style', () => {
    it('proves the decimal comma from one unambiguous cell', () => {
        expect(detectColumnNumberStyle(['4.567', '1.234,56', '12'])).toBe('decimal_comma');
        expect(detectColumnNumberStyle(['1,234', '161,30'])).toBe('decimal_comma');
        expect(detectColumnNumberStyle(['1.234.567', '', null, 'n/a'])).toBe('decimal_comma');
    });

    it('proves the decimal point from US cells and gives no evidence for ambiguous-only columns', () => {
        expect(detectColumnNumberStyle(['1,234.56', '4,567'])).toBe('decimal_point');
        expect(detectColumnNumberStyle(['1,234', '4.567', '12'])).toBeNull();
        expect(detectColumnNumberStyle(['10', '20'])).toBeNull();
    });

    it('refuses mixed styles and text columns', () => {
        expect(detectColumnNumberStyle(['1.234,56', '1,234.56'])).toBeNull();
        expect(detectColumnNumberStyle(['1.234,56', 'TOTAL'])).toBeNull();
        expect(classifyNumberCell('04.03.2026')).toBeNull();
    });
});

describe('decimal-comma columns in the profiler', () => {
    const rows = [
        { Betrag: '1.234,56', Menge: '4.567', Name: 'a' },
        { Betrag: '2,50', Menge: '1.234', Name: 'b' },
        { Betrag: '10.000,00', Menge: '12', Name: 'c' },
    ];

    it('computes the range per column and never asks for comma stripping', () => {
        const { profiles, issues } = profileData(rows);
        const betrag = profiles.find(profile => profile.name === 'Betrag')!;
        expect(betrag.type).toBe('numerical');
        expect(betrag.numberFormat).toBe('decimal_comma');
        expect(betrag.hasFormattedNumbers).toBeUndefined();
        expect(betrag.valueRange).toEqual([2.5, 10000]);
        expect(issues.some(issue => issue.includes("Column 'Betrag' uses decimal commas"))).toBe(true);
        expect(issues.some(issue => issue.includes('Strip commas'))).toBe(false);
        expect(summarizeDataQualityForEndUser(issues)?.userSummary).toContain('decimal commas');

        // Menge has only ambiguous or plain cells, so there is no column
        // evidence and the US reading (4.567 is a decimal) stays.
        const menge = profiles.find(profile => profile.name === 'Menge')!;
        expect(menge.numberFormat).toBeUndefined();
        expect(menge.valueRange).toEqual([1.234, 12]);
    });

    it('lets a decimal-comma column with one dotted-thousands cell read it as thousands', () => {
        const { profiles } = profileData([{ Preis: '4.567' }, { Preis: '0,5' }]);
        expect(profiles[0].valueRange).toEqual([0.5, 4567]);
    });

    it('marks the lightweight profile the same way', () => {
        const { profiles } = profileDataLightweight(rows);
        expect(profiles.find(profile => profile.name === 'Betrag')?.numberFormat).toBe('decimal_comma');
        expect(profiles.find(profile => profile.name === 'Betrag')?.hasFormattedNumbers).toBeUndefined();
    });

    it('keeps US comma-formatted columns on the strip-commas path', () => {
        const { profiles } = profileData([{ Amount: '1,234.56' }, { Amount: '2,345.67' }]);
        expect(profiles[0].hasFormattedNumbers).toBe(true);
        expect(profiles[0].numberFormat).toBeUndefined();
    });
});

describe('normalizeDecimalCommaColumns', () => {
    it('rewrites only columns that prove the decimal comma', () => {
        const rows = [
            { Betrag: '1.234,56', Menge: '4.567', Us: '1,234.56', Ambiguous: '1,234', Text: 'a,b', Mixed: '1.234,56' },
            { Betrag: '(2,50)', Menge: '1.234,5', Us: '2,000.00', Ambiguous: '4.567', Text: 'c', Mixed: '1,234.56' },
            { Betrag: '€ 10.000,00', Menge: '', Us: '3.5', Ambiguous: '12', Text: 'd', Mixed: '7' },
        ];
        const result = normalizeDecimalCommaColumns(rows, Object.keys(rows[0]));
        expect(result.columns).toEqual(['Betrag', 'Menge']);
        expect(result.rows.map(row => row.Betrag)).toEqual(['1234.56', '(2.50)', '€ 10000.00']);
        expect(result.rows.map(row => row.Menge)).toEqual(['4567', '1234.5', '']);
        expect(result.rows.map(row => row.Us)).toEqual(['1,234.56', '2,000.00', '3.5']);
        expect(result.rows.map(row => row.Ambiguous)).toEqual(['1,234', '4.567', '12']);
        expect(result.rows.map(row => row.Mixed)).toEqual(['1.234,56', '1,234.56', '7']);
        // The source rows are never mutated.
        expect(rows[0].Betrag).toBe('1.234,56');
    });

    it('returns the same rows when nothing changes', () => {
        const rows = [{ a: '1', b: 'x' }];
        expect(normalizeDecimalCommaColumns(rows, ['a', 'b']).rows).toBe(rows);
    });
});

describe('DuckDB numeric expression', () => {
    it('matches only unambiguous European cells and keeps the existing strip chain', () => {
        const { sql } = compileQueryPlanToDuckDbSql(
            { aggregates: [{ function: 'sum', column: 'Betrag', as: 'total' }], limit: 10 },
            { allowedColumns: ['Betrag'], tableName: 'data' },
        );
        expect(sql).toContain('regexp_matches(');
        expect(sql).toContain('TRY_CAST(NULLIF(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(');
    });
});
