import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataPreparationPlan, ReportStructureResolution } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { resolveReportStructureArtifacts } from '../services/agent/reportStructureState';
import { isNumericLike } from '../services/agent/reportShapeUtils';

// Header and boundary detection on the synthetic weird-format reports in
// tests/fixtures/weird-reports (see its README.md and truth.json).
const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/weird-reports');
const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
const truth = JSON.parse(readFixture('truth.json')) as {
    f3: { sales: number; rows: number[] };
    f5: { rows: number };
    f6: { rows: number };
    f7: { rows: number; total_value: number };
};

const schemaOnlyPlan: DataPreparationPlan = {
    explanation: 'Import keeps the source rows unchanged.',
    operations: [],
    outputColumns: [],
    planStatus: 'schema_only',
    consistencyIssues: [],
};

const asCsvFile = (name: string, text: string) =>
    ({ name, size: text.length, text: async () => text }) as unknown as File;

const intakeFromText = (name: string, text: string) => {
    const { rawRows, detection } = parseCsvTextWithDetection(text);
    const intakeIr = buildReportIntakeIr(name, rawRows, detection);
    return { intakeIr, csvData: buildCsvDataFromIntakeIr(intakeIr) };
};

const resolve = (intake: ReturnType<typeof intakeFromText>, confirm = false) => {
    const params = {
        rawCsvData: intake.csvData,
        csvData: intake.csvData,
        rawIntakeIr: intake.intakeIr,
        cleaningRun: null,
        dataPreparationPlan: schemaOnlyPlan,
    };
    const first = resolveReportStructureArtifacts(params);
    if (!confirm) return first;
    const r = first.reportStructureResolution as ReportStructureResolution;
    return resolveReportStructureArtifacts({
        ...params,
        humanBoundary: {
            headerRowIndex: r.headerRowIndex,
            headerLayerRowIndexes: [...r.headerLayerRowIndexes],
            bodyStartIndex: r.bodyStartIndex,
            summaryStartIndex: r.summaryStartIndex,
            parameterRowIndexes: [...r.parameterRowIndexes],
            repeatedHeaderRowIndexes: [...r.repeatedHeaderRowIndexes],
        },
    });
};

const columnsOf = (data: { data: Array<Record<string, unknown>> }) => Object.keys(data.data[0] ?? {});

