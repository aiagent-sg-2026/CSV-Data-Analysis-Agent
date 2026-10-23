import { describe, expect, it } from 'vitest';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { resolveReportStructureArtifacts } from '../services/agent/reportStructureState';
import {
    detectPeriodWideTable,
    parsePeriodHeaderLabel,
    resolvePeriodWideHierarchy,
} from '../services/agent/reportShapePeriodWide';

const schemaOnlyPlan = {
    explanation: 'Import keeps the source rows unchanged.',
    operations: [],
    outputColumns: [],
    planStatus: 'schema_only' as const,
    consistencyIssues: [],
};

const resolveFromText = (name: string, text: string) => {
    const { rawRows, detection } = parseCsvTextWithDetection(text);
    const intakeIr = buildReportIntakeIr(name, rawRows, detection);
    const csvData = buildCsvDataFromIntakeIr(intakeIr);
    return resolveReportStructureArtifacts({
        rawCsvData: buildCsvDataFromIntakeIr(intakeIr),
        csvData,
        rawIntakeIr: intakeIr,
        cleaningRun: null,
        dataPreparationPlan: schemaOnlyPlan,
    });
};

const split = (lines: string[]) => lines.map(line => line.split(','));

describe('parsePeriodHeaderLabel', () => {
    it.each([
        ['2025', 'year', '2025-01-01'],
        ['2026Aug', 'month', '2026-08-01'],
        ['2026 Sept', 'month', '2026-09-01'],
        ['Aug 2026', 'month', '2026-08-01'],
        ['2026-08', 'month', '2026-08-01'],
        ['2026M08', 'month', '2026-08-01'],
        ['2024Q1', 'quarter', '2024-01-01'],
        ['2024 Q3', 'quarter', '2024-07-01'],
        ['Q4 2024', 'quarter', '2024-10-01'],
    ])('parses %s', (label, grain, start) => {
        expect(parsePeriodHeaderLabel(label)).toEqual({ grain, start });
    });

    it.each(['1850', '202601', 'FY2024', 'Total', '2024 Sales', '2026Foo', 'Jan', 'DataSeries', '2024Q5'])(
        'rejects %s',
        label => expect(parsePeriodHeaderLabel(label)).toBeNull(),
    );
});

describe('detectPeriodWideTable', () => {
    const header = 'Series,2025,2024,2023,2022';

    it('recognizes a year-header table with missing markers', () => {
        const [headers, ...body] = split([header, 'Alpha,1,2,na,4', 'Beta,5,-,7,8']);
        expect(detectPeriodWideTable(headers, body)).toMatchObject({
            labelColumns: ['Series'],
            grain: 'year',
            periodColumns: [
                { column: '2022' }, { column: '2023' }, { column: '2024' }, { column: '2025' },
            ],
        });
    });

    it.each([
        ['a free-text cell in a period column', [header, 'Alpha,1,2,see note,4', 'Beta,5,6,7,8']],
        ['fewer than four periods', ['Series,2025,2024,2023', 'Alpha,1,2,3', 'Beta,4,5,6']],
        ['mixed period grains', ['Series,2025,2025Jan,2025Feb,2025Mar', 'Alpha,1,2,3,4']],
        ['a numeric label column', ['Code,2025,2024,2023,2022', '501001,1,2,3,4', '501002,5,6,7,8']],
        ['a measure column beside the periods', ['Region,2025,2024,2023,2022,Total', 'North,1,2,3,4,10', 'South,5,6,7,8,26']],
        ['duplicate periods', ['Series,2025,2025 ,2024,2023,2022', 'Alpha,1,2,3,4,5']],
        ['an empty header', ['Series,2025,2024,2023,2022,', 'Alpha,1,2,3,4,x']],
    ])('rejects a table with %s', (_label, lines) => {
        const [headers, ...body] = split(lines);
        expect(detectPeriodWideTable(headers, body)).toBeNull();
    });
});

describe('resolvePeriodWideHierarchy', () => {
    it('assigns levels, parents and parent classes from indentation', () => {
        expect(resolvePeriodWideHierarchy(['Total', '  Region A', '    City 1', '    City 2', '  Region B'])).toEqual([
            { level: 0, parentIndex: null, rowClass: 'total' },
            { level: 1, parentIndex: 0, rowClass: 'subtotal' },
            { level: 2, parentIndex: 1, rowClass: 'fact' },
            { level: 2, parentIndex: 1, rowClass: 'fact' },
            { level: 1, parentIndex: 0, rowClass: 'fact' },
        ]);
    });

    it('ignores indentation that has no parent above it', () => {
        expect(resolvePeriodWideHierarchy(['  Child', 'Parent', '  Child 2'])).toBeNull();
    });

    it('flags an unindented total row and leaves plain series unflagged', () => {
        expect(resolvePeriodWideHierarchy(['North', 'South', 'Total'])?.map(entry => entry.rowClass)).toEqual(['fact', 'fact', 'total']);
        expect(resolvePeriodWideHierarchy(['North', 'South'])).toBeNull();
    });
});

describe('period-header wide tables in structure resolution', () => {
    it('melts a clean year-header table without review', () => {
        const artifacts = resolveFromText('ridership.csv', [
            'DataSeries,2025,2024,2023,2022,2021',
            'Rail Length,271.3,271.3,258.5,258.5,245.3',
            '    MRT,242.5,242.5,229.7,229.7,216.5',
            '    LRT,28.8,28.8,28.8,28.8,28.8',
            'Bus Ridership,3841,3837,na,3600,3500',
        ].join('\n'));

        expect(artifacts.reportStructureResolution?.requiresHumanReview).toBe(false);
        expect(artifacts.pipelineOutcome?.status).toBe('ready');
        expect(artifacts.canonicalCsvData?.data).toHaveLength(20);
        expect(artifacts.canonicalCsvData?.data.filter(row => row.Value === null)).toHaveLength(1);
    });

    it('keeps a year-header table with an unexplained text cell in structure review', () => {
        const artifacts = resolveFromText('ridership-with-note.csv', [
            'DataSeries,2025,2024,2023,2022,2021',
            'Rail Length,271.3,271.3,258.5,258.5,245.3',
            'MRT km Operated,47623,see footnote,43579,41000,40000',
            'Bus Ridership,3841,3837,3700,3600,3500',
            'LRT km Operated,7717,7257,7104,7000,6900',
        ].join('\n'));

        expect(artifacts.reportStructureResolution?.requiresHumanReview).toBe(true);
        expect(artifacts.reportStructureResolution?.blockingReasons.length).toBeGreaterThan(0);
        expect(artifacts.pipelineOutcome?.canAutoAnalyze).toBe(false);
        expect(artifacts.canonicalCsvData).toBeNull();
    });
});
