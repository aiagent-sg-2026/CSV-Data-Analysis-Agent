import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CsvData, CsvRow, ReportStructureResolution } from '../types';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { resolveReportStructureArtifactsWithProposal } from '../services/agent/orchestration/reportStructureOrchestrator';
import { createTestSettings } from './testSettings';

// Body-row regressions on the synthetic weird-report fixtures: page breaks,
// repeated headers, sub totals, spacer rows, carry-forward fill and indented
// hierarchies. The fixture truth lives in truth.json (generated, seeded).
const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/weird-reports');
const truth = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'truth.json'), 'utf8'));

const asCsvFile = (name: string, text: string) =>
    ({ name, size: text.length, text: async () => text }) as unknown as File;

const toBoundary = (resolution: ReportStructureResolution) => ({
    headerRowIndex: resolution.headerRowIndex,
    headerLayerRowIndexes: [...resolution.headerLayerRowIndexes],
    bodyStartIndex: resolution.bodyStartIndex,
    summaryStartIndex: resolution.summaryStartIndex,
    parameterRowIndexes: [...resolution.parameterRowIndexes],
    repeatedHeaderRowIndexes: [...resolution.repeatedHeaderRowIndexes],
});

const runIntake = async (name: string, text: string) => {
    const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile(name, text));
    const rawCsvData = buildCsvDataFromIntakeIr(intakeIr);
    const params = {
        rawCsvData,
        csvData,
        rawIntakeIr: intakeIr,
        cleaningRun: null,
        dataPreparationPlan: {
            explanation: 'Import keeps the source rows unchanged.',
            operations: [],
            outputColumns: [],
            planStatus: 'schema_only' as const,
            consistencyIssues: [],
        },
        columnProfiles: profileData(csvData.data).profiles,
        settings: createTestSettings(),
    };
    let artifacts = await resolveReportStructureArtifactsWithProposal(params);
    // A blocked structure is confirmed the way the review dialog does it, so the
    // body classification is tested independently of the header review gate.
    if (!artifacts.canonicalCsvData && artifacts.reportStructureResolution) {
        artifacts = await resolveReportStructureArtifactsWithProposal({
            ...params,
            humanBoundary: toBoundary(artifacts.reportStructureResolution),
        });
    }
    return { csvData, intakeIr, artifacts, canonical: artifacts.canonicalCsvData as CsvData };
};

const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
const findColumn = (rows: CsvRow[], pattern: RegExp) => Object.keys(rows[0] ?? {}).find(column => pattern.test(column))!;
const toNumber = (value: unknown) => (typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, '')) || 0);
const sumBy = (rows: CsvRow[], column: string) => rows.reduce((sum, row) => sum + toNumber(row[column]), 0);

const NOISE_TEXT = /sub total|grand total|page \d+ of|end of report|sales order outstanding|printed by|acme holdings|^s\/n$/i;

