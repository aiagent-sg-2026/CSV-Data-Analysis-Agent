import { describe, expect, it } from 'vitest';
import { injectDirectivesIntoQueryPlan } from '../services/duckdb/directiveInjector';

const LABEL_COLUMN = 'Region / Country / Customer';
const columns = [LABEL_COLUMN, 'RowClass', 'Total'];
const basePlan = { select: ['Total'], aggregates: [{ function: 'sum', column: 'Total', as: 's' }] } as never;

const directives = (extra: Record<string, unknown> = {}) => ({
    excludeFromAggregation: ['Customer A', 'Customer B'],
    hierarchyColumn: LABEL_COLUMN,
    detailRowColumn: 'RowClass',
    detailRowValue: 'fact',
    detailRowFilter: { column: 'RowClass', value: 'fact' },
    ...extra,
}) as never;

describe('directive injector hierarchy exclusion', () => {
    it('never stacks a label list on a detail-row contract', () => {
        const result = injectDirectivesIntoQueryPlan(basePlan, { directives: directives(), availableColumns: columns });
        expect(result.injected.some(entry => entry.startsWith('hierarchy_exclusion'))).toBe(false);
        expect(JSON.stringify(result.plan)).not.toContain('not_in');
        expect(result.injected.length).toBeGreaterThan(0);
    });

    it('does not remove rows from a plan that states the detail scope itself', () => {
        const plan = { ...(basePlan as object), where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] } } as never;
        const result = injectDirectivesIntoQueryPlan(plan, { directives: directives(), availableColumns: columns, isSummaryRowTopic: true });
        expect(result.injected.some(entry => entry.startsWith('hierarchy_exclusion'))).toBe(false);
    });

    it('keeps the exclusion for tables without any detail-row contract', () => {
        const result = injectDirectivesIntoQueryPlan(basePlan, {
            directives: directives({ detailRowColumn: null, detailRowValue: null, detailRowFilter: null }),
            availableColumns: columns,
        });
        expect(result.injected.some(entry => entry.startsWith('hierarchy_exclusion'))).toBe(true);
    });
});
