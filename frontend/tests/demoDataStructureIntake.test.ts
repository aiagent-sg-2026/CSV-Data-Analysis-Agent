import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import type { CsvRow, ReportBoundary, ReportStructureResolution } from '../types';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { detectReportShape } from '../services/agent/reportShapeDetector';
import { resolveReportStructureArtifactsWithProposal } from '../services/agent/orchestration/reportStructureOrchestrator';
import { createTestSettings } from './testSettings';

// Every dataset in the in-app demo gallery, loaded through the same steps the
// production intake runs (fileProcessor.processAndCleanFile): CSV dialect and
// boundary detection, then report-structure resolution without an AI proposal.
const DEMO_DIR = path.resolve(process.cwd(), '../demo-data');
const LARGE_FILE_PREVIEW_ROWS = 2000;

const asCsvFile = (name: string, text: string) =>
    ({ name, size: text.length, text: async () => text }) as unknown as File;

// The 83 MB HDB file goes through the large-file path, which parses only a
// 2,000-row preview with the regular intake; mirror that here.
const readDemoText = (fileName: string, previewRows?: number) => {
    const filePath = path.join(DEMO_DIR, fileName);
    if (!previewRows) return fs.readFileSync(filePath, 'utf8');
    const buffer = Buffer.alloc(1024 * 1024);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, previewRows + 1).join('\n');
};

const toBoundary = (resolution: ReportStructureResolution): ReportBoundary => ({
    headerRowIndex: resolution.headerRowIndex,
    headerLayerRowIndexes: [...resolution.headerLayerRowIndexes],
    bodyStartIndex: resolution.bodyStartIndex,
    summaryStartIndex: resolution.summaryStartIndex,
    parameterRowIndexes: [...resolution.parameterRowIndexes],
    repeatedHeaderRowIndexes: [...resolution.repeatedHeaderRowIndexes],
});

const runProductionIntake = async (fileName: string, options: { previewRows?: number; confirmBoundary?: boolean } = {}) => {
    const text = readDemoText(fileName, options.previewRows);
    const startedAt = performance.now();
    const { csvData, intakeIr } = await processCsvWithIntakeIr(asCsvFile(fileName, text));
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
    const artifacts = await resolveReportStructureArtifactsWithProposal(params);
    const elapsedMs = performance.now() - startedAt;
    // The review dialog's "Confirm & Start Analysis" re-resolves with the
    // displayed boundary marked as human-confirmed.
    const confirmed = options.confirmBoundary && artifacts.reportStructureResolution
        ? await resolveReportStructureArtifactsWithProposal({
            ...params,
            humanBoundary: toBoundary(artifacts.reportStructureResolution),
        })
        : null;
    return { text, csvData, rawCsvData, artifacts, confirmed, elapsedMs };
};

const isMissingSourceCell = (value: string) => /^(?:|na|n\.a\.|n\/a|-+|[–—]|\.{2,3})$/i.test(value.trim());

// Independent count of the source grid, parsed with Papa Parse instead of the
// app's intake: one entry per (body row, period column) with its number, or
// null for an explicit missing marker.
const readSourceGrid = (text: string) => {
    const rows = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' }).data;
    const [header, ...body] = rows;
    const cells = new Map<string, number | null>();
    body.forEach((row, rowIndex) => {
        header.slice(1).forEach((column, offset) => {
            const raw = String(row[offset + 1] ?? '');
            cells.set(`${rowIndex}|${column}`, isMissingSourceCell(raw) ? null : Number(raw.replace(/,/g, '')));
        });
    });
    return { header, body, cells };
};

const valueOf = (row: CsvRow) => (row.Value === null ? null : Number(row.Value));