describe('w1 ERP outstanding orders: body noise, sub totals, carry-forward', () => {
    it('keeps only order lines in the imported table and remembers the sub totals as summary evidence', async () => {
        const { csvData, intakeIr } = await runIntake('w1_erp_outstanding.csv', readFixture('w1_erp_outstanding.csv'));
        expect(csvData.data).toHaveLength(truth.f1.rows);
        const noisy = csvData.data.filter(row => Object.values(row).some(value => NOISE_TEXT.test(String(value).trim())));
        expect(noisy).toEqual([]);
        expect(csvData.data.every(row => Object.values(row).some(value => String(value).trim() !== ''))).toBe(true);
        // One sub total per customer (the last one sits in the trailing summary) plus the grand total and end marker.
        const customers = Object.keys(truth.f1.per_customer).length;
        expect(csvData.summaryRows!.length).toBeGreaterThanOrEqual(customers);
        const kinds = intakeIr.segments.map(segment => segment.kind);
        expect(kinds).toContain('repeated_header');
        expect(kinds).toContain('summary');
    });

    it('builds a canonical order table whose sums match the report without double counting', async () => {
        const { canonical, artifacts } = await runIntake('w1_erp_outstanding.csv', readFixture('w1_erp_outstanding.csv'));
        const rows = canonical.data;
        expect(rows).toHaveLength(truth.f1.rows);
        expect(rows.every(row => row.RowRole === 'detail')).toBe(true);
        const amount = findColumn(rows, /balance amount/i);
        const customer = findColumn(rows, /^customer$/i);
        expect(sumBy(rows, amount)).toBeCloseTo(truth.f1.grand_total, 2);

        // Customer is printed once per group; every order line carries it after the fill.
        expect(rows.every(row => String(row[customer]).trim() !== '')).toBe(true);
        const perCustomer: Record<string, number> = {};
        rows.forEach(row => { perCustomer[String(row[customer])] = (perCustomer[String(row[customer])] ?? 0) + toNumber(row[amount]); });
        expect(Object.keys(perCustomer).sort()).toEqual(Object.keys(truth.f1.per_customer).sort());
        Object.entries(truth.f1.per_customer).forEach(([name, total]) => {
            expect(perCustomer[name]).toBeCloseTo(total as number, 2);
        });

        const leaked = rows.filter(row => Object.entries(row)
            .filter(([column]) => !['SourceRowIndex', 'RowRole', 'ResolvedRowRole', 'SectionLabel', 'HeaderPath', 'CarryForwardAppliedColumns'].includes(column))
            .some(([, value]) => NOISE_TEXT.test(String(value).trim())));
        expect(leaked).toEqual([]);
        const excluded = artifacts.canonicalBuildMeta!.excludedRowCounts;
        expect(excluded.header ?? 0).toBeGreaterThan(0);
        expect(excluded.subtotal ?? 0).toBeGreaterThan(0);
    });
});

describe('w2 indented hierarchy: parents are subtotals, leaves are the detail rows', () => {
    it('adds ParentSeries, HierarchyDepth and RowClass and trims the labels', async () => {
        const { canonical, artifacts } = await runIntake('w2_hierarchy_monthly.csv', readFixture('w2_hierarchy_monthly.csv'));
        const rows = canonical.data;
        const label = 'Region / Country / Customer';
        expect(artifacts.canonicalizationStatus).toBe('ready');
        expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['ParentSeries', 'HierarchyDepth', 'RowClass', 'RowRole', 'ResolvedRowRole']));
        expect(rows.every(row => String(row[label]) === String(row[label]).trim())).toBe(true);

        const leaves = rows.filter(row => row.RowClass === 'fact');
        const parents = rows.filter(row => row.RowClass !== 'fact');
        expect(leaves).toHaveLength(truth.f2.leaf_rows);
        expect(parents.length).toBeGreaterThan(0);
        expect(parents.every(row => row.RowClass === 'subtotal')).toBe(true);
        expect(sumBy(leaves, 'Total')).toBe(truth.f2.grand_total);
        // Without the detail filter a SUM counts regions, countries and customers.
        expect(sumBy(rows, 'Total')).toBeGreaterThan(truth.f2.grand_total * 2.5);
        // RowRole mirrors RowClass, like the melted period-wide table.
        expect(rows.every(row => row.RowRole === row.RowClass && row.ResolvedRowRole === row.RowClass)).toBe(true);
        expect(new Set(rows.map(row => row.HierarchyDepth))).toEqual(new Set([0, 1, 2]));
        // Leaves sit at the deepest level and every non-root row names a parent that exists.
        expect(leaves.every(row => row.HierarchyDepth === 2)).toBe(true);
        const keys = new Set(rows.map(row => row[label]));
        expect(rows.filter(row => row.ParentSeries !== null).every(row => keys.has(row.ParentSeries))).toBe(true);
        expect(rows.filter(row => row.HierarchyDepth === 0).every(row => row.ParentSeries === null)).toBe(true);
        expect(artifacts.canonicalBuildMeta!.rowHierarchy).toMatchObject({
            labelColumn: label,
            parentColumn: 'ParentSeries',
            rowClassColumn: 'RowClass',
            detailRowValue: 'fact',
            detailRows: truth.f2.leaf_rows,
        });
    });

    it('stores missing-month markers as nulls so the month columns stay numeric', async () => {
        const { canonical } = await runIntake('w2_hierarchy_monthly.csv', readFixture('w2_hierarchy_monthly.csv'));
        const months = ['Jan-26', 'Feb-26', 'Mar-26', 'Apr-26', 'May-26', 'Jun-26'];
        const values = canonical.data.flatMap(row => months.map(month => row[month]));
        expect(values.some(value => value === null)).toBe(true);
        expect(values.every(value => value === null || typeof value === 'number')).toBe(true);
    });
});

