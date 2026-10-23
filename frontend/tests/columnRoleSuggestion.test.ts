import { describe, expect, it } from 'vitest';
import { suggestColumnRoles } from '../services/data/columnRoleSuggestion';
import type { ColumnProfile, ColumnSemanticAnnotation, CsvRow } from '../types';

const suggest = (profiles: ColumnProfile[], rows: CsvRow[], semanticAnnotations?: ColumnSemanticAnnotation[]) =>
    suggestColumnRoles({ profiles, rows, semanticAnnotations });

const rows = (count: number, build: (index: number) => CsvRow): CsvRow[] => Array.from({ length: count }, (_, index) => build(index));

describe('suggestColumnRoles', () => {
    it('reads measure, date, label and identifier from the type, the values and the name', () => {
        const data = rows(60, index => ({
            'Invoice No': `INV${String(index + 1).padStart(5, '0')}`,
            Date: `2026-0${(index % 6) + 1}-1${index % 9}`,
            Customer: ['ACME', 'DELTA', 'JADE'][index % 3],
            Amount: 100 + index,
        }));
        const result = suggest([
            { name: 'Invoice No', type: 'categorical' },
            { name: 'Date', type: 'categorical' },
            { name: 'Customer', type: 'categorical' },
            { name: 'Amount', type: 'numerical' },
        ], data);

        expect(result).toEqual({ 'Invoice No': 'identifier', Date: 'dimension', Customer: 'dimension', Amount: 'metric' });
    });

    it('treats a numeric key as an identifier and a numeric year as a period, never as an amount', () => {
        const data = rows(40, index => ({ 'Customer ID': 10_000 + index, Year: 2020 + (index % 5), Sales: 5 * index }));
        const result = suggest([
            { name: 'Customer ID', type: 'numerical' },
            { name: 'Year', type: 'numerical' },
            { name: 'Sales', type: 'numerical' },
        ], data);

        expect(result).toEqual({ 'Customer ID': 'identifier', Year: 'dimension', Sales: 'metric' });
    });

    it('maps typed date, currency and percentage columns without needing values', () => {
        const result = suggest([
            { name: 'Posted', type: 'date' },
            { name: 'Price', type: 'currency' },
            { name: 'Share', type: 'percentage' },
        ], []);

        expect(result).toEqual({ Posted: 'dimension', Price: 'metric', Share: 'metric' });
    });

    it('marks long free text as a helper column', () => {
        const data = rows(40, index => ({ Remarks: `Customer called on day ${index} to say that the delivery note did not match the order ${index * 31}` }));

        expect(suggest([{ name: 'Remarks', type: 'categorical' }], data)).toEqual({ Remarks: 'helper' });
    });

    it('leaves a column unspecified when nothing decides it', () => {
        const data = rows(80, index => ({ Mystery: `x${(index * 7919) % 100003}${String.fromCharCode(97 + (index % 26))}` }));
        const result = suggest([
            { name: 'Mystery', type: 'categorical' },
            { name: '_unnamed_column_3', type: 'categorical' },
            { name: 'Empty', type: 'categorical' },
        ], data);

        expect(result).toEqual({ Mystery: null, _unnamed_column_3: null, Empty: null });
    });

    it('trusts a confident semantic annotation over the guess from the values', () => {
        const data = rows(40, index => ({ Code: `C${index}`, Score: index }));
        const result = suggest(
            [{ name: 'Code', type: 'categorical' }, { name: 'Score', type: 'numerical' }],
            data,
            [
                { columnName: 'Score', semanticRole: 'descriptor', confidence: 0.9, reason: 'rating label' },
                { columnName: 'Code', semanticRole: 'code', confidence: 0.4, reason: 'weak' },
            ],
        );

        expect(result.Score).toBe('helper');
        // A weak annotation is ignored; the values decide.
        expect(result.Code).toBe('identifier');
    });
});
