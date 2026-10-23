import { describe, expect, it } from 'vitest';
import type { EvidenceHarnessContext, SqlEvidenceQueryPlan } from '../types';
import {
    assessRowHierarchyPlan,
    buildRowHierarchyGuidance,
    mergePlanVerdicts,
    resolveRowHierarchy,
    withDetailRowScope,
    withRowHierarchyDetailFilter,
    type RowHierarchyContract,
} from '../services/agent/planning/rowHierarchyGuard';

const contract: RowHierarchyContract = {
    labelColumn: 'Name',
    parentColumn: 'ParentSeries',
    depthColumn: 'HierarchyDepth',
    rowClassColumn: 'RowClass',
    levelColumns: ['Region', 'Country'],
    detailRowValue: 'fact',
};

const plan = (query: Partial<SqlEvidenceQueryPlan['query']>, extra: Partial<SqlEvidenceQueryPlan> = {}): SqlEvidenceQueryPlan => ({
    title: 'Total by region',
    queryMode: 'aggregate',
    intentSummary: 'Total by region',
    query: {
        select: ['Region', 'sum_total'],
        groupBy: ['Region'],
        aggregates: [{ function: 'sum', column: 'Total', as: 'sum_total' }],
        ...query,
    },
    ...extra,
});

describe('resolveRowHierarchy', () => {
    const meta = { rowHierarchy: { ...contract, levels: 3, parentRows: 2, detailRows: 5, parentsChecked: 2, parentsVerified: 2 } };

    it('reads the hierarchy recorded at intake while its columns still exist', () => {
        expect(resolveRowHierarchy({ canonicalBuildMeta: meta })).toMatchObject({ rowClassColumn: 'RowClass', levelColumns: ['Region', 'Country'] });
        expect(resolveRowHierarchy({ canonicalBuildMeta: meta, columnProfiles: [{ name: 'RowClass' }, { name: 'Name' }] })).not.toBeNull();
        expect(resolveRowHierarchy({ canonicalBuildMeta: meta, columnProfiles: [{ name: 'Name' }] })).toBeNull();
        expect(resolveRowHierarchy({ canonicalBuildMeta: { rowHierarchy: null } })).toBeNull();
    });
});

describe('assessRowHierarchyPlan', () => {
    it('passes everything when the table has no hierarchy', () => {
        expect(assessRowHierarchyPlan(plan({}), null).decision).toBe('pass');
    });

    it.each([
        ['a sum', plan({})],
        ['a row count', plan({ aggregates: [{ function: 'count', as: 'rows' }] })],
        ['a median', plan({ aggregates: [{ function: 'median', column: 'Total', as: 'm' }] })],
        ['a RowClass scope that keeps parents', plan({ where: { predicates: [{ column: 'RowClass', operator: 'in', value: ['fact', 'subtotal'] }] } })],
        ['raw SQL without the filter', plan({ rawSql: 'SELECT "Region", SUM("Total") FROM t GROUP BY 1' })],
    ])('rejects %s without the detail-row filter', (_label, evidencePlan) => {
        const verdict = assessRowHierarchyPlan(evidencePlan, contract);
        expect(verdict.decision).toBe('reject');
        expect(verdict.reasonCodes).toEqual(['series_hierarchy_double_count']);
        expect(verdict.feedback).toContain("WHERE \"RowClass\" = 'fact'");
        expect(verdict.feedback).toContain('"Region" or "Country"');
    });

    it.each([
        ['the filter in the WHERE clause', plan({ where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] } })],
        ['the filter in the pre-filter', plan({}, { preFilter: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] })],
        ['the filter on the aggregate', plan({ aggregates: [{ function: 'sum', column: 'Total', as: 'sum_total', where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] } }] })],
        ['one depth', plan({ where: { predicates: [{ column: 'HierarchyDepth', operator: 'eq', value: 0 }] } })],
        ['one named row', plan({ where: { predicates: [{ column: 'Name', operator: 'eq', value: 'EUROPE' }] } })],
        ['raw SQL with the filter', plan({ rawSql: `SELECT SUM("Total") FROM t WHERE "RowClass" = 'fact'` })],
        ['raw SQL without an aggregate', plan({ rawSql: 'SELECT * FROM t LIMIT 5' })],
    ])('passes %s', (_label, evidencePlan) => {
        expect(assessRowHierarchyPlan(evidencePlan, contract).decision).toBe('pass');
    });

    it('keeps an unscoped row listing as a table instead of rejecting it', () => {
        const listing = plan({ aggregates: undefined, groupBy: undefined, select: ['Name', 'Total'] }, { queryMode: 'rowset' });
        expect(assessRowHierarchyPlan(listing, contract)).toMatchObject({ decision: 'table_only', reasonCodes: ['series_hierarchy_mix'] });
    });

    it('merges verdicts to the stricter one and keeps both reason codes', () => {
        const merged = mergePlanVerdicts(
            { decision: 'table_only', reasonCodes: ['series_hierarchy_mix'], feedback: null },
            { decision: 'reject', reasonCodes: ['series_hierarchy_double_count'], feedback: 'fix it' },
        );
        expect(merged).toEqual({ decision: 'reject', reasonCodes: ['series_hierarchy_mix', 'series_hierarchy_double_count'], feedback: 'fix it' });
    });
});

describe('detail-row scope and steering', () => {
    it('adds the filter to the pre-filter and the query, and nothing when the plan states its own scope', () => {
        const scoped = withDetailRowScope(plan({}), contract);
        expect(scoped.preFilter).toEqual([{ column: 'RowClass', operator: 'eq', value: 'fact' }]);
        expect(scoped.query.where?.predicates).toEqual([{ column: 'RowClass', operator: 'eq', value: 'fact' }]);
        const ownScope = plan({ where: { predicates: [{ column: 'HierarchyDepth', operator: 'eq', value: 1 }] } });
        expect(withDetailRowScope(ownScope, contract)).toBe(ownScope);
        expect(withDetailRowScope(plan({}), null).preFilter).toBeUndefined();
    });

    it('overrides whatever detail-row contract the harness detected', () => {
        const harness = {
            detailRowColumn: 'RowRole', detailRowValue: 'detail', detailRowFilter: { column: 'RowRole', value: 'detail' },
            detailRowPolicy: 'uncertain', hierarchyMode: 'none',
        } as unknown as EvidenceHarnessContext;
        expect(withRowHierarchyDetailFilter(harness, contract)).toMatchObject({
            detailRowColumn: 'RowClass',
            detailRowValue: 'fact',
            detailRowFilter: { column: 'RowClass', value: 'fact' },
            detailRowPolicy: 'exclude_non_detail_rows',
            hierarchyMode: 'preserve',
        });
        expect(withRowHierarchyDetailFilter(harness, null)).toBe(harness);
    });

    it('states the rule for every planner', () => {
        const guidance = buildRowHierarchyGuidance(contract);
        expect(guidance).toContain("WHERE \"RowClass\" = 'fact'");
        expect(guidance).toContain('COUNT of rows');
        expect(guidance).toContain('"Region", "Country"');
    });
});
