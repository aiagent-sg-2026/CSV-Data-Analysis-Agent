import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataPreparationPlan } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr, buildCsvDataFromRawRows } from '../services/data/reportCsvIntake';
import { detectReportShape } from '../services/agent/reportShapeDetector';
import { resolveReportStructureArtifacts } from '../services/agent/reportStructureState';

const COE_CSV_PATH = path.resolve(process.cwd(), '../demo-data/sg-coe-bidding.csv');
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

describe('CSV quote dialect beyond the detection sample', () => {
    it('parses the COE demo file with its late quoted thousands intact', async () => {
        const text = fs.readFileSync(COE_CSV_PATH, 'utf8');
        const lines = text.split('\n');
        // Guard the fixture assumption: the first quote sits far past the sample.
        expect(lines.findIndex(line => line.includes('"'))).toBe(1579);

        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('sg-coe-bidding.csv', text));
        const columns = Object.keys(csvData.data[0] ?? {});

        expect(intakeIr.detection?.quoteChar).toBe('"');
        expect(columns).toEqual(['month', 'bidding_no', 'vehicle_class', 'quota', 'bids_success', 'bids_received', 'premium']);
        expect(csvData.data).toHaveLength(1990);
        // Line 1580 of the file is data row 1579 (zero-based, after the header).
        expect(csvData.data[1578]).toEqual({
            month: '2023-05',
            bidding_no: '2',
            vehicle_class: 'Category D',
            quota: '571',
            bids_success: '562',
            bids_received: '1,438',
            premium: '10602',
        });
        expect(csvData.data.every(row => Object.keys(row).length === 7)).toBe(true);

        const rawCsvData = buildCsvDataFromIntakeIr(intakeIr);
        const artifacts = resolveReportStructureArtifacts({
            rawCsvData,
            csvData,
            rawIntakeIr: intakeIr,
            cleaningRun: null,
            dataPreparationPlan: schemaOnlyPlan,
        });
        expect(detectReportShape(rawCsvData).primaryKind).toBe('already_tabular');
        expect(artifacts.reportStructureResolution?.requiresHumanReview).toBe(false);
        expect(artifacts.pipelineOutcome?.canAutoAnalyze).toBe(true);
    }, 30_000);

    it('keeps a quoted field intact when the first quote appears after line 200', () => {
        const lines = [
            'id,label,amount',
            ...Array.from({ length: 249 }, (_, index) => `${index + 1},item ${index + 1},${100 + index}`),
            '250,"Widget, large","1,250"',
            '251,item 251,351',
        ];
        const parsed = parseCsvTextWithDetection(lines.join('\n'));

        expect(parsed.detection.quoteChar).toBe('"');
        expect(parsed.rawRows.every(row => row.length === 3)).toBe(true);
        expect(parsed.rawRows[250]).toEqual(['250', 'Widget, large', '1,250']);
        expect(parsed.rawRows[251]).toEqual(['251', 'item 251', '351']);
    });
});

describe('in-body header scan after a clean single-header parse', () => {
    it('does not promote a code-like data row to a header', () => {
        const header = ['month', 'round', 'class', 'quota', 'successful', 'received', 'premium'];
        const classes = ['Category A', 'Category B', 'Category C', 'Category D', 'Category E'];
        const rows = Array.from({ length: 40 }, (_, index) => {
            const month = `20${String(10 + Math.floor(index / 10)).padStart(2, '0')}-${String((index % 10) + 1).padStart(2, '0')}`;
            return [
                month,
                String((index % 2) + 1),
                classes[index % classes.length]!,
                String(1000 + index * 7),
                String(990 + index * 7),
                String(14380 + index * 13),
                String(102000 + index * 101),
            ];
        });
        const text = [header, ...rows].map(row => row.join(',')).join('\n');
        const { rawRows, detection } = parseCsvTextWithDetection(text);
        const csvData = buildCsvDataFromRawRows('coe-like.csv', rawRows, detection);

        expect(detection.confidence).toBe('high');
        expect(csvData.headerDepth).toBe(1);
        const shape = detectReportShape(csvData);
        expect(shape.primaryKind).toBe('already_tabular');
        expect(shape.headerBands.filter(band => band.role === 'column_header')).toEqual([]);
    });
});
