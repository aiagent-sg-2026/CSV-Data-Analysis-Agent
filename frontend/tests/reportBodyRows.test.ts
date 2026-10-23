import { describe, expect, it } from 'vitest';
import { classifyBodyRows, parseReportAmount, withoutBodyNoise } from '../services/data/reportBodyRows';

const boundary = (bodyStartIndex: number, summaryStartIndex: number | null = null, headerRowIndex = bodyStartIndex - 1) => ({
    headerRowIndex,
    headerLayerRowIndexes: [] as number[],
    bodyStartIndex,
    summaryStartIndex,
});

const kinds = (rows: string[][], b: ReturnType<typeof boundary>) =>
    Object.fromEntries([...classifyBodyRows(rows, b)].map(([index, finding]) => [index, finding.kind]));

describe('parseReportAmount', () => {
    it.each([
        ['1,234.50', 1234.5],
        ['(1,234.50)', -1234.5],
        ['1,234.50-', -1234.5],
        ['-12', -12],
        ['$ 1,000', 1000],
        ['.5', 0.5],
    ])('reads %s', (text, expected) => {
        expect(parseReportAmount(text)).toBe(expected);
    });

    it.each(['', 'n.a.', '12,34', '01-02-2026', 'SO100001', '(12', '1.2.3'])('rejects %j', text => {
        expect(parseReportAmount(text)).toBeNull();
    });
});

describe('classifyBodyRows', () => {
    const header = ['Item', 'Qty', 'Amount'];

    it('marks blank rows and rows repeating the header', () => {
        const rows = [
            header,
            ['A', '1', '10.00'],
            ['', '', ''],
            header,
            ['B', '2', '20.00'],
        ];
        expect(kinds(rows, boundary(1))).toEqual({ 2: 'blank', 3: 'repeated_header' });
    });

    it('keeps a data row that only shares one word with the header', () => {
        const rows = [header, ['Item', '1', '10.00'], ['B', '2', '20.00']];
        expect(kinds(rows, boundary(1))).toEqual({});
    });

    it('recognises repeated outer header bands', () => {
        const rows = [
            ['', 'Order', '', 'Amount'],
            ['Item', 'Date', 'Ref', 'Value'],
            ['A', '01-01-2026', 'R1', '10.00'],
            ['', 'Order', '', 'Amount'],
            ['Item', 'Date', 'Ref', 'Value'],
            ['B', '02-01-2026', 'R2', '20.00'],
        ];
        const result = classifyBodyRows(rows, { headerRowIndex: 1, headerLayerRowIndexes: [0], bodyStartIndex: 2, summaryStartIndex: null });
        expect([...result].map(([index, finding]) => [index, finding.kind])).toEqual([[3, 'repeated_header'], [4, 'repeated_header']]);
    });

    it('treats a recurring title and page number block as page breaks with digits masked', () => {
        const rows = [
            ['ACME REPORT'],
            ['Printed by: ADMIN  Page 1 of 9'],
            header,
            ['A', '1', '10.00'],
            ['ACME REPORT'],
            ['Printed by: ADMIN  Page 2 of 9'],
            header,
            ['B', '2', '20.00'],
            ['ACME REPORT'],
            ['C', '3', '30.00'],
        ];
        expect(kinds(rows, boundary(3, null, 2))).toEqual({ 4: 'page_break', 5: 'page_break', 6: 'repeated_header', 8: 'page_break' });
    });

    it('keeps a single heading that merely equals a line above the header', () => {
        const rows = [
            ['Region: ASEAN'],
            header,
            ['A', '1', '10.00'],
            ['Region: ASEAN'],
            ['B', '2', '20.00'],
        ];
        expect(kinds(rows, boundary(2, null, 1))).toEqual({});
    });

    it('recognises continuation markers but not a heading that starts with the word', () => {
        const rows = [
            header,
            ['A', '1', '10.00'],
            ['Continued...'],
            ['(continued from previous page)'],
            ['Continued operations'],
            ['B', '2', '20.00'],
        ];
        expect(kinds(rows, boundary(1))).toEqual({ 2: 'page_break', 3: 'page_break' });
    });

    describe('subtotals', () => {
        it('removes a subtotal whose amount equals the group sum, even when printed in a shifted column', () => {
            const rows = [
                ['Group', 'Item', 'Qty', 'Amount', ''],
                ['G1', 'A', '1', '10.00', ''],
                ['', 'B', '2', '5.50', ''],
                ['', 'Sub Total:', '', '', '15.50'],
                ['G2', 'C', '3', '7.25', ''],
                ['', 'Sub Total:', '', '', '7.25'],
            ];
            expect(kinds(rows, boundary(1))).toEqual({ 3: 'subtotal', 5: 'subtotal' });
        });

        it('recognises a grand total of everything above, with the subtotals in between', () => {
            const rows = [
                ['Item', 'Amount'],
                ['A', '10'],
                ['Subtotal', '10'],
                ['B', '20'],
                ['Subtotal', '20'],
                ['Grand Total:', '30'],
            ];
            expect(kinds(rows, boundary(1))).toEqual({ 2: 'subtotal', 4: 'subtotal', 5: 'total' });
        });

        it('keeps a "Total" row in the middle of data when its amount does not reconcile', () => {
            const rows = [
                ['Item', 'Amount'],
                ['A', '10.00'],
                ['B', '20.00'],
                ['Total', '99.00'],
                ['C', '5.00'],
            ];
            expect(kinds(rows, boundary(1))).toEqual({});
        });

        it('keeps a business named like a total when the amount is not a sum', () => {
            const rows = [
                ['Customer', 'Amount'],
                ['Acme', '10.00'],
                ['Total Plumbing', '12.00'],
                ['Zeta', '3.00'],
            ];
            expect(kinds(rows, boundary(1))).toEqual({});
        });

        it('does not treat a first row as a total of nothing', () => {
            const rows = [['Item', 'Amount'], ['Total', '10'], ['A', '10']];
            expect(kinds(rows, boundary(1))).toEqual({});
        });

        it('does not reconcile a labelled row that carries a date', () => {
            const rows = [
                ['Item', 'Date', 'Amount'],
                ['A', '01-01-2026', '10'],
                ['Total', '02-01-2026', '10'],
            ];
            expect(kinds(rows, boundary(1))).toEqual({});
        });

        it('lets a grand total reconcile past an unverified summary-labelled row', () => {
            const rows = [
                ['Item', 'Amount'],
                ['A', '10'],
                ['Balance b/f', '3'],
                ['B', '20'],
                ['Total', '30'],
            ];
            expect(kinds(rows, boundary(1))).toEqual({ 4: 'total' });
        });
    });

    it('only looks inside the body window', () => {
        const rows = [header, ['A', '1', '10'], ['', '', ''], ['Total', '', '10']];
        expect(kinds(rows, boundary(1, 3))).toEqual({ 2: 'blank' });
    });
});

describe('withoutBodyNoise', () => {
    it('drops the findings and shifts only the end of the body', () => {
        const rows = [['Item', 'Amount'], ['A', '1'], ['', ''], ['B', '2'], ['Total', '3']];
        const result = withoutBodyNoise(rows, boundary(1, 5));
        expect(result.rows).toEqual([['Item', 'Amount'], ['A', '1'], ['B', '2']]);
        expect(result.bodyStartIndex).toBe(1);
        expect(result.summaryStartIndex).toBe(3);
    });
});