describe('demo gallery datasets on the deterministic intake path', () => {
    it.each([
        ['sg-business-formation.csv', 16, 441, 0],
        ['sg-visitor-arrivals.csv', 62, 224, 0],
        ['sg-public-transport-ridership.csv', 11, 36, 147],
    ])('melts the period-header wide table %s into an analysis-ready long table', async (fileName, seriesCount, periodCount, missingCount) => {
        const { text, rawCsvData, artifacts, elapsedMs } = await runProductionIntake(fileName);
        const resolution = artifacts.reportStructureResolution!;

        expect(detectReportShape(rawCsvData).primaryKind).toBe('wide_crosstab');
        expect(resolution.runtimeTableAssessment?.status).toBe('confirmed');
        expect(resolution.blockingReasons).toEqual([]);
        expect(resolution.requiresHumanReview).toBe(false);
        expect(resolution.decision.targetShape).toBe('long_fact_table');
        expect(artifacts.canonicalizationStatus).toBe('ready');
        expect(artifacts.pipelineOutcome).toMatchObject({ status: 'ready', canAutoAnalyze: true });
        // The visitor-arrivals intake used to spend ~37 s in the in-body
        // header-layout scan; the budget leaves room for slow CI machines.
        expect(elapsedMs).toBeLessThan(15_000);

        const rows = artifacts.canonicalCsvData!.data;
        expect(Object.keys(rows[0])).toEqual(expect.arrayContaining([
            'DataSeries', 'ParentSeries', 'HierarchyDepth', 'RowClass', 'Period', 'Value', 'SourceColumnName', 'SourceRowIndex', 'RowRole',
        ]));
        expect(rows).toHaveLength(seriesCount * periodCount);

        const source = readSourceGrid(text);
        expect(source.body).toHaveLength(seriesCount);
        expect(source.cells.size).toBe(seriesCount * periodCount);
        expect([...source.cells.values()].filter(value => value === null)).toHaveLength(missingCount);

        // Every source cell appears exactly once, non-missing values unchanged
        // and missing markers as NULL (never 0).
        const seen = new Map<string, number | null>();
        rows.forEach(row => {
            const key = `${row.SourceRowIndex}|${row.SourceColumnName}`;
            expect(seen.has(key)).toBe(false);
            seen.set(key, valueOf(row));
        });
        expect(seen).toEqual(source.cells);
        expect(rows.filter(row => row.Value !== null)).toHaveLength(seriesCount * periodCount - missingCount);

        rows.forEach(row => {
            const label = String(source.body[Number(row.SourceRowIndex)][0]);
            expect(row.DataSeries).toBe(label.trim());
            expect(row.RowRole).toBe(row.RowClass);
            expect(row.Period).toMatch(/^\d{4}-\d{2}-01$/);
        });
    }, 60_000);

    it('parses SingStat period labels into period start dates', async () => {
        const monthly = (await runProductionIntake('sg-visitor-arrivals.csv')).artifacts.canonicalCsvData!.data;
        expect(monthly.find(row => row.SourceColumnName === '2026Aug')?.Period).toBe('2026-08-01');
        expect(monthly.find(row => row.SourceColumnName === '2008Jan')?.Period).toBe('2008-01-01');

        const yearly = (await runProductionIntake('sg-public-transport-ridership.csv')).artifacts.canonicalCsvData!.data;
        expect(yearly.find(row => row.SourceColumnName === '2025')?.Period).toBe('2025-01-01');
        expect(yearly.find(row => row.SourceColumnName === '1990')?.Period).toBe('1990-01-01');
        const missing = yearly.find(row => row.DataSeries === 'Total Ridership By MRT And LRT' && row.SourceColumnName === '2025');
        expect(missing?.Value).toBeNull();
    }, 60_000);

    it('derives parent series from indentation and flags parents so detail rows sum to the published totals', async () => {
        const visitor = (await runProductionIntake('sg-visitor-arrivals.csv')).artifacts.canonicalCsvData!.data;
        const at = (rows: CsvRow[], series: string, column: string) =>
            rows.find(row => row.DataSeries === series && row.SourceColumnName === column);

        expect(at(visitor, 'Total International Visitor Arrivals By Place Of Residence', '2026Aug')).toMatchObject({
            ParentSeries: null, HierarchyDepth: 0, RowClass: 'total',
        });
        expect(at(visitor, 'Southeast Asia', '2026Aug')).toMatchObject({
            ParentSeries: 'Total International Visitor Arrivals By Place Of Residence', HierarchyDepth: 1, RowClass: 'subtotal',
        });
        expect(at(visitor, 'Indonesia', '2026Aug')).toMatchObject({
            ParentSeries: 'Southeast Asia', HierarchyDepth: 2, RowClass: 'fact', Value: 161684,
        });
        expect(at(visitor, 'Others', '2026Aug')).toMatchObject({ HierarchyDepth: 1, RowClass: 'fact' });

        const ridership = (await runProductionIntake('sg-public-transport-ridership.csv')).artifacts.canonicalCsvData!.data;
        expect(at(ridership, 'Rail Length', '2025')).toMatchObject({ ParentSeries: null, RowClass: 'subtotal', Value: 271.3 });
        expect(at(ridership, 'Mass Rapid Transit (MRT)', '2025')).toMatchObject({ ParentSeries: 'Rail Length', HierarchyDepth: 1, RowClass: 'fact' });
        expect(at(ridership, 'MRT km Operated', '2025')).toMatchObject({ ParentSeries: null, HierarchyDepth: 0, RowClass: 'fact' });

        for (const [fileName, totalSeries] of [
            ['sg-business-formation.csv', 'Total'],
            ['sg-visitor-arrivals.csv', 'Total International Visitor Arrivals By Place Of Residence'],
        ] as const) {
            const rows = (await runProductionIntake(fileName)).artifacts.canonicalCsvData!.data;
            const factCounts = new Map<string, number>();
            rows.filter(row => row.RowClass === 'fact').forEach(row => {
                factCounts.set(String(row.Period), (factCounts.get(String(row.Period)) ?? 0) + Number(row.Value));
            });
            const totals = rows.filter(row => row.DataSeries === totalSeries);
            expect(totals.length).toBeGreaterThan(0);
            totals.forEach(total => expect(factCounts.get(String(total.Period))).toBe(total.Value));
            // The runtime detail-row filter keeps the most frequent RowClass.
            const classCounts = rows.reduce<Record<string, number>>((counts, row) => {
                counts[String(row.RowClass)] = (counts[String(row.RowClass)] ?? 0) + 1;
                return counts;
            }, {});
            expect(Object.entries(classCounts).sort((left, right) => right[1] - left[1])[0][0]).toBe('fact');
        }
    }, 120_000);

    it.each([
        'sg-business-formation.csv',
        'sg-visitor-arrivals.csv',
        'sg-public-transport-ridership.csv',
    ])('keeps %s analysis-ready after Confirm & Start Analysis in the review dialog', async fileName => {
        const { confirmed } = await runProductionIntake(fileName, { confirmBoundary: true });

        expect(confirmed?.reportStructureResolution?.source).toBe('human_confirmed');
        expect(confirmed?.reportStructureResolution?.decision.targetShape).toBe('long_fact_table');
        expect(confirmed?.pipelineOutcome).toMatchObject({ status: 'ready', canAutoAnalyze: true });
    }, 60_000);

    it.each([
        ['singapore-hdb-resale-prices-sample.csv', 4988, undefined],
        ['singapore-hdb-resale-prices.csv', LARGE_FILE_PREVIEW_ROWS, LARGE_FILE_PREVIEW_ROWS],
        ['sg-graduate-employment.csv', 1550, undefined],
        ['sg-coe-bidding.csv', 1990, undefined],
        ['sg-resident-unemployment.csv', 768, undefined],
        ['sg-hdb-median-rent.csv', 9507, undefined],
    ])('leaves the flat table %s as an already-tabular row table without review', async (fileName, rowCount, previewRows) => {
        const { csvData, rawCsvData, artifacts } = await runProductionIntake(fileName, { previewRows });
        const resolution = artifacts.reportStructureResolution!;

        expect(csvData.data).toHaveLength(rowCount);
        expect(detectReportShape(rawCsvData).primaryKind).toBe('already_tabular');
        expect(resolution.requiresHumanReview).toBe(false);
        expect(resolution.blockingReasons).toEqual([]);
        expect(resolution.decision.targetShape).toBe('row_table');
        expect(artifacts.canonicalCsvData?.data).toHaveLength(rowCount);
        expect(artifacts.pipelineOutcome).toMatchObject({ status: 'ready', canAutoAnalyze: true });
    }, 60_000);
});
