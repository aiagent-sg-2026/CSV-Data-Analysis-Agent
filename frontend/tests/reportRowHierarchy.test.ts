import { describe, expect, it } from 'vitest';
import { resolveIndentHierarchy } from '../services/agent/reportShapeHierarchy';

const row = (...values: number[]) => ({ A: values[0], B: values[1] });

describe('resolveIndentHierarchy', () => {
    const labels = ['North', '    Alpha', '    Beta', 'South', '    Gamma'];

    it('accepts an indentation tree whose parents equal the sum of their children', () => {
        const result = resolveIndentHierarchy({
            labels,
            rows: [row(30, 3), row(10, 1), row(20, 2), row(5, 5), row(5, 5)],
            measureColumns: ['A', 'B'],
        });
        expect(result?.entries.map(entry => [entry.key, entry.level, entry.parentKey, entry.rowClass])).toEqual([
            ['North', 0, null, 'subtotal'],
            ['Alpha', 1, 'North', 'fact'],
            ['Beta', 1, 'North', 'fact'],
            ['South', 0, null, 'subtotal'],
            ['Gamma', 1, 'South', 'fact'],
        ]);
        expect(result?.evidence).toMatchObject({ parentsChecked: 2, parentsVerified: 2, levels: 2 });
    });

    it('rejects cosmetic indentation whose numbers do not add up', () => {
        const result = resolveIndentHierarchy({
            labels,
            rows: [row(100, 1), row(10, 1), row(20, 2), row(7, 5), row(5, 5)],
            measureColumns: ['A', 'B'],
        });
        expect(result).toBeNull();
    });

    it('lets non-additive columns disagree as long as most columns reconcile', () => {
        const result = resolveIndentHierarchy({
            labels: ['North', '  Alpha', '  Beta'],
            rows: [{ A: 30, B: 9, C: 1.5 }, { A: 10, B: 4, C: 2 }, { A: 20, B: 5, C: 1 }],
            measureColumns: ['A', 'B', 'C'],
        });
        expect(result?.entries[0].rowClass).toBe('subtotal');
    });

    it('rejects labels without indentation, and an indented row with no parent above it', () => {
        expect(resolveIndentHierarchy({ labels: ['A', 'B', 'C'], rows: [row(1, 1), row(2, 2), row(3, 3)], measureColumns: ['A'] })).toBeNull();
        expect(resolveIndentHierarchy({ labels: ['  A', 'B', 'C'], rows: [row(1, 1), row(2, 2), row(3, 3)], measureColumns: ['A'] })).toBeNull();
    });

    it('keeps heading rows without numbers in the tree as parents', () => {
        const result = resolveIndentHierarchy({
            labels: ['Assets', '  Cash', '  Bank'],
            rows: [null, row(1, 1), row(2, 2)],
            measureColumns: ['A'],
        });
        // A heading has nothing to reconcile, so there is no evidence for the tree.
        expect(result).toBeNull();
    });

    it('gives repeated labels distinct keys through their ancestors', () => {
        const result = resolveIndentHierarchy({
            labels: ['North', '  Other', 'South', '  Other'],
            rows: [row(1, 1), row(1, 1), row(2, 2), row(2, 2)],
            measureColumns: ['A'],
        });
        expect(result?.entries.map(entry => entry.key)).toEqual(['North', 'North > Other', 'South', 'South > Other']);
    });
});
