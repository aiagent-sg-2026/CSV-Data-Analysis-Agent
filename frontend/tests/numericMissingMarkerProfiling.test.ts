// @vitest-environment node
//
// Regression: a real-AI run on sg-hdb-median-rent.csv treated median_rent as a
// category ("Distinct Median Rent by Quarter", "Rent Band Count") because one
// `na` or `-` cell made the profiler type the whole column as text, so the
// research planner rejected median/avg on it. These tests run the demo CSVs
// through the production intake path and both profilers, including the
// lightweight profiler that types the canonical analysis dataset.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ColumnProfile, CsvData, DataPreparationPlan } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { profileData, profileDataLightweight } from '../services/data/dataProfiler';
import { resolveReportStructureArtifacts } from '../services/agent/reportStructureState';
import { resolveAnalysisDatasetProfiles } from '../services/agent/analysisDatasetProfiles';
import { applyDataOperations } from '../services/agent/execution/dataOperationMutator';

const importDemoCsv = (name: string): CsvData => {
    const text = readFileSync(fileURLToPath(new URL(`../../demo-data/${name}`, import.meta.url)), 'utf8');
    const { rawRows, detection } = parseCsvTextWithDetection(text);
    return buildCsvDataFromIntakeIr(buildReportIntakeIr(name, rawRows, detection));
};

const schemaOnlyPlan: DataPreparationPlan = {
    explanation: 'No reshape is required for a row-oriented table.',
    operations: [],
    outputColumns: [],
    planStatus: 'schema_only',
    consistencyIssues: [],
};

// The analysis runs on the canonical dataset, and the store profiles it with
// the lightweight profiler because its lineage columns differ from csvData.
const profileCanonicalAnalysisDataset = (csvData: CsvData) => {
    const { rawRows, detection } = parseCsvTextWithDetection(
        readFileSync(fileURLToPath(new URL(`../../demo-data/${csvData.fileName}`, import.meta.url)), 'utf8'),
    );
    const rawIntakeIr = buildReportIntakeIr(csvData.fileName, rawRows, detection);
    const artifacts = resolveReportStructureArtifacts({
        rawCsvData: csvData,
        csvData,
        rawIntakeIr,
        cleaningRun: null,
        dataPreparationPlan: schemaOnlyPlan,
    });
    const canonical = artifacts.canonicalCsvData;
    expect(canonical?.data.length).toBe(csvData.data.length);
    const preparedProfiles = profileData(csvData.data).profiles;
    return { canonical: canonical!, profiles: resolveAnalysisDatasetProfiles(canonical, preparedProfiles) };
};

const byName = (profiles: ColumnProfile[]) => new Map(profiles.map(profile => [profile.name, profile]));

const expectTypes = (profiles: ColumnProfile[], numerical: string[], categorical: string[]) => {
    const map = byName(profiles);
    numerical.forEach(name => expect(map.get(name)?.type, name).toBe('numerical'));
    categorical.forEach(name => expect(map.get(name)?.type, name).toBe('categorical'));
};

describe('numeric columns with missing markers (sg-hdb-median-rent.csv)', () => {
    const rent = importDemoCsv('sg-hdb-median-rent.csv');
    // 2,273 `na` + 2,249 `-` of 9,507 rows.
    const expectedMissing = (4522 / 9507) * 100;

    it('types median_rent as numerical with the markers counted as missing', () => {
        expect(rent.data).toHaveLength(9507);
        const { profiles } = profileData(rent.data);
        expectTypes(profiles, ['median_rent'], ['quarter', 'town', 'flat_type']);
        const medianRent = byName(profiles).get('median_rent')!;
        expect(medianRent.missingPercentage).toBeCloseTo(expectedMissing, 6);
        expect(medianRent.valueRange?.every(Number.isFinite)).toBe(true);
        expect(medianRent.valueRange?.[0]).toBeGreaterThan(0);
    });

    it('lightweight profiler agrees and reports missing over every row', () => {
        const { profiles } = profileDataLightweight(rent.data);
        expectTypes(profiles, ['median_rent'], ['quarter', 'town', 'flat_type']);
        expect(byName(profiles).get('median_rent')?.missingPercentage).toBeCloseTo(expectedMissing, 6);
    });

    it('keeps median_rent numerical in the canonical analysis profiles', () => {
        const { profiles } = profileCanonicalAnalysisDataset(rent);
        expectTypes(profiles, ['median_rent'], ['quarter', 'town', 'flat_type']);
        expect(byName(profiles).get('median_rent')?.missingPercentage).toBeCloseTo(expectedMissing, 6);
    });

    it('casts markers to NULL and keeps real numbers when the cleaning step casts the column', () => {
        const { data } = applyDataOperations(rent.data.slice(0, 40), [{
            id: 'cast_rent', type: 'cast_column', reason: 'test', column: 'median_rent', targetType: 'number',
        }]);
        const original = rent.data.slice(0, 40).map(row => String(row.median_rent));
        data.forEach((row, index) => {
            if (original[index] === 'na' || original[index] === '-') {
                expect(row.median_rent).toBeNull();
            } else {
                expect(row.median_rent).toBe(Number(original[index]));
            }
        });
        expect(original).toContain('na');
        expect(original).toContain('-');
    });
});

