// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { ColumnProfile, CsvRow } from '../types';
import { normalizeAndValidateSqlEvidenceQueryPlan } from '../services/agent/planning/sqlPlanValidator';
import { profileData } from '../services/data/dataProfiler';

// 36 monthly periods of two melted series, like the transport demo table.
const PERIODS = Array.from({ length: 36 }, (_value, index) => `${2021 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
const rows: CsvRow[] = ['Average Daily Ridership - MRT', 'Average Daily Ridership - LRT'].flatMap((series, seriesIndex) =>
    PERIODS.map((period, periodIndex) => ({
        DataSeries: series,
        Period: period,
        Value: 1000 * (seriesIndex + 1) + periodIndex,
    })));
const profiles: ColumnProfile[] = profileData(rows).profiles;

// Plan the Default gateway returned for "Average Daily Ridership - MRT by Period"
// (2026-10-23): limit 31 for a 36-period trend.
const gatewayPlan = (query: Record<string, unknown> = {}, preferredResultShape = 'time_series') => ({
    title: 'Average Daily Ridership - MRT by Period',
    queryMode: 'aggregate',
    intentSummary: 'Show the MRT average daily ridership series across periods.',
    preferredResultShape,
    preFilter: [],
    query: {
        select: ['Period', 'avg_daily_ridership_mrt'],
        groupBy: ['Period'],
        aggregates: [{ function: 'avg', column: 'Value', as: 'avg_daily_ridership_mrt', percentile: 0 }],
        where: { predicates: [{ column: 'DataSeries', operator: 'eq', value: 'Average Daily Ridership - MRT' }] },
        orderBy: [{ column: 'Period', direction: 'asc' }],
        limit: 31,
        aggregateFilters: [],
        ...query,
    },
});

const normalize = (rawPlan: unknown) => normalizeAndValidateSqlEvidenceQueryPlan(rawPlan, profiles, { lenient: true });

describe('time-series evidence plan limits', () => {
    it('does not let a model-chosen limit drop periods from an oldest-first time series', () => {
        const { validPlan, errors } = normalize(gatewayPlan());
        expect(errors).toEqual([]);
        expect(validPlan?.query.limit).toBeGreaterThanOrEqual(PERIODS.length * 2);
        expect(validPlan?.query.orderBy).toEqual([{ column: 'Period', direction: 'asc' }]);
    });

    it('treats a temporal group-by ordered by time as a time series without the shape hint', () => {
        const { validPlan } = normalize(gatewayPlan({}, 'ranked_aggregate'));
        expect(validPlan?.query.limit).toBeGreaterThanOrEqual(PERIODS.length);
    });

    it('keeps an explicit newest-first window', () => {
        const { validPlan } = normalize(gatewayPlan({ orderBy: [{ column: 'Period', direction: 'desc' }], limit: 12 }));
        expect(validPlan?.query.limit).toBe(12);
    });

    it('keeps the limit of a ranking by value', () => {
        const { validPlan } = normalize(gatewayPlan({ orderBy: [{ column: 'avg_daily_ridership_mrt', direction: 'desc' }], limit: 5 }, 'ranked_aggregate'));
        expect(validPlan?.query.limit).toBe(5);
    });
});