describe('leading report-parameter block (w5)', () => {
    it('finds the real header below 38 key/value metadata lines', async () => {
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('w5.csv', readFixture('w5_aging_meta_footnotes.csv')));
        const table = intakeIr.provisionalTable!;

        expect(table.headerRowIndex).toBe(39);
        expect(table.headerLayerRowIndexes).toEqual([]);
        expect(table.bodyStartIndex).toBe(40);
        expect(columnsOf(csvData)).toEqual(['Customer', 'Invoice', 'Current', '1-30', '31-60', '61-90', '90+', 'Balance']);
        expect(csvData.metadataRows).toHaveLength(38);
        expect(csvData.metadataRows?.[0]).toEqual(expect.arrayContaining(['Report Name', 'AR Aging Analysis']));
        // Page-break lines inside the body belong to body-noise handling; the
        // invoice records themselves must all be present and nothing else may
        // look like one.
        expect(csvData.data.filter(row => /^IN\d+$/.test(String(row.Invoice)))).toHaveLength(truth.f5.rows);
        // TOTAL and the footnotes end the table instead of being data.
        const tail = (csvData.summaryRows ?? []).map(row => Object.values(row).join('|'));
        expect(tail.some(line => line.startsWith('TOTAL'))).toBe(true);
        expect(tail.some(line => line.includes('Subject to credit review'))).toBe(true);
        expect(csvData.data.some(row => String(row.Customer).startsWith('TOTAL'))).toBe(false);
    });

    const buildReport = (parameterLines: number, withTotal = true) => [
        ...Array.from({ length: parameterLines }, (_, index) => `Parameter ${index + 1},Value ${index + 1}`),
        '',
        'Customer,Invoice,Current,1-30,Balance',
        ...Array.from({ length: 30 }, (_, index) => `CUST ${index % 5},IN${String(index + 1).padStart(5, '0')},${100 + index},${index},${100 + 2 * index}`),
        ...(withTotal ? ['TOTAL,,,,9999', '', '* Estimated amount'] : []),
    ].join('\n');

    it.each([5, 17, 60])('skips a %i-line key/value block before the header', parameterLines => {
        const intake = intakeFromText('aging.csv', buildReport(parameterLines));

        expect(intake.intakeIr.provisionalTable?.headerRowIndex).toBe(parameterLines + 1);
        expect(columnsOf(intake.csvData)).toEqual(['Customer', 'Invoice', 'Current', '1-30', 'Balance']);
        expect(intake.csvData.data).toHaveLength(30);
        expect(intake.csvData.metadataRows).toHaveLength(parameterLines);
    });

    it('resolves the report without review once the header is found', () => {
        const artifacts = resolve(intakeFromText('aging.csv', buildReport(40)));

        expect(artifacts.reportStructureResolution?.requiresHumanReview).toBe(false);
        expect(artifacts.canonicalizationStatus).toBe('ready');
        expect(artifacts.canonicalCsvData?.data).toHaveLength(30);
        expect(artifacts.pipelineOutcome?.canAutoAnalyze).toBe(true);
    });

    it('does not change a flat CSV that has no preamble', () => {
        const text = ['id,name,qty,price', ...Array.from({ length: 20 }, (_, index) => `${index},item ${index},${index + 1},${index * 2}.5`)].join('\n');
        const intake = intakeFromText('flat.csv', text);

        expect(intake.intakeIr.provisionalTable?.headerRowIndex).toBe(0);
        expect(intake.csvData.metadataRows).toEqual([]);
        expect(intake.csvData.data).toHaveLength(20);
    });
});

