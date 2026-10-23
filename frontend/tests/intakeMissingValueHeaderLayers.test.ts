import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataPreparationPlan } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import {
    buildCsvDataFromIntakeIr,
    buildReportIntakeIr,
    validateAiBoundary,
} from '../services/data/reportCsvIntake';
import { detectReportShape } from '../services/agent/reportShapeDetector';
import { resolveReportStructureArtifacts } from '../services/agent/reportStructureState';

const RENT_CSV_PATH = path.resolve(process.cwd(), '../demo-data/sg-hdb-median-rent.csv');
const schemaOnlyPlan: DataPreparationPlan = {
    explanation: 'No reshape is required for a row-oriented table.',
    operations: [],
    outputColumns: [],
    planStatus: 'schema_only',
    consistencyIssues: [],
};

// processCsvWithIntakeIr only needs text(); jsdom's File lacks it.
const asCsvFile = (name: string, text: string) =>
    ({ name, size: text.length, text: async () => text }) as unknown as File;

const intakeFromText = (name: string, text: string) => {
    const { rawRows, detection } = parseCsvTextWithDetection(text);
    const intakeIr = buildReportIntakeIr(name, rawRows, detection);
    return { intakeIr, csvData: buildCsvDataFromIntakeIr(intakeIr) };
};

