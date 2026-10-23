import { describe, expect, it } from 'vitest';
import { formatAnalysisCellValue, formatAnalysisMeasureValue, getNumericColumns } from '../utils/analysisCardPresentation';

describe('analysis card temporal presentation', () => {
    it('formats epoch milliseconds into DD/MM/YYYY for time-like columns', () => {
        expect(formatAnalysisCellValue('CUSTOMER ORDER DATE', 1293753600000)).toBe('31/12/2010');
    });

    it('formats epoch seconds into DD/MM/YYYY for time-like columns', () => {
        expect(formatAnalysisCellValue('Order Date', 1293753600)).toBe('31/12/2010');
    });

    it('shows a bare year in a time column without a thousands separator', () => {
        expect(formatAnalysisCellValue('Year', 2013)).toBe('2013');
        expect(formatAnalysisCellValue('year', '2024')).toBe('2024');
        expect(formatAnalysisCellValue('Year', 2013.5)).toBe('2,013.5');
        expect(formatAnalysisCellValue('Units Sold', 2013)).toBe('2,013');
    });

    it('preserves non-temporal numeric facts as numbers', () => {
        expect(formatAnalysisCellValue('TOTAL SALES', 1293753600000)).toBe('1,293,753,600,000');
    });

    it('formats aggregate measures with exactly two decimals', () => {
        expect(formatAnalysisMeasureValue(603789953)).toBe('603,789,953.00');
        expect(formatAnalysisMeasureValue(399236924.8)).toBe('399,236,924.80');
    });

    it('does not classify time-like columns as numeric table columns when they hold epoch values', () => {
        const rows = [{ 'CUSTOMER ORDER DATE': 1293753600000, 'TOTAL SALES': 6900 }];
        expect(getNumericColumns(rows, Object.keys(rows[0]))).toEqual(['TOTAL SALES']);
    });
});
