import { describe, expect, it } from 'vitest';
import type { CsvRow, QueryAggregateFunction, SeriesMeasureSemantics, SqlEvidenceQueryPlan } from '../types';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { resolveReportStructureArtifactsWithProposal } from '../services/agent/orchestration/reportStructureOrchestrator';
import { assessSeriesMeasurePlan, buildSeriesMeasureFallbackTopics, selectsSingleSeries } from '../services/agent/planning/seriesMeasureGuard';
import { generateEvidenceQueryPlanStepped } from '../services/agent/planning/planGenerator';
import { checkQuestionSeriesScope, validateResearchQuestions } from '../services/agent/runtime/pi/researchPlan';
import { createTestSettings } from './testSettings';

// Ordinary wide tables (products or stores by period) melt into series that
// share one unit. Only positive evidence, such as a published parent that
// does not add up, may mark a melted table as non-additive.

const melt = async (fileName: string, text: string) => {
    const file = ({ name: fileName, size: text.length, text: async () => text }) as unknown as File;
    const { csvData, intakeIr } = await processCsvWithIntakeIr(file);
    const artifacts = await resolveReportStructureArtifactsWithProposal({
        rawCsvData: buildCsvDataFromIntakeIr(intakeIr),
        csvData,
        rawIntakeIr: intakeIr,
        cleaningRun: null,
        dataPreparationPlan: {
            explanation: 'Import keeps the source rows unchanged.',
            operations: [],
            outputColumns: [],
            planStatus: 'schema_only',
            consistencyIssues: [],
        },
        columnProfiles: profileData(csvData.data).profiles,
        settings: createTestSettings(),
    });
    const rows: CsvRow[] = artifacts.canonicalCsvData?.data ?? [];
    return { rows, profiles: profileData(rows).profiles, seriesMeasure: artifacts.canonicalBuildMeta?.seriesMeasure ?? null };
};

const plan = (groupBy: string, fn: QueryAggregateFunction = 'sum'): SqlEvidenceQueryPlan => ({
    title: `${fn} of Value by ${groupBy}`,
    queryMode: 'aggregate',
    intentSummary: `${fn} of Value by ${groupBy}`,
    query: {
        select: [groupBy, `${fn}_value`],
        groupBy: [groupBy],
        aggregates: [{ function: fn, column: 'Value', as: `${fn}_value` }],
    },
});

const PRODUCTS = [
    'Product,2021,2022,2023,2024',
    'Apples,100,120,130,150',
    'Bananas,80,90,95,99',
    'Cherries,40,44,50,52',
    'Dates,10,11,12,13',
].join('\n') + '\n';

const STORES = [
    'Store,Jan 2024,Feb 2024,Mar 2024,Apr 2024,May 2024',
    'North,1,2,3,4,5',
    'South,2,3,4,5,6',
    'East,3,4,5,6,7',
].join('\n') + '\n';

describe('additivity of melted period-header wide tables', () => {
    it.each([
        ['sales.csv', PRODUCTS, 'Product', 16],
        ['stores.csv', STORES, 'Store', 15],
    ])('treats the plain wide table %s as comparable series in one unit', async (fileName, text, seriesColumn, rowCount) => {
        const { rows, profiles, seriesMeasure } = await melt(fileName, text);
        expect(rows).toHaveLength(rowCount);
        expect(seriesMeasure).toMatchObject({ seriesColumn, additiveAcrossSeries: true, detailRowColumns: [] });
        const semantics = seriesMeasure as SeriesMeasureSemantics;

        expect(assessSeriesMeasurePlan(plan('Period'), semantics)).toMatchObject({ decision: 'pass', reasonCodes: [] });
        expect(assessSeriesMeasurePlan(plan(seriesColumn), semantics)).toMatchObject({ decision: 'pass', reasonCodes: [] });
        expect(assessSeriesMeasurePlan(plan('Period', 'avg'), semantics).decision).toBe('pass');
        expect(assessSeriesMeasurePlan({
            title: 'raw total by period',
            queryMode: 'aggregate',
            query: { rawSql: 'SELECT "Period", SUM("Value") FROM t GROUP BY "Period"' },
        }, semantics).decision).toBe('pass');

        // Fallback topics and the stepped planner keep the sum.
        const topics = buildSeriesMeasureFallbackTopics(semantics);
        expect(topics).toEqual([
            'Value trend by Period (sum of Value by Period)',
            `Value by ${seriesColumn} (sum of Value by ${seriesColumn})`,
        ]);
        const datasetContext = { dimensionColumns: [seriesColumn, 'Period'], metricColumns: ['Value'], seriesMeasure: semantics };
        for (const [topic, groupBy] of [[topics[0], 'Period'], [topics[1], seriesColumn]]) {
            const stepped = await generateEvidenceQueryPlanStepped(
                topic, profiles, createTestSettings(), null, datasetContext, null, null, { deterministicOnly: true },
            );
            expect(stepped.query.groupBy).toEqual([groupBy]);
            expect(stepped.query.aggregates?.[0]).toMatchObject({ function: 'sum', column: 'Value' });
            expect(assessSeriesMeasurePlan(stepped, semantics).decision).toBe('pass');
        }

        // Pi research keeps a cross-series sum question as asked.
        const scoped = checkQuestionSeriesScope(validateResearchQuestions({
            questions: [{ title: 'Total by period', dimension: 'Period', metric: 'Value', aggregation: 'sum' }],
        }, profiles).questions, semantics);
        expect(scoped.rejected).toEqual([]);
        expect(scoped.questions[0].filter ?? null).toBeNull();
    });

    it('marks an indented table non-additive when a published parent does not equal its children', async () => {
        const { seriesMeasure } = await melt('mismatch.csv', [
            'DataSeries,2021,2022,2023,2024',
            'Total Population,100,110,120,130',
            '  Residents,60,61,62,63',
            '  Visitors per day,7,8,9,10',
        ].join('\n') + '\n');
        expect(seriesMeasure?.additiveAcrossSeries).toBe(false);
        expect(seriesMeasure?.unitFamilies).toEqual([]);
        expect(assessSeriesMeasurePlan(plan('Period'), seriesMeasure).reasonCodes).toContain('cross_series_aggregate');
    });

    it('marks a flat table non-additive when its total row does not equal the other rows', async () => {
        const { seriesMeasure } = await melt('flat-mismatch.csv', [
            'Region,2021,2022,2023,2024',
            'North,1,2,3,4',
            'South,2,3,4,5',
            'Total,50,60,70,80',
        ].join('\n') + '\n');
        expect(seriesMeasure?.additiveAcrossSeries).toBe(false);
    });

    it('keeps a flat table with a matching total row additive, summed over detail rows only', async () => {
        const { seriesMeasure } = await melt('flat-total.csv', [
            'Region,2021,2022,2023,2024',
            'A,1,2,3,4',
            'B,2,3,4,5',
            'C,1,1,1,1',
            'Total,4,6,8,10',
        ].join('\n') + '\n');
        expect(seriesMeasure?.additiveAcrossSeries).toBe(true);
        expect(assessSeriesMeasurePlan(plan('Period'), seriesMeasure).reasonCodes).toEqual(['series_hierarchy_double_count']);
        expect(assessSeriesMeasurePlan({
            ...plan('Period'),
            query: { ...plan('Period').query, where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] } },
        }, seriesMeasure).decision).toBe('pass');
    });
});

