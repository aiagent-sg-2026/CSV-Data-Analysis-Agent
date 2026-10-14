// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { detectReportShape } from '../services/agent/reportShapeDetector';
import { buildReshapeHypotheses } from '../services/agent/reportShapeHypothesis';
import { buildCsvDataFromRawRows } from '../services/data/reportCsvIntake';
import type { CsvData } from '../types';

const makeData = (seriesNames: string[]): CsvData => ({
    fileName: 'report.csv',
    headerLayers: [['', '', ...seriesNames.map(() => 'Cost centre'), '']],
    data: Array.from({ length: 12 }, (_, index) => ({
        Description: `Item ${index}`,
        Notes: `Note ${index}`,
        ...Object.fromEntries(seriesNames.map((name, column) => [name, (index + 1) * (column + 2) * 100])),
        Total: (index + 1) * 1000,
    })),
}) as unknown as CsvData;

describe('report series columns', () => {
    it('treats numeric columns as the detail series whatever their header words are', () => {
        const profile = detectReportShape(makeData(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']));
        const series = profile.columnRoles.filter(role => role.role === 'detail_series').map(role => role.columnName);

        expect(series).toEqual(expect.arrayContaining(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']));
    });

    it('does not take text columns named like entities as series', () => {
        const data = makeData(['Alpha', 'Beta', 'Gamma', 'Delta']);
        const profile = detectReportShape({
            ...data,
            data: data.data.map(row => ({ ...row, Project: 'P-1', Office: 'HQ' })),
        } as CsvData);
        const series = profile.columnRoles.filter(role => role.role === 'detail_series').map(role => role.columnName);

        expect(series).not.toContain('Project');
        expect(series).not.toContain('Office');
    });

    it('excludes padding and rollups from a monthly detail axis', () => {
        const periods = ['January', 'February', 'March', 'April'];
        const data = {
            fileName: 'monthly.csv',
            headerLayers: [['', '', 'Sales', 'Stock Balance', ...periods.flatMap(() => ['Sales', 'Stock Balance']), 'Sales', 'Stock Balance', '']],
            data: Array.from({ length: 4 }, (_, index) => ({
                Code: `ITEM-${index}`, Description: `Item ${index}`,
                '2010 :: Sales': '100', '2010 :: Stock Balance': '50',
                ...Object.fromEntries(periods.flatMap(period => [[`${period} :: Sales`, '25'], [`${period} :: Stock Balance`, '12.5']])),
                'TOTAL :: Sales': '100', 'TOTAL :: Stock Balance': '50', RowNumber: index + 1, _unnamed_column_15: '0',
            })),
        } as CsvData;
        const candidate = detectReportShape(data).candidates[0]!;

        expect(candidate.detailSeriesColumns).toEqual(periods.flatMap(period => [`${period} :: Sales`, `${period} :: Stock Balance`]));
        expect(candidate.summarySeriesColumns).toEqual(['2010 :: Sales', '2010 :: Stock Balance', 'TOTAL :: Sales', 'TOTAL :: Stock Balance']);
    });

    it('keeps a year-only comparison axis as detail series', () => {
        const years = ['2020', '2021', '2022', '2023'];
        const data = buildCsvDataFromRawRows('annual.csv', [
            ['Code', 'Description', ...years.flatMap(year => [year, ''])],
            ['', '', ...years.flatMap(() => ['Sales', 'Cost'])],
            ...Array.from({ length: 4 }, (_, index) => [
                `ITEM-${index}`, `Item ${index}`, ...years.flatMap(() => ['10', '5']),
            ]),
        ]);

        expect(detectReportShape(data).candidates[0]?.detailSeriesColumns)
            .toEqual(years.flatMap(year => [`${year} :: Sales`, `${year} :: Cost`]));
    });

    it('keeps a compacted cost header as distinct row-table measures', () => {
        const data = buildCsvDataFromRawRows('costs.csv', [
            ['Synthetic Cost Report'],
            ['', 'Item', 'Budget', 'Committed', 'Certified', '', 'Final', 'Variance', 'Additional', '', '', '', ''],
            ['Code', 'Description', 'Original', 'Revised', 'To Date', 'To Date', 'Forecast', 'Forecast', 'Apr 2025', 'Jan 2025', 'Claim', 'Balance', 'Remarks'],
            ...Array.from({ length: 12 }, (_, index) => [
                `ITEM-${index}`, `Item ${index}`, '20', '21', '10', '11', '22', '23', '1', '2', '3', '4', '',
            ]),
        ]);
        const profile = detectReportShape(data);

        expect(data.headerLayers).toHaveLength(1);
        expect(profile.primaryKind).toBe('already_tabular');
        expect(buildReshapeHypotheses(profile, data)[0]?.logicalSteps.some(step => step.type === 'unpivot_detail_series')).toBe(false);
    });
});