describe('w5 aging report: continuation lines, repeated headers, missing markers', () => {
    it('drops the Continued lines and repeated header rows and keeps measures numeric', async () => {
        const { csvData, canonical, artifacts } = await runIntake('w5_aging_meta_footnotes.csv', readFixture('w5_aging_meta_footnotes.csv'));
        expect(csvData.data.some(row => Object.values(row).some(value => /^continued/i.test(String(value).trim())))).toBe(false);
        expect(csvData.data.some(row => row.Customer === 'Customer')).toBe(false);
        expect(artifacts.canonicalizationStatus).toBe('ready');
        const rows = canonical.data;
        expect(rows).toHaveLength(truth.f5.rows);
        expect(sumBy(rows, 'Balance')).toBe(truth.f5.total_balance);
        const measures = ['Current', '1-30', '31-60', '61-90', '90+', 'Balance'];
        // "n.a.", "-" and empty cells are missing values, not text; "5853*" keeps its number.
        expect(rows.every(row => measures.every(column => row[column] === null || typeof row[column] === 'number'))).toBe(true);
        expect(rows.some(row => row.Current === null)).toBe(true);
    });
});

describe('w6 grouped header: category carried forward and values parsed after the melt', () => {
    it('gives every melted row its category and a numeric value', async () => {
        const { canonical } = await runIntake('w6_grouped_header_carryforward.csv', readFixture('w6_grouped_header_carryforward.csv'));
        const rows = canonical.data;
        expect(rows.every(row => String(row.Category).trim() !== '')).toBe(true);
        expect(new Set(rows.map(row => `${row.Category}|${row.Product}`)).size).toBe(truth.f6.rows);
        expect(rows.every(row => row.Value === null || typeof row.Value === 'number')).toBe(true);
        expect(sumBy(rows, 'Value')).toBe(truth.f6.total);
        expect(rows.some(row => String(row.CarryForwardAppliedColumns).includes('Category'))).toBe(true);
        // The FY layer survives the melt.
        expect(new Set(rows.map(row => row.SeriesLabelL1))).toEqual(new Set(['FY2025', 'FY2026']));
    });
});