describe('detail-row and series filters written as a plan pre-filter', () => {
    const semantics = (): SeriesMeasureSemantics => ({
        seriesColumn: 'DataSeries',
        measureColumn: 'Value',
        periodColumn: 'Period',
        periodGrain: 'month',
        parentColumn: 'ParentSeries',
        detailRowColumns: ['RowClass'],
        detailRowValue: 'fact',
        additiveAcrossSeries: true,
        unitFamilies: [],
        evidence: { rootSeries: 1, parentSeriesChecked: 1, parentSeriesVerified: 1, parentPeriodsChecked: 1, parentPeriodsMatched: 1, summary: 'Parents equal the sum of their children.' },
        series: [
            { name: 'Total', parent: null, rowClass: 'total', observations: 2, latestPeriod: '2026-08-01' },
            { name: 'Asia', parent: 'Total', rowClass: 'subtotal', observations: 2, latestPeriod: '2026-08-01' },
            { name: 'China', parent: 'Asia', rowClass: 'fact', observations: 2, latestPeriod: '2026-08-01' },
        ],
    } as SeriesMeasureSemantics);

    const rankedBySeries = (): SqlEvidenceQueryPlan => ({
        title: 'Total Arrivals by Data Series',
        queryMode: 'aggregate',
        intentSummary: 'Rank the series.',
        query: {
            select: ['DataSeries', 'total_value'],
            groupBy: ['DataSeries'],
            aggregates: [{ function: 'sum', column: 'Value', as: 'total_value' }],
            orderBy: [{ column: 'total_value', direction: 'desc' }],
            limit: 20,
        },
    });

    it('passes a sum by series whose RowClass = fact filter is the pre-filter, exactly as when it is in the WHERE clause', () => {
        const inWhere = { ...rankedBySeries(), query: { ...rankedBySeries().query, where: { predicates: [{ column: 'RowClass', operator: 'eq' as const, value: 'fact' }] } } };
        const inPreFilter = { ...rankedBySeries(), preFilter: [{ column: 'RowClass', operator: 'eq' as const, value: 'fact' }] };

        expect(assessSeriesMeasurePlan(inWhere, semantics())).toMatchObject({ decision: 'pass', reasonCodes: [] });
        expect(assessSeriesMeasurePlan(inPreFilter, semantics())).toMatchObject({ decision: 'pass', reasonCodes: [] });
        // Without any detail-row filter the hierarchy levels still mix.
        expect(assessSeriesMeasurePlan(rankedBySeries(), semantics())).toMatchObject({ decision: 'table_only', reasonCodes: ['series_hierarchy_mix'] });
    });

    it('reads one series named in the pre-filter', () => {
        const plan = { ...rankedBySeries(), preFilter: [{ column: 'DataSeries', operator: 'eq' as const, value: 'China' }] };
        expect(selectsSingleSeries(plan, semantics())).toBe(true);
        expect(selectsSingleSeries(rankedBySeries(), semantics())).toBe(false);
    });
});
