import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataPreparationPlan } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { detectFixedWidthLayout } from '../services/data/fixedWidthText';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { robustParseFloat } from '../services/data/dataProfiler';
import { buildCsvDataFromIntakeIr } from '../services/data/reportCsvIntake';
import { resolveReportStructureArtifacts } from '../services/agent/reportStructureState';
import { buildReportContextResolution } from '../services/agent/reportContext';
import { getStructureReviewReasonText, getTranslation } from '../utils/localization';

const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/weird-reports');
const truth = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'truth.json'), 'utf8')) as {
    f7: { rows: number; total_value: number };
};
const w7 = fs.readFileSync(path.join(FIXTURE_DIR, 'w7_fixed_width_text.csv'), 'utf8');
const asCsvFile = (name: string, text: string) =>
    ({ name, size: text.length, text: async () => text }) as unknown as File;
const schemaOnlyPlan: DataPreparationPlan = {
    explanation: 'No reshape is required.',
    operations: [],
    outputColumns: [],
    planStatus: 'schema_only',
    consistencyIssues: [],
};

const HEADER = ['ITEM CODE', 'DESCRIPTION', 'LOCATION', 'ON HAND', 'UNIT COST', 'VALUE'];
const rule = '-'.repeat(60);
const reportLine = (code: string, description: string, location: string, onHand: string, cost: string, value: string) =>
    `${code.padEnd(12)}${description.padEnd(18)}${location.padEnd(12)}${onHand.padStart(10)}${cost.padStart(12)}${value.padStart(14)}`;
const headerLine = reportLine(...(HEADER as [string, string, string, string, string, string]));
const smallReport = (rows: number) => [
    'ACME HOLDINGS            STOCK LISTING',
    rule,
    headerLine,
    rule,
    ...Array.from({ length: rows }, (_, index) =>
        reportLine(`IT${String(index + 1).padStart(4, '0')}`, index % 2 ? 'HEX BOLT M8' : 'WASHER', 'WH-B2', String(100 + index), '12.50', `${(100 + index) * 12}.50`)),
    rule,
    reportLine('TOTAL', '', '', '', '', '99,999.50'),
].join('\n');

describe('w7 fixed-width text report', () => {
    it('is recognised as not delimited and split by column position', () => {
        const { rawRows, detection } = parseCsvTextWithDetection(w7);
        expect(detection.strategy).toBe('fixed_width_layout');
        expect(detection.delimiter).toBeNull();
        expect(detection.confidence).toBe('low');
        expect(detection.warnings.map(warning => warning.code)).toContain('not_delimited_text');

        const headerIndex = rawRows.findIndex(row => row.join('|') === HEADER.join('|'));
        expect(headerIndex).toBeGreaterThan(0);
        expect(rawRows.every(row => row.length === 6 || row.length === 1)).toBe(true);
        // Rules and form-feed page breaks are decoration, not records.
        expect(rawRows.some(row => row.some(cell => /^-{5,}$/.test(cell)))).toBe(false);
        expect(rawRows.some(row => row.some(cell => cell.includes('\f')))).toBe(false);
        // The title line stays one cell instead of being torn across columns.
        expect(rawRows[0]).toEqual(['ACME HOLDINGS SDN BHD STOCK LISTING 30-06-2026', '', '', '', '', '']);

        const detail = rawRows.filter(row => /^IT\d{5}$/.test(row[0]));
        expect(detail).toHaveLength(truth.f7.rows);
        const total = detail.reduce((sum, row) => sum + (robustParseFloat(row[5]) ?? 0), 0);
        expect(Math.round(total * 100) / 100).toBe(truth.f7.total_value);
        expect(rawRows.find(row => row[0] === 'TOTAL VALUE')?.[5]).toBe('156,951,497.67');
        // Repeated page headers are still there for the intake to recognise.
        expect(rawRows.filter(row => row.join('|') === HEADER.join('|')).length).toBeGreaterThan(1);
    });

    it('reaches the intake with the note, a low-confidence flag and a review reason', async () => {
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('w7_fixed_width_text.csv', w7));
        expect(intakeIr.detection?.warnings.map(warning => warning.code)).toContain('not_delimited_text');
        expect(csvData.intakeDetection?.confidence).toBe('low');
        expect(Object.keys(csvData.data[0] ?? {}).length).toBe(6);

        const artifacts = resolveReportStructureArtifacts({
            rawCsvData: buildCsvDataFromIntakeIr(intakeIr),
            csvData,
            rawIntakeIr: intakeIr,
            cleaningRun: null,
            dataPreparationPlan: schemaOnlyPlan,
        });
        expect(artifacts.reportStructureResolution?.blockingReasons[0]).toBe('not_delimited_text');
        expect(artifacts.reportStructureResolution?.requiresHumanReview).toBe(true);
    });

    it('explains itself in all four languages', () => {
        for (const language of ['English', 'Mandarin', 'Japanese', 'Malay']) {
            const reason = getStructureReviewReasonText('not_delimited_text', language);
            expect(reason, language).not.toBe(getStructureReviewReasonText('some_unknown_code', language));
            for (const key of ['data_warnings_intake_not_delimited_split', 'data_warnings_intake_not_delimited_unsplit']) {
                const note = getTranslation(key, language);
                expect(note, `${key} ${language}`).not.toBe(key);
                expect(note.trim(), `${key} ${language}`).not.toBe('');
            }
        }
        expect(getTranslation('data_warnings_intake_not_delimited_split', 'Mandarin')).toContain('文本报表');
        expect(getTranslation('data_warnings_intake_not_delimited_split', 'English'))
            .not.toBe(getTranslation('data_warnings_intake_not_delimited_split', 'Mandarin'));
    });
});

