import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CsvRow, SeriesMeasureSemantics, SqlEvidenceQueryPlan } from '../types';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { resolveReportStructureArtifactsWithProposal } from '../services/agent/orchestration/reportStructureOrchestrator';
import { buildUniqueSeriesKeys } from '../services/agent/reportShapePeriodWide';
import {
    assessSeriesMeasurePlan,
    buildSeriesMeasureFallbackTopics,
    resolveTopicSeriesFilter,
    selectsSingleSeries,
} from '../services/agent/planning/seriesMeasureGuard';
import { checkQuestionSeriesScope } from '../services/agent/runtime/pi/researchPlan';
import { createTestSettings } from './testSettings';

// A child label that repeats under different parents (Male under both Total
// Residents and Citizens) must not let `DataSeries = 'Male'` pass as one series.

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
    return {
        rows: (artifacts.canonicalCsvData?.data ?? []) as CsvRow[],
        seriesMeasure: artifacts.canonicalBuildMeta?.seriesMeasure as SeriesMeasureSemantics,
    };
};

const POPULATION = [
    'DataSeries,2024,2023,2022,2021',
    'Total Residents,100,90,80,70',
    '  Male,48,44,39,34',
    '  Female,52,46,41,36',
    'Citizens,60,55,50,45',
    '  Male,29,27,24,22',
    '  Female,31,28,26,23',
].join('\n') + '\n';

const sumByPeriod = (where?: SqlEvidenceQueryPlan['query']['where'], rawSql?: string): SqlEvidenceQueryPlan => ({
    title: 'Male trend',
    queryMode: 'aggregate',
    intentSummary: 'Male trend',
    query: rawSql
        ? { rawSql }
        : { select: ['Period', 'v'], groupBy: ['Period'], where, aggregates: [{ function: 'sum', column: 'Value', as: 'v' }] },
});

const seriesEq = (value: string) => ({ predicates: [{ column: 'DataSeries', operator: 'eq' as const, value }] });

describe('repeated series labels in a melted period table', () => {
    let rows: CsvRow[] = [];
    let semantics: SeriesMeasureSemantics;

    beforeAll(async () => {
        ({ rows, seriesMeasure: semantics } = await melt('population.csv', POPULATION));
    });

    it('stores a unique series key for a repeated label and keeps unique labels as they are', () => {
        expect(rows.filter(row => row.Period === '2024-01-01').map(row => [row.DataSeries, row.ParentSeries])).toEqual([
            ['Total Residents', null],
            ['Total Residents > Male', 'Total Residents'],
            ['Total Residents > Female', 'Total Residents'],
            ['Citizens', null],
            ['Citizens > Male', 'Citizens'],
            ['Citizens > Female', 'Citizens'],
        ]);
        expect(semantics.series.map(series => [series.name, series.label ?? null, series.parent])).toEqual([
            ['Total Residents', null, null],
            ['Total Residents > Male', 'Male', 'Total Residents'],
            ['Total Residents > Female', 'Female', 'Total Residents'],
            ['Citizens', null, null],
            ['Citizens > Male', 'Male', 'Citizens'],
            ['Citizens > Female', 'Female', 'Citizens'],
        ]);
        expect(semantics.unitFamilies).toEqual([
            { parent: 'Total Residents', children: ['Total Residents > Male', 'Total Residents > Female'] },
            { parent: 'Citizens', children: ['Citizens > Male', 'Citizens > Female'] },
        ]);
    });

    it('never treats the bare repeated label as one series', () => {
        for (const label of ['Male', 'male ']) {
            const plan = sumByPeriod(seriesEq(label));
            expect(selectsSingleSeries(plan, semantics)).toBe(false);
            expect(assessSeriesMeasurePlan(plan, semantics)).toMatchObject({ decision: 'reject', reasonCodes: ['cross_series_aggregate'] });
        }
        expect(assessSeriesMeasurePlan(sumByPeriod(undefined, `SELECT "Period", SUM("Value") FROM t WHERE "DataSeries" = 'Male' GROUP BY "Period"`), semantics).decision)
            .toBe('reject');
        expect(resolveTopicSeriesFilter("Male trend by Period (avg of Value by Period, where DataSeries = 'Male')", semantics)).toBeNull();

        const scoped = checkQuestionSeriesScope([
            { title: 'Male residents trend', rationale: '', dimension: 'Period', metric: 'Value', aggregation: 'avg', comparison: null, series: 'Male' },
        ], semantics);
        expect(scoped.questions).toEqual([]);
        expect(scoped.rejected[0].reason).toContain('"Total Residents > Male", "Citizens > Male"');
    });

    it('accepts the unique key as one series', () => {
        const plan = sumByPeriod(seriesEq('Citizens > Male'));
        expect(selectsSingleSeries(plan, semantics)).toBe(true);
        expect(assessSeriesMeasurePlan(plan, semantics).decision).toBe('pass');
        expect(resolveTopicSeriesFilter("trend (where DataSeries = 'citizens > male')", semantics)).toBe('Citizens > Male');
    });

    it('builds fallback topics on unique keys only', () => {
        const topics = buildSeriesMeasureFallbackTopics(semantics, 6);
        expect(topics.length).toBeGreaterThan(0);
        expect(topics.some(topic => topic.includes("DataSeries = 'Male'") || topic.includes("DataSeries = 'Female'"))).toBe(false);
        for (const topic of topics) {
            expect(resolveTopicSeriesFilter(topic, semantics)).not.toBeNull();
        }
    });
});

describe('buildUniqueSeriesKeys', () => {
    it('numbers repeats that no ancestor path tells apart and avoids existing labels', () => {
        expect(buildUniqueSeriesKeys(['Male', 'Male #1', 'Female', 'Male'], null)).toEqual(['Male #2', 'Male #1', 'Female', 'Male #3']);
    });

    it('uses the shortest ancestor path that separates the repeats', () => {
        const hierarchy = [
            { level: 0, parentIndex: null, rowClass: 'total' as const },
            { level: 1, parentIndex: 0, rowClass: 'subtotal' as const },
            { level: 2, parentIndex: 1, rowClass: 'fact' as const },
            { level: 1, parentIndex: 0, rowClass: 'subtotal' as const },
            { level: 2, parentIndex: 3, rowClass: 'fact' as const },
        ];
        expect(buildUniqueSeriesKeys(['Total', 'North', 'Retail', 'South', 'Retail'], hierarchy))
            .toEqual(['Total', 'North', 'North > Retail', 'South', 'South > Retail']);
    });

    it('leaves the demo series labels unchanged', async () => {
        for (const fileName of ['sg-public-transport-ridership.csv', 'sg-visitor-arrivals.csv', 'sg-business-formation.csv']) {
            const text = fs.readFileSync(path.resolve(process.cwd(), '../demo-data', fileName), 'utf8');
            const { seriesMeasure } = await melt(fileName, text);
            expect(seriesMeasure.series.length).toBeGreaterThan(5);
            expect(seriesMeasure.series.filter(series => series.label !== undefined)).toEqual([]);
        }
    }, 60_000);
});