describe('numeric columns with na / N.A. markers (sg-graduate-employment.csv)', () => {
    const graduate = importDemoCsv('sg-graduate-employment.csv');
    const measures = [
        'employment_rate_overall', 'employment_rate_ft_perm',
        'basic_monthly_mean', 'basic_monthly_median',
        'gross_monthly_mean', 'gross_monthly_median',
        'gross_mthly_25_percentile', 'gross_mthly_75_percentile',
    ];
    const dimensions = ['university', 'school', 'degree'];

    it('types every salary and employment column as numerical in both profilers', () => {
        const full = profileData(graduate.data).profiles;
        expectTypes(full, measures, dimensions);
        // 92 `na` + 13 `N.A.` of 1,550 rows.
        measures.forEach(name => expect(byName(full).get(name)?.missingPercentage).toBeCloseTo((105 / 1550) * 100, 6));
        expectTypes(profileDataLightweight(graduate.data).profiles, measures, dimensions);
    });
});

describe('tidy COE file (sg-coe-bidding.csv)', () => {
    const coe = importDemoCsv('sg-coe-bidding.csv');
    const measures = ['quota', 'bids_success', 'bids_received', 'premium'];
    const dimensions = ['month', 'vehicle_class'];

    it('types the comma-formatted bid counts as numerical', () => {
        expectTypes(profileData(coe.data).profiles, measures, dimensions);
        expectTypes(profileDataLightweight(coe.data).profiles, measures, dimensions);
    });

    it('keeps the year-month column as text in the canonical analysis dataset', () => {
        const { canonical, profiles } = profileCanonicalAnalysisDataset(coe);
        // A prefix parse once turned "2010-01" into the number 2010, merging all
        // twelve months of a year and typing month as a measure.
        expect(canonical.data[0]?.month).toBe('2010-01');
        expect(new Set(canonical.data.map(row => row.month)).size).toBe(199);
        expect(canonical.data.find(row => row.bids_received === 1438)).toBeTruthy();
        expectTypes(profiles, measures, dimensions);
    });
});

describe('missing-marker profiling rules', () => {
    it('keeps a literal 0 as a value and counts markers as missing', () => {
        const rows = [{ v: '0' }, { v: 'na' }, { v: '5' }, { v: 'N.A.' }, { v: '' }];
        const full = profileData(rows).profiles[0];
        expect(full.type).toBe('numerical');
        expect(full.valueRange).toEqual([0, 5]);
        expect(full.missingPercentage).toBeCloseTo(60, 6);
        const light = profileDataLightweight(rows).profiles[0];
        expect(light.type).toBe('numerical');
        expect(light.missingPercentage).toBeCloseTo(60, 6);
    });

    it('reports markers in the high-missing issue text', () => {
        const rows = [{ v: '1' }, { v: '-' }, { v: 'na' }, { v: 'n/a' }];
        expect(profileData(rows).issues).toContain("Column 'v' has a high percentage of missing values (75%).");
    });

    it('still types a column with real text as categorical', () => {
        const rows = [{ v: '10' }, { v: 'na' }, { v: 'pending' }];
        expect(profileData(rows).profiles[0].type).toBe('categorical');
    });
});