describe('fixed-width detection stays conservative', () => {
    it('splits a small aligned report with one title line and a total', () => {
        const { rawRows, detection } = parseCsvTextWithDetection(smallReport(12));
        expect(detection.strategy).toBe('fixed_width_layout');
        expect(rawRows.filter(row => /^IT\d{4}$/.test(row[0]))).toHaveLength(12);
        expect(rawRows.find(row => row[0] === 'TOTAL')?.[5]).toBe('99,999.50');
    });

    it('reports a header it cannot split reliably as not delimited without guessing columns', () => {
        // Same header, but data that does not line up under it.
        const ragged = [
            headerLine,
            rule,
            ...Array.from({ length: 10 }, (_, index) => `IT${index} ${'x'.repeat(index * 3 + 1)} ${index * 7} some text ${'y'.repeat(index)}`),
        ].join('\n');
        const layout = detectFixedWidthLayout(ragged.split('\n'));
        expect(layout?.kind).toBe('unsplittable');
        const { detection } = parseCsvTextWithDetection(ragged);
        expect(detection.strategy).not.toBe('fixed_width_layout');
        expect(detection.warnings.map(warning => warning.code)).toContain('not_delimited_text');
        expect(detection.confidence).toBe('low');
    });

    it('does not label a delimited CSV that happens to contain a dashed row', () => {
        const csv = ['Name,Amount,Region', ...Array.from({ length: 8 }, (_, index) => `Row ${index},${index * 10},North`), '----------', 'Total,360,'].join('\n');
        const { detection } = parseCsvTextWithDetection(csv);
        expect(detection.delimiter).toBe(',');
        expect(detection.warnings.map(warning => warning.code)).not.toContain('not_delimited_text');
        expect(detectFixedWidthLayout(csv.split('\n'))).toBeNull();
    });

    it('ignores tab-separated text and plain space text without rules', () => {
        expect(detectFixedWidthLayout(['a\tb\tc', rule, '1\t2\t3'])).toBeNull();
        expect(detectFixedWidthLayout(['alpha  beta  gamma', '1      2     3', '4      5     6'])).toBeNull();
    });
});

describe('report title inference', () => {
    it('never uses a line of dashes as the report title', () => {
        const resolution = buildReportContextResolution({
            fileName: 'report.csv',
            data: [{ Item: 'A', Value: '1' }],
            metadataRows: [[rule], ['ACME HOLDINGS STOCK LISTING'], ['=========================']],
        }, null);
        expect(resolution.effective.reportTitle).toBe('ACME HOLDINGS STOCK LISTING');
        expect(resolution.effective.parameterLines.some(line => /^[-=\s]+$/.test(line))).toBe(false);
    });

    it('has no title rather than a rule when only decoration precedes the table', () => {
        const resolution = buildReportContextResolution({
            fileName: 'report.csv',
            data: [{ Item: 'A', Value: '1' }],
            metadataRows: [[rule]],
        }, null);
        expect(resolution.effective.reportTitle ?? '').not.toMatch(/^-+$/);
    });
});
