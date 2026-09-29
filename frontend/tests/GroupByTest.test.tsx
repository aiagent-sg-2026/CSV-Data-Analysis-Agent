import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { computeAggregation, GroupByTest } from '../components/spreadsheet/GroupByTest';

const rows = [
    { group: 'A', pivot: 'X', amount: 10 },
    { group: 'A', pivot: 'X', amount: 30 },
    { group: 'A', pivot: 'Y', amount: 60 },
    { group: 'B', pivot: 'X', amount: 100 },
];

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
        expect(within(bodyRows[2]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['B', '100', '0', '100']);
        expect(within(bodyRows[3]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Overall average', '46.67', '60', '50']);

        fireEvent.change(screen.getByRole('combobox', { name: 'Aggregation' }), { target: { value: 'sum' } });
        expect(within(screen.getAllByRole('row')[3]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Total', '140', '60', '200']);

        fireEvent.change(screen.getByRole('combobox', { name: 'Aggregation' }), { target: { value: 'count' } });
        expect(within(screen.getAllByRole('row')[3]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['Total', '3', '1', '4']);
    });
});
