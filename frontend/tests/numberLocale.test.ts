import { describe, expect, it } from 'vitest';
import { profileData, profileDataLightweight, robustParseFloat, summarizeDataQualityForEndUser } from '../services/data/dataProfiler';
import {
    classifyNumberCell,
    detectColumnNumberStyle,
    isIdentifierHeader,
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
        expect(detectColumnNumberStyle(['0,5', '1.234.567', '', null, 'n/a'])).toBe('decimal_comma');
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
        expect(summarizeDataQualityForEndUser(issues)?.userSummary).toContain('decimal comma');

        // Menge has only ambiguous or plain cells. Betrag proves the decimal
        // comma for the dataset and nothing proves the decimal point, so Menge
        // inherits it: 4.567 is 4567, not 4.567.
        const menge = profiles.find(profile => profile.name === 'Menge')!;
        expect(menge.numberFormat).toBe('decimal_comma');
        expect(menge.valueRange).toEqual([12, 4567]);
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

describe('Indian lakh/crore grouping', () => {
    it.each([
        ['12,34,567.89', 1234567.89],
        ['1,23,456.00', 123456],
        ['10,34,567.50', 1034567.5],
        ['12,34,567', 1234567],
        ['1,23,456', 123456],
        ['-12,34,567.89', -1234567.89],
        ['(1,23,456.00)', -123456],
    ])('reads %s as %d', (text, expected) => {
        expect(robustParseFloat(text)).toBeCloseTo(expected, 6);
    });

    it('keeps types and column style consistent', () => {
        const { profiles } = profileData([{ Amt: '1,23,456.00' }, { Amt: '10,34,567.50' }]);
        expect(profiles[0].type).toBe('numerical');
        expect(profiles[0].valueRange).toEqual([123456, 1034567.5]);
        expect(detectColumnNumberStyle(['1,23,456.00', '12,34,567'])).toBe('decimal_point');
        // Mis-grouped digits are still not numbers.
        expect(robustParseFloat('1,23,45')).toBeNull();
        expect(robustParseFloat('123,4,567')).toBeNull();
    });
});

describe('Swiss apostrophe numbers', () => {
    it('are numbers per cell and per column', () => {
        expect(robustParseFloat("1'234.50")).toBe(1234.5);
        expect(robustParseFloat('2’234.50')).toBe(2234.5);
        expect(robustParseFloat("1'000'000")).toBe(1000000);
        expect(robustParseFloat("5'6")).toBeNull();
        expect(robustParseFloat("O'Brien")).toBeNull();
        const { profiles } = profileData([{ Amt: "1'234.50" }, { Amt: "2'234.50" }]);
        expect(profiles[0].type).toBe('numerical');
    });
});

describe('identifier-like columns are not measures', () => {
    it.each(['Code', 'Product Code', 'ProductCode', 'ID', 'Customer_ID', 'Order No', 'Order No.', 'Nr', 'SKU', 'Ref', 'Reference',
        'Zip', 'Postal Code', 'Phone', 'Tel', 'Kundennummer', 'Artikelnummer', 'OrderNumber', 'Invoice #'])(
        'treats the header "%s" as an identifier', header => {
            expect(isIdentifierHeader(header)).toBe(true);
        });

    it.each(['Betrag', 'Preis', 'Menge', 'Amount', 'Total Amount', 'Invoice Amount', 'Account Balance', 'Rate', 'Number of items', 'Umsatz', 'Notional'])(
        'treats the header "%s" as a measure candidate', header => {
            expect(isIdentifierHeader(header)).toBe(false);
        });

    it('does not retype or rewrite a code column of dotted groups', () => {
        const rows = [
            { Code: '1.234.567', Preis: '161,30' },
            { Code: '2.345.678', Preis: '12,50' },
        ];
        expect(robustParseFloat('1.234.567')).toBeNull();
        const { profiles } = profileData(rows);
        expect(profiles.find(profile => profile.name === 'Code')?.type).toBe('categorical');
        expect(profiles.find(profile => profile.name === 'Code')?.numberFormat).toBeUndefined();
        expect(profiles.find(profile => profile.name === 'Preis')?.numberFormat).toBe('decimal_comma');
        const normalized = normalizeDecimalCommaColumns(rows, ['Code', 'Preis']);
        expect(normalized.columns).toEqual(['Preis']);
        expect(normalized.rows.map(row => row.Code)).toEqual(['1.234.567', '2.345.678']);
    });

    it('does not let dotted groups alone prove the decimal comma, even under a neutral header', () => {
        expect(detectColumnNumberStyle(['1.234.567', '2.345.678'])).toBeNull();
        expect(detectColumnNumberStyle(['1.234.567', '2.345.678', '0,500'])).toBeNull();
        expect(normalizeDecimalCommaColumns([{ Teile: '1.234.567' }, { Teile: '2.345.678' }], ['Teile']).columns).toEqual([]);
        // With a clearly decimal-comma cell the dotted groups become numbers.
        expect(detectColumnNumberStyle(['1.234.567', '12,50'])).toBe('decimal_comma');
        expect(robustParseFloat('1.234.567', 'decimal_comma')).toBe(1234567);
    });

    it('does not rewrite identifier-named columns such as 12,34 or 12,5%, but rewrites measures', () => {
        const rows = [
            { Ref: '12,34', Code: '12,5%', Rate: '12,5%', Betrag: '161,30' },
            { Ref: '56,78', Code: '7,25%', Rate: '7,25%', Betrag: '12,50' },
        ];
        const normalized = normalizeDecimalCommaColumns(rows, ['Ref', 'Code', 'Rate', 'Betrag']);
        expect(normalized.columns).toEqual(['Rate', 'Betrag']);
        expect(normalized.rows.map(row => row.Ref)).toEqual(['12,34', '56,78']);
        expect(normalized.rows.map(row => row.Code)).toEqual(['12,5%', '7,25%']);
        expect(normalized.rows.map(row => row.Rate)).toEqual(['12.5%', '7.25%']);
        expect(normalized.rows.map(row => row.Betrag)).toEqual(['161.30', '12.50']);
        const { profiles } = profileData(rows);
        expect(profiles.find(profile => profile.name === 'Ref')?.numberFormat).toBeUndefined();
        expect(profiles.find(profile => profile.name === 'Code')?.numberFormat).toBeUndefined();
        expect(profiles.find(profile => profile.name === 'Rate')?.numberFormat).toBe('decimal_comma');
    });
});

describe('file-level prior for ambiguous-only columns', () => {
    const european = [
        { Preis: '12,50', Menge: '1.000', Notiz: 'a' },
        { Preis: '7,25', Menge: '2.500', Notiz: 'b' },
        { Preis: '3,10', Menge: '3.200', Notiz: 'c' },
    ];

    it('reads Menge as thousands when Preis proves decimal commas', () => {
        const normalized = normalizeDecimalCommaColumns(european, ['Preis', 'Menge', 'Notiz']);
        expect(normalized.columns).toEqual(['Preis', 'Menge']);
        expect(normalized.rows.map(row => row.Menge)).toEqual(['1000', '2500', '3200']);
        const { profiles } = profileData(european);
        expect(profiles.find(profile => profile.name === 'Menge')?.valueRange).toEqual([1000, 3200]);
        expect(profileDataLightweight(european).profiles.find(profile => profile.name === 'Menge')?.numberFormat).toBe('decimal_comma');
    });

    it('does not apply without positive evidence in the file', () => {
        const onlyAmbiguous = [{ Menge: '1.000' }, { Menge: '2.500' }];
        expect(normalizeDecimalCommaColumns(onlyAmbiguous, ['Menge']).columns).toEqual([]);
        expect(profileData(onlyAmbiguous).profiles[0].valueRange).toEqual([1, 2.5]);
        // Only a dotted-groups column proves nothing either.
        expect(normalizeDecimalCommaColumns([{ A: '1.000', Teile: '1.234.567' }], ['A', 'Teile']).columns).toEqual([]);
    });

    it('does not apply when another column proves the decimal point', () => {
        const mixedFile = european.map((row, index) => ({ ...row, Us: ['1,234.56', '2,000.00', '3.25'][index] }));
        expect(normalizeDecimalCommaColumns(mixedFile, ['Preis', 'Menge', 'Us']).columns).toEqual(['Preis']);
    });

    it('skips identifier-named and non-ambiguous columns', () => {
        const rows = european.map((row, index) => ({ ...row, 'Artikel Nr': ['1.000', '2.000', '3.000'][index], Anzahl: ['5', '6', '7'][index] }));
        const normalized = normalizeDecimalCommaColumns(rows, ['Preis', 'Menge', 'Artikel Nr', 'Anzahl']);
        expect(normalized.columns).toEqual(['Preis', 'Menge']);
    });
});

describe('junk cells in style inference', () => {
    const column = (junk: string[]) => [...Array.from({ length: 19 }, (_, index) => `${index + 1},50`), ...junk];

    it('tolerates a small share of non-numeric cells', () => {
        expect(detectColumnNumberStyle(column(['TBD']))).toBe('decimal_comma');
        const rows = column(['TBD']).map(Preis => ({ Preis, Menge: '1.000' }));
        const normalized = normalizeDecimalCommaColumns(rows, ['Preis', 'Menge']);
        expect(normalized.columns).toEqual(['Preis', 'Menge']);
        // The junk cell itself is never rewritten.
        expect(normalized.rows[19].Preis).toBe('TBD');
        expect(normalized.rows[0].Preis).toBe('1.50');
    });

    it('refuses a column that is mostly text', () => {
        expect(detectColumnNumberStyle(column(['TBD', 'n.v.', 'siehe Anhang']))).toBeNull();
        expect(detectColumnNumberStyle(['12,50', 'TBD'])).toBeNull();
    });
});
