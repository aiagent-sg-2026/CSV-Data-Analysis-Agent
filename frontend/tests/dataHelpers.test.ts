import { describe, expect, it } from 'vitest';
import { applyTopNWithOthers } from '../utils/dataHelpers';

describe('applyTopNWithOthers', () => {
    it('keeps the top N rows visible and appends Others as an extra bucket', () => {
        const result = applyTopNWithOthers(
            [
                { label: 'A', value: 50 },
                { label: 'B', value: 40 },
                { label: 'C', value: 30 },
                { label: 'D', value: 20 },
            ],
            'label',
            'value',
            2,
        );

        expect(result).toEqual([
            { label: 'A', value: 50 },
            { label: 'B', value: 40 },
            { label: 'Others', value: 50 },
        ]);
    });

    describe('with the measured total of a cut-off ranking', () => {
        const rows = [
            { label: 'A', value: 50 },
            { label: 'B', value: 40 },
            { label: 'C', value: 30 },
        ];

        it('makes Others the total minus the groups shown, including groups the query never returned', () => {
            // 3 rows came back, but the query matched more groups worth 100 more.
            expect(applyTopNWithOthers(rows, 'label', 'value', 2, 'desc', 220)).toEqual([
                { label: 'A', value: 50 },
                { label: 'B', value: 40 },
                { label: 'Others', value: 130 },
            ]);
        });

        it('adds Others even when every returned row is shown, since unreturned groups remain', () => {
            expect(applyTopNWithOthers(rows, 'label', 'value', 5, 'desc', 220)).toEqual([
                ...rows,
                { label: 'Others', value: 100 },
            ]);
        });

        it('adds no Others bucket when the shown groups already make up the total', () => {
            expect(applyTopNWithOthers(rows, 'label', 'value', 3, 'desc', 120)).toEqual(rows);
            expect(applyTopNWithOthers(rows, 'label', 'value', 3, 'desc', 120 + 1e-12)).toEqual(rows);
        });

        it('keeps the lowest groups of an ascending ranking and folds the rest into the total', () => {
            expect(applyTopNWithOthers(rows, 'label', 'value', 1, 'asc', 220)).toEqual([
                { label: 'C', value: 30 },
                { label: 'Others', value: 190 },
            ]);
        });

        it('keeps the row-based fold when no total is given', () => {
            expect(applyTopNWithOthers(rows, 'label', 'value', 2, 'desc', null)).toEqual([
                { label: 'A', value: 50 },
                { label: 'B', value: 40 },
                { label: 'Others', value: 30 },
            ]);
        });
    });
});