describe('stacked tables in one file (w3)', () => {
    it('analyses the first table and sets the other two aside', async () => {
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('w3.csv', readFixture('w3_three_sections.csv')));

        expect(columnsOf(csvData)).toEqual(['Invoice No', 'Date', 'Customer', 'Amount', 'Tax']);
        expect(csvData.data).toHaveLength(truth.f3.rows[0]);
        expect(csvData.data.every(row => /^INV\d+$/.test(String(row['Invoice No'])))).toBe(true);
        const sales = csvData.data.reduce((sum, row) => sum + Number(row.Amount), 0);
        expect(sales).toBeCloseTo(truth.f3.sales, 2);
        // The other sections are neither data nor summary rows of this table.
        expect(csvData.summaryRows).toEqual([]);

        const sections = intakeIr.diagnostics.setAsideSections!;
        expect(sections.map(section => section.title)).toEqual(['SECTION B: CREDIT NOTES', 'SECTION C: PAYMENTS RECEIVED']);
        expect(sections.map(section => section.rowCount)).toEqual(truth.f3.rows.slice(1));
        expect(sections[0].headerLabels).toEqual(['CN No', 'Original Invoice', 'Reason', 'Credit Amount']);
        expect(sections[1].headerLabels).toEqual(['Receipt', 'Paid On', 'Method', 'Customer', 'Paid']);

        const note = csvData.intakeDetection?.warnings.find(warning => warning.code === 'stacked_sections');
        expect(note?.message).toContain('stacks 3 different tables');
        expect(note?.message).toContain('SECTION B: CREDIT NOTES');
        expect(note?.message).toContain('SECTION C: PAYMENTS RECEIVED');
    });

    it('asks for review with a plain reason, then proceeds on the first table only', async () => {
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('w3.csv', readFixture('w3_three_sections.csv')));
        const intake = { intakeIr, csvData };

        const pending = resolve(intake);
        expect(pending.reportStructureResolution?.blockingReasons).toEqual(['stacked_sections_set_aside']);
        expect(pending.pipelineOutcome).toMatchObject({ status: 'needs_structure_review', canAutoAnalyze: false });

        const confirmed = resolve(intake, true);
        expect(confirmed.pipelineOutcome?.canAutoAnalyze).toBe(true);
        expect(confirmed.canonicalCsvData?.data).toHaveLength(truth.f3.rows[0]);
        expect(confirmed.canonicalCsvData?.data.every(row => /^INV\d+$/.test(String(row['Invoice No'])))).toBe(true);
    });

    const twoTables = (second: string[]) => [
        'Region,Product,Units,Revenue',
        ...Array.from({ length: 10 }, (_, index) => `R${index},P${index},${index + 1},${(index + 1) * 10}.5`),
        '',
        ...second,
    ].join('\n');

    it('sets aside a second table that has a title and a different header', () => {
        const { intakeIr, csvData } = intakeFromText('two.csv', twoTables([
            'Targets by owner',
            'Owner,Quarter,Target,Stretch',
            ...Array.from({ length: 6 }, (_, index) => `O${index},Q${(index % 4) + 1},${index * 100}.5,${index * 150}.5`),
        ]));

        expect(csvData.data).toHaveLength(10);
        expect(columnsOf(csvData)).toEqual(['Region', 'Product', 'Units', 'Revenue']);
        expect(intakeIr.diagnostics.setAsideSections).toHaveLength(1);
        expect(intakeIr.diagnostics.setAsideSections?.[0]).toMatchObject({ title: 'Targets by owner', rowCount: 6 });
    });

    it('does not treat a repeated page header with a "Continued..." line as a new table', () => {
        const { intakeIr, csvData } = intakeFromText('paged.csv', twoTables([
            'Continued...',
            'Region,Product,Units,Revenue',
            ...Array.from({ length: 6 }, (_, index) => `R${index + 10},P${index + 10},${index + 1},${(index + 1) * 10}.5`),
        ]));

        expect(intakeIr.diagnostics.setAsideSections ?? []).toEqual([]);
        expect(csvData.data.filter(row => /^R\d+$/.test(String(row.Region)))).toHaveLength(16);
    });

    it('does not treat a group heading that is followed by data as a new table', () => {
        const { intakeIr } = intakeFromText('groups.csv', twoTables([
            'North',
            ...Array.from({ length: 4 }, (_, index) => `N${index},PN${index},${index + 1},${(index + 1) * 10}.5`),
        ]));

        expect(intakeIr.diagnostics.setAsideSections ?? []).toEqual([]);
    });
});