describe('inline variants of the body rules', () => {
    // A small printed report: title block, header, order lines. The layout is
    // wide enough for the deterministic header detection to take it as a report.
    const TITLE = ['ACME HOLDINGS SDN BHD', 'SALES REPORT', 'From 01-01-2026 To 30-06-2026', ''];
    const HEADER = 'S/N,Customer,Order Date,SO No.,Qty,Amount';
    const line = (n: number, customer: string, amount: number) =>
        `${n},${customer},0${(n % 9) + 1}-03-2026,SO${1000 + n},${n * 3},${amount}`;
    const csv = (lines: string[]) => lines.join('\n') + '\n';

    it('does not remove a "Total" row from the body when its amount is not a sum', async () => {
        const lines = [...TITLE, HEADER];
        for (let n = 1; n <= 8; n += 1) lines.push(line(n, 'North Ltd', n * 10));
        lines.push(',,,Total,,999');
        for (let n = 9; n <= 12; n += 1) lines.push(line(n, 'South Ltd', n * 10));
        const { csvData } = await processCsvWithIntakeIr(asCsvFile('plain.csv', csv(lines)));
        expect(csvData.data.filter(row => row['SO No.'] === 'Total')).toHaveLength(1);
        expect(csvData.data).toHaveLength(13);
    });

    it('removes a reconciling mid-table sub total and keeps it as summary evidence', async () => {
        const lines = [...TITLE, HEADER];
        for (let n = 1; n <= 6; n += 1) lines.push(line(n, 'North Ltd', n * 10));
        lines.push(',,,Sub Total:,,,210');
        for (let n = 7; n <= 12; n += 1) lines.push(line(n, 'South Ltd', n * 10));
        const { csvData } = await processCsvWithIntakeIr(asCsvFile('subtotal.csv', csv(lines)));
        expect(csvData.data).toHaveLength(12);
        expect(csvData.data.some(row => /sub total/i.test(String(row['SO No.'])))).toBe(false);
        expect(csvData.summaryRows!.length).toBe(1);
    });

    it('fills a group label down across spacer rows, a sub total and a page break', async () => {
        const lines = [...TITLE, HEADER];
        for (let n = 1; n <= 4; n += 1) lines.push(line(n, n === 1 ? 'North Ltd' : '', n * 10));
        lines.push(',,,Sub Total:,,,100', '');
        lines.push(...TITLE, HEADER);
        for (let n = 5; n <= 9; n += 1) lines.push(line(n, n === 5 ? 'South Ltd' : '', n * 10));
        lines.push(',,,Sub Total:,,,350', '');
        lines.push(...TITLE, HEADER);
        for (let n = 10; n <= 12; n += 1) lines.push(line(n, n === 10 ? 'East Ltd' : '', n * 10));
        const { csvData, canonical } = await runIntake('carry.csv', csv(lines));
        expect(csvData.data).toHaveLength(12);
        const customers = canonical.data.map(row => row.Customer);
        expect(customers).toEqual([
            ...Array(4).fill('North Ltd'), ...Array(5).fill('South Ltd'), ...Array(3).fill('East Ltd'),
        ]);
        expect(sumBy(canonical.data, 'Amount')).toBe(780);
        expect(canonical.data.every(row => row.RowRole === 'detail')).toBe(true);
    });

    it('detects an indentation hierarchy only when the parents equal their children', async () => {
        const build = (parentTotal: number) => csv([
            'Name,Jan-26,Feb-26,Mar-26,Total',
            `North,${parentTotal},30,30,90`,
            '    Alpha,10,10,10,30',
            '    Beta,20,20,20,60',
            'South,5,6,7,18',
            '    Gamma,2,3,3,8',
            '    Delta,3,3,4,10',
            'East,9,9,9,27',
            '    Epsilon,4,4,4,12',
            '    Zeta,5,5,5,15',
        ]);
        const verified = await runIntake('hier.csv', build(30));
        expect(verified.canonical.data.map(row => row.RowClass)).toEqual([
            'subtotal', 'fact', 'fact', 'subtotal', 'fact', 'fact', 'subtotal', 'fact', 'fact',
        ]);
        expect(sumBy(verified.canonical.data.filter(row => row.RowClass === 'fact'), 'Total')).toBe(135);
        // Cosmetic indentation: parents that do not add up are left alone.
        const plain = await runIntake('cosmetic.csv', csv([
            'Name,Jan-26,Feb-26,Mar-26,Total',
            'North,100,300,100,500',
            '    Alpha,10,10,10,30',
            '    Beta,20,20,20,60',
            'South,500,600,700,1800',
            '    Gamma,2,3,3,8',
            '    Delta,3,3,4,10',
            'East,900,900,900,2700',
            '    Epsilon,4,4,4,12',
            '    Zeta,5,5,5,15',
        ]));
        expect(Object.keys(plain.canonical.data[0])).not.toContain('RowClass');
    });
});
