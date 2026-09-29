import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeAggregation, GroupByTest } from '../components/spreadsheet/GroupByTest';

const rows = [
    { group: 'A', pivot: 'X', amount: 10 },
    { group: 'A', pivot: 'X', amount: 30 },
    { group: 'A', pivot: 'Y', amount: 60 },
    { group: 'B', pivot: 'X', amount: 100 },
];

afterEach(cleanup);

describe('GroupByTest', () => {
    it('uses the row-weighted overall average instead of adding group averages', () => {
        const result = computeAggregation(rows, 'group', 'amount', 'avg');

        expect(result.rows).toEqual([
            { group: 'B', amount: 100 },
            { group: 'A', amount: 33.33 },
        ]);
        expect(result.total).toBe(50);
    });

    it('shows a setup prompt before selection, then weighted pivot averages', () => {
        render(<GroupByTest rows={rows} language="English" accentColor="blue" />);

        expect(screen.getByText('Select a group and value column to preview results.')).toBeTruthy();
        fireEvent.change(screen.getByRole('combobox', { name: 'Group By' }), { target: { value: 'group' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Pivot By (optional)' }), { target: { value: 'pivot' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Aggregation' }), { target: { value: 'avg' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Value Column' }), { target: { value: 'amount' } });

        const bodyRows = screen.getAllByRole('row');
        expect(within(bodyRows[1]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['A', '20', '60', '33.33']);
        expect(within(bodyRows[2]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['B', '100', '—', '100']);
        expect(within(bodyRows[3]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Overall average', '46.67', '60', '50']);

        fireEvent.change(screen.getByRole('combobox', { name: 'Aggregation' }), { target: { value: 'sum' } });
        expect(within(screen.getAllByRole('row')[3]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Total', '140', '60', '200']);

        fireEvent.change(screen.getByRole('combobox', { name: 'Aggregation' }), { target: { value: 'count' } });
        expect(within(screen.getAllByRole('row')[3]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Total', '3', '1', '4']);
    });

    it('ignores missing numeric values in averages instead of treating them as zero', () => {
        const sparseRows = [
            { group: 'A', pivot: 'X', amount: 10 },
            { group: 'A', pivot: 'X', amount: '' },
            { group: 'B', pivot: 'Y', amount: 30 },
            { group: 'C', pivot: 'Z', amount: 'n/a' },
        ];

        expect(computeAggregation(sparseRows, 'group', 'amount', 'avg')).toEqual({
            rows: [
                { group: 'B', amount: 30 },
                { group: 'A', amount: 10 },
                { group: 'C', amount: null },
            ],
            total: 20,
        });
        expect(computeAggregation(sparseRows, 'group', 'amount', 'count').total).toBe(4);

        render(<GroupByTest rows={sparseRows} language="English" accentColor="blue" />);
        fireEvent.change(screen.getByRole('combobox', { name: 'Group By' }), { target: { value: 'group' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Pivot By (optional)' }), { target: { value: 'pivot' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Aggregation' }), { target: { value: 'avg' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Value Column' }), { target: { value: 'amount' } });

        expect(within(screen.getAllByRole('row')[3]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['C', '—', '—', '—', '—']);
        expect(within(screen.getAllByRole('row')[4]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Overall average', '10', '30', '—', '20']);
    });

    it('sends computed pivot row averages to Create Card', () => {
        const onRequestCard = vi.fn();
        render(<GroupByTest rows={rows} language="English" accentColor="blue" onRequestCard={onRequestCard} />);
        fireEvent.change(screen.getByRole('combobox', { name: 'Group By' }), { target: { value: 'group' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Pivot By (optional)' }), { target: { value: 'pivot' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Aggregation' }), { target: { value: 'avg' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Value Column' }), { target: { value: 'amount' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Card' }));

        expect(onRequestCard).toHaveBeenCalledWith(
            expect.stringContaining('Aggregation=AVG, 2 groups, overall=50. Breakdown: A: 33.33, B: 100.'),
            expect.any(Array),
        );
    });

    it('discloses hidden pivot groups when totals cover more than the visible table', () => {
        const manyGroups = Array.from({ length: 21 }, (_, index) => ({
            group: `G${String(index).padStart(2, '0')}`,
            pivot: `P${String(index % 16).padStart(2, '0')}`,
            amount: 1,
        }));
        render(<GroupByTest rows={manyGroups} language="English" accentColor="blue" />);
        fireEvent.change(screen.getByRole('combobox', { name: 'Group By' }), { target: { value: 'group' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Pivot By (optional)' }), { target: { value: 'pivot' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Value Column' }), { target: { value: 'amount' } });

        expect(screen.getByText('Showing 20 of 21 row groups and 15 of 16 pivot values. Totals include all grouped rows and pivot values.')).toBeTruthy();
        expect(within(screen.getAllByRole('row').at(-1)!).getAllByRole('cell').at(-1)?.textContent).toBe('21');
    });
});