describe('grouped two-row header (w6)', () => {
    it('joins the group layer into the names and keeps the label-only names', async () => {
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('w6.csv', readFixture('w6_grouped_header_carryforward.csv')));
        const table = intakeIr.provisionalTable!;

        expect(table.headerRowIndex).toBe(1);
        expect(table.headerLayerRowIndexes).toEqual([0]);
        expect(table.bodyStartIndex).toBe(2);
        expect(csvData.metadataRows).toEqual([]);
        expect(columnsOf(csvData)).toEqual([
            'Category', 'Product',
            'FY2025 :: Q1', 'FY2025 :: Q2', 'FY2025 :: Q3', 'FY2025 :: Q4',
            'FY2026 :: Q1', 'FY2026 :: Q2', 'FY2026 :: Q3',
        ]);
        expect(columnsOf(csvData).some(name => name.startsWith('_unnamed_column_'))).toBe(false);
        expect(csvData.data).toHaveLength(truth.f6.rows);
        expect(csvData.data[0]).toEqual({
            Category: 'Fasteners', Product: 'FAS-0001',
            'FY2025 :: Q1': '$9,499', 'FY2025 :: Q2': '-', 'FY2025 :: Q3': '$6,571', 'FY2025 :: Q4': '14115',
            'FY2026 :: Q1': '$13,604', 'FY2026 :: Q2': '$4,891', 'FY2026 :: Q3': '$16,748',
        });
        // The category is printed only on the first row of its group.
        expect(csvData.data[1]).toMatchObject({ Category: '', Product: 'FAS-0002', 'FY2025 :: Q1': '$4,022', 'FY2025 :: Q2': '10843' });
    });

    it('keeps every row, with the group label filled, once the layered header is confirmed', async () => {
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('w6.csv', readFixture('w6_grouped_header_carryforward.csv')));
        const confirmed = resolve({ intakeIr, csvData }, true);
        const rows = confirmed.canonicalCsvData!.data;

        expect(confirmed.pipelineOutcome?.canAutoAnalyze).toBe(true);
        // Seven period columns per product; rows with only "$" or "-" cells stay.
        expect(rows).toHaveLength(truth.f6.rows * 7);
        expect(new Set(rows.map(row => row.SeriesLabelL1))).toEqual(new Set(['FY2025', 'FY2026']));
    });

    it('keeps a group layer that has only two group labels and nothing in the first columns', () => {
        const text = [
            ',,FY2025,,,FY2026,,',
            'Region,Product,Q1,Q2,Q3,Q1,Q2',
            ...Array.from({ length: 12 }, (_, index) => `R${index % 3},P${index},${index + 1}0,${index + 2}0,${index + 3}0,${index + 4}0,${index + 5}0`),
        ].join('\n');
        const { intakeIr, csvData } = intakeFromText('two-groups.csv', text);

        expect(intakeIr.provisionalTable?.headerLayerRowIndexes).toEqual([0]);
        expect(columnsOf(csvData)).toEqual(['Region', 'Product', 'FY2025 :: Q1', 'FY2025 :: Q2', 'FY2025 :: Q3', 'FY2026 :: Q1', 'FY2026 :: Q2']);
        expect(csvData.data).toHaveLength(12);
    });

    it('keeps the names of label-only columns that sit beside a single group', () => {
        const text = [
            'Region,Product,FY2025,,,',
            ',,Q1,Q2,Q3,Q4',
            ...Array.from({ length: 12 }, (_, index) => `R${index % 3},P${index},${index + 1}0,${index + 2}0,${index + 3}0,${index + 4}0`),
        ].join('\n');
        const { intakeIr, csvData } = intakeFromText('one-group.csv', text);

        expect(intakeIr.provisionalTable?.headerLayerRowIndexes).toEqual([0]);
        expect(columnsOf(csvData).slice(0, 3)).toEqual(['Region', 'Product', 'FY2025 :: Q1']);
        expect(columnsOf(csvData).some(name => name.startsWith('_unnamed_column_'))).toBe(false);
    });

    it('does not take a key/value metadata row above a plain header for a group layer', () => {
        const text = [
            'Company,ACME HOLDINGS,As At,30-06-2026',
            'Customer,Invoice,Qty,Amount,Balance',
            ...Array.from({ length: 12 }, (_, index) => `CUST ${index},IN${String(index).padStart(5, '0')},${index + 1},${index * 10}.5,${index * 11}.5`),
        ].join('\n');
        const { intakeIr, csvData } = intakeFromText('meta.csv', text);

        expect(intakeIr.provisionalTable?.headerRowIndex).toBe(1);
        expect(intakeIr.provisionalTable?.headerLayerRowIndexes).toEqual([]);
        expect(csvData.metadataRows).toHaveLength(1);
        expect(columnsOf(csvData)).toEqual(['Customer', 'Invoice', 'Qty', 'Amount', 'Balance']);
    });

    it('reads a currency-formatted number as numeric', () => {
        expect(isNumericLike('$9,499')).toBe(true);
        expect(isNumericLike('-$12.50')).toBe(true);
        expect(isNumericLike('$')).toBe(false);
        expect(isNumericLike('$abc')).toBe(false);
    });
});

