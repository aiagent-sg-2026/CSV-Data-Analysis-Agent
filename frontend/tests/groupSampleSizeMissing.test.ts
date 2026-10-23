import { describe, expect, it } from 'vitest';
import type { CsvRow, SqlEvidenceQueryPlan } from '../types';
import { executeDataQuery } from '../services/agent/execution/dataQueryExecutor';
import { measureLeadingGroupSampleSize } from '../services/agent/planning/groupSampleSize';

// The small-sample caveat must count the values a ranked median is computed
// from: a group of 40 rows with 38 `na` measures is a median of two values.

const rowsFor = (school: string, values: string[]): CsvRow[] => values.map(value => ({ school, pay: value }));

const DATA: CsvRow[] = [
    ...rowsFor('Thin School', [...Array.from({ length: 38 }, () => 'na'), '9000', '9100']),
    ...['A', 'B', 'C', 'D', 'E'].flatMap((school, index) =>
        rowsFor(`School ${school}`, Array.from({ length: 20 }, (_, row) => String(3000 + index * 100 + row)))),
];

const PLAN: SqlEvidenceQueryPlan = {
    title: 'Median pay by school',
    queryMode: 'aggregate',
    intentSummary: 'Rank schools by median pay.',
    preferredResultShape: 'ranked_aggregate',
    query: {
        select: ['school', 'median_pay'],
        groupBy: ['school'],
        aggregates: [{ function: 'median', column: 'pay', as: 'median_pay' }],
        orderBy: [{ column: 'median_pay', direction: 'desc' }],
        limit: 20,
    },
};

const runQuery = async (plan: SqlEvidenceQueryPlan) => ({
    result: executeDataQuery(DATA, plan.query, { allowedColumns: ['school', 'pay'] }),
});

describe('small-sample caveat on a measure with missing values', () => {
    it('counts the reported values of the ranked measure, not the rows', async () => {
        const evidence = await runQuery(PLAN);
        expect(evidence.result.rows[0]).toMatchObject({ school: 'Thin School', median_pay: 9050 });

        const caveat = await measureLeadingGroupSampleSize(PLAN, evidence.result.rows, async checkPlan => {
            expect(checkPlan.query.aggregates).toEqual([{ function: 'count', column: 'pay', as: 'sample_size_rows' }]);
            return runQuery(checkPlan);
        });
        expect(caveat?.leaders[0]).toEqual({ label: 'Thin School', rows: 2, rank: 1 });
        expect(caveat?.medianGroupRows).toBe(20);
    });
});