describe('header-layer detection with missing-value markers in the first body rows', () => {
    it('keeps the single header of the first 50 lines of the HDB median rent demo file', async () => {
        const text = fs.readFileSync(RENT_CSV_PATH, 'utf8').split('\n').slice(0, 50).join('\n');
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('sg-hdb-median-rent.csv', text));

        expect(intakeIr.provisionalTable?.headerRowIndex).toBe(0);
        expect(intakeIr.provisionalTable?.headerLayerRowIndexes).toEqual([]);
        expect(intakeIr.provisionalTable?.bodyStartIndex).toBe(1);
        expect(csvData.headerDepth).toBe(1);
        expect(csvData.headerLayers).toEqual([]);
        expect(Object.keys(csvData.data[0] ?? {})).toEqual(['quarter', 'town', 'flat_type', 'median_rent']);
        expect(csvData.data).toHaveLength(49);
        expect(csvData.data[0]).toEqual({ quarter: '2011-Q2', town: 'ANG MO KIO', flat_type: '1-RM', median_rent: 'na' });
        expect(csvData.data[1]?.median_rent).toBe('-');
    });

    it('imports all 9,507 rent rows as an auto-analyzable row table', async () => {
        const text = fs.readFileSync(RENT_CSV_PATH, 'utf8');
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('sg-hdb-median-rent.csv', text));
        const rawCsvData = buildCsvDataFromIntakeIr(intakeIr);
        const artifacts = resolveReportStructureArtifacts({
            rawCsvData,
            csvData,
            rawIntakeIr: intakeIr,
            cleaningRun: null,
            dataPreparationPlan: schemaOnlyPlan,
        });

        expect(csvData.data).toHaveLength(9507);
        expect(csvData.headerDepth).toBe(1);
        // Rows whose median is "na" or "-" are records with a missing value,
        // not hierarchy headings.
        expect(detectReportShape(rawCsvData).primaryKind).toBe('already_tabular');
        expect(artifacts.reportStructureResolution?.headerLayerRowIndexes).toEqual([]);
        expect(artifacts.reportStructureResolution?.requiresHumanReview).toBe(false);
        expect(artifacts.pipelineOutcome?.canAutoAnalyze).toBe(true);
    }, 30_000);

    it.each([
        ['na and dash', 'na', '-'],
        ['n.a. and empty', 'n.a.', ''],
        ['empty and n/a', '', 'n/a'],
    ])('does not eat leading body rows with %s measures', (_label, firstMeasure, secondMeasure) => {
        const text = [
            'quarter,town,flat_type,median_rent',
            `2015-Q1,BEDOK,1-RM,${firstMeasure}`,
            `2015-Q1,BEDOK,2-RM,${secondMeasure}`,
            '2015-Q1,BEDOK,3-RM,1700',
            '2015-Q1,BEDOK,4-RM,2100',
            '2015-Q1,BEDOK,5-RM,2400',
            '2015-Q1,BISHAN,3-RM,1900',
        ].join('\n');
        const { intakeIr, csvData } = intakeFromText('rent.csv', text);

        expect(intakeIr.provisionalTable?.headerRowIndex).toBe(0);
        expect(intakeIr.provisionalTable?.headerLayerRowIndexes).toEqual([]);
        expect(intakeIr.provisionalTable?.metadataRowIndexes).toEqual([]);
        expect(csvData.data).toHaveLength(6);
        expect(Object.keys(csvData.data[0] ?? {})).toEqual(['quarter', 'town', 'flat_type', 'median_rent']);
        expect(csvData.data[0]?.median_rent).toBe(firstMeasure);
    });

    it('does not eat a leading row with a different key when its measure is a missing marker', () => {
        const text = [
            'region,product,channel,sales',
            'North,Widget,Online,na',
            'South,Gadget,Retail,120',
            'East,Gizmo,Online,95',
            'West,Widget,Retail,130',
        ].join('\n');
        const { intakeIr, csvData } = intakeFromText('sales.csv', text);

        expect(intakeIr.provisionalTable?.headerLayerRowIndexes).toEqual([]);
        expect(csvData.data).toHaveLength(4);
        expect(csvData.data[0]?.region).toBe('North');
    });

    it('still keeps a year band layer above a body whose first measures are dashes', () => {
        const years = ['2021', '2022', '2023'];
        const text = [
            ['Code', 'Description', ...years.flatMap(year => [year, ''])],
            ['', '', ...years.flatMap(() => ['Sales', 'Cost'])],
            ['ITEM-0', 'Item 0', '-', '-', '10', '5', '12', '6'],
            ...Array.from({ length: 4 }, (_, index) => [
                `ITEM-${index + 1}`, `Item ${index + 1}`, ...years.flatMap(() => ['10', '5']),
            ]),
        ].map(row => row.join(',')).join('\n');
        const { intakeIr, csvData } = intakeFromText('annual.csv', text);

        expect(intakeIr.provisionalTable?.headerRowIndex).toBe(1);
        expect(intakeIr.provisionalTable?.headerLayerRowIndexes).toEqual([0]);
        expect(intakeIr.provisionalTable?.bodyStartIndex).toBe(2);
        expect(csvData.headerDepth).toBe(2);
        expect(csvData.data).toHaveLength(5);
    });

    it('rejects an AI boundary that turns leading body rows into header layers', () => {
        const rows = [
            ['quarter', 'town', 'flat_type', 'median_rent'],
            ['2011-Q2', 'ANG MO KIO', '1-RM', 'na'],
            ['2011-Q2', 'ANG MO KIO', '2-RM', '-'],
            ['2011-Q2', 'ANG MO KIO', '3-RM', '1730'],
            ['2011-Q2', 'ANG MO KIO', '4-RM', '2200'],
            ['2011-Q2', 'ANG MO KIO', '5-RM', '2500'],
        ];

        const eaten = validateAiBoundary({
            headerRowIndex: 2,
            headerLayerIndexes: [0, 1],
            bodyStartIndex: 3,
            summaryStartIndex: rows.length,
        }, rows);
        const clean = validateAiBoundary({
            headerRowIndex: 0,
            headerLayerIndexes: [],
            bodyStartIndex: 1,
            summaryStartIndex: rows.length,
        }, rows);

        expect(eaten.valid).toBe(false);
        expect(eaten.rejectionReason).toContain('continues the data pattern');
        expect(clean).toEqual({ valid: true, rejectionReason: null });
    });
});