describe('space-aligned text report with an all-caps header (w7)', () => {
    const sumValue = (rows: Array<Record<string, unknown>>) =>
        rows.reduce((sum, row) => sum + Number(String(row.VALUE).replace(/,/g, '')), 0);

    it('takes the label line above the rule as the header and the title as metadata', async () => {
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('w7.csv', readFixture('w7_fixed_width_text.csv')));
        const table = intakeIr.provisionalTable!;

        expect(csvData.intakeDetection?.strategy).toBe('fixed_width_layout');
        expect(table.headerRowIndex).toBe(1);
        expect(table.bodyStartIndex).toBe(2);
        expect(columnsOf(csvData)).toEqual(['ITEM CODE', 'DESCRIPTION', 'LOCATION', 'ON HAND', 'UNIT COST', 'VALUE']);
        expect(csvData.metadataRows).toHaveLength(1);
        expect(csvData.metadataRows?.[0][0]).toContain('STOCK LISTING');
        expect(csvData.data).toHaveLength(truth.f7.rows);
        // Page-break repeats of the header and the TOTAL line are not records.
        expect(csvData.data.some(row => row['ITEM CODE'] === 'ITEM CODE')).toBe(false);
        expect(csvData.data.every(row => /^IT\d+$/.test(String(row['ITEM CODE'])))).toBe(true);
        expect(sumValue(csvData.data)).toBeCloseTo(truth.f7.total_value, 2);
        expect((csvData.summaryRows ?? []).map(row => Object.values(row).join('|')).some(line => line.startsWith('TOTAL VALUE'))).toBe(true);
    });

    it('keeps the not-delimited review reason and analyses the same rows once confirmed', async () => {
        const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile('w7.csv', readFixture('w7_fixed_width_text.csv')));
        const intake = { intakeIr, csvData };

        const pending = resolve(intake);
        expect(pending.reportStructureResolution?.blockingReasons[0]).toBe('not_delimited_text');
        expect(pending.pipelineOutcome?.reasonCode).toBe('not_delimited_text');

        const confirmed = resolve(intake, true);
        expect(confirmed.pipelineOutcome?.canAutoAnalyze).toBe(true);
        expect(confirmed.canonicalCsvData?.data).toHaveLength(truth.f7.rows);
        expect(sumValue(confirmed.canonicalCsvData!.data)).toBeCloseTo(truth.f7.total_value, 2);
    });

    const report = [
        'ACME HOLDINGS SDN BHD,STOCK LISTING,30-06-2026',
        'ITEM CODE,DESCRIPTION,LOCATION,ON HAND,UNIT COST,VALUE',
        ...Array.from({ length: 8 }, (_, index) => `IT${String(index + 1).padStart(5, '0')},BOLT ${index},WH-A1,${index + 10},2.50,${(index + 10) * 2.5}`),
        'ITEM CODE,DESCRIPTION,LOCATION,ON HAND,UNIT COST,VALUE',
        ...Array.from({ length: 8 }, (_, index) => `IT${String(index + 9).padStart(5, '0')},NUT ${index},WH-B2,${index + 20},3.00,${(index + 20) * 3}`),
        'TOTAL VALUE,,,,,999',
    ].join('\n');

    it('finds an all-caps header that sits directly above the records', () => {
        const { intakeIr, csvData } = intakeFromText('stock.csv', report);

        expect(intakeIr.provisionalTable?.headerRowIndex).toBe(1);
        expect(columnsOf(csvData)).toEqual(['ITEM CODE', 'DESCRIPTION', 'LOCATION', 'ON HAND', 'UNIT COST', 'VALUE']);
        expect(csvData.metadataRows).toHaveLength(1);
        expect(csvData.data.filter(row => /^IT\d+$/.test(String(row['ITEM CODE'])))).toHaveLength(16);
    });

    it('does not take a metadata pair row that is followed by a header for the header', () => {
        const text = [
            'CURRENCY,MYR,AS AT,DATEHERE',
            'ITEM CODE,DESCRIPTION,LOCATION,ON HAND,VALUE',
            ...Array.from({ length: 8 }, (_, index) => `IT${String(index + 1).padStart(5, '0')},BOLT ${index},WH-A1,${index + 10},${(index + 10) * 2.5}`),
        ].join('\n');
        const { intakeIr } = intakeFromText('meta.csv', text);

        expect(intakeIr.provisionalTable?.headerRowIndex).toBe(1);
    });
});
