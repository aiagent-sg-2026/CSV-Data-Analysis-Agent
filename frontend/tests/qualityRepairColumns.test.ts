// @vitest-environment node
//
// Regression: on sg-coe-bidding.csv the pre-analysis quality check asked the
// model to repair "SectionLabel", a lineage column of the canonical analysis
// dataset that is empty on a flat file and absent from csvData, and data.mutate
// failed with `Operation "fill_missing_1" references missing columns`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DataPreparationPlan } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { resolveReportStructureArtifacts } from '../services/agent/reportStructureState';
import { resolveAnalysisDatasetProfiles } from '../services/agent/analysisDatasetProfiles';
import {
    buildQualityIssueSummary,
    resolveQualityRepairableColumns,
} from '../services/agent/runtime/analysisQualityCheck';
import type { DataInvestigationFindings } from '../services/agent/runtime/dataInvestigationHarness';
import type { StoreApi } from '../services/agent/runtime/analysisSessionHelpers';

const schemaOnlyPlan: DataPreparationPlan = {
    explanation: 'No reshape is required for a row-oriented table.',
    operations: [],
    outputColumns: [],
    planStatus: 'schema_only',
    consistencyIssues: [],
};

describe('pre-analysis quality repair columns', () => {
    const findings = {
        missingDataPatterns: [
            { column: 'SectionLabel', nullRate: 1, blankRate: 1, zeroRate: 0, severity: 'severe' },
            { column: 'HeaderPath', nullRate: 1, blankRate: 1, zeroRate: 0, severity: 'severe' },
            { column: 'premium', nullRate: 0.1, blankRate: 0.1, zeroRate: 0, severity: 'moderate' },
        ],
    } as unknown as DataInvestigationFindings;

    it('offers only columns that data.mutate can reach in csvData', () => {
        const name = 'sg-coe-bidding.csv';
        const text = readFileSync(fileURLToPath(new URL(`../../demo-data/${name}`, import.meta.url)), 'utf8');
        const { rawRows, detection } = parseCsvTextWithDetection(text);
        const rawIntakeIr = buildReportIntakeIr(name, rawRows, detection);
        const csvData = buildCsvDataFromIntakeIr(rawIntakeIr);
        const { canonicalCsvData } = resolveReportStructureArtifacts({
            rawCsvData: csvData, csvData, rawIntakeIr, cleaningRun: null, dataPreparationPlan: schemaOnlyPlan,
        });
        // The store profiles the canonical analysis dataset, lineage columns included.
        const columnProfiles = resolveAnalysisDatasetProfiles(canonicalCsvData, profileData(csvData.data).profiles);
        expect(columnProfiles.map(profile => profile.name)).toContain('SectionLabel');
        const store = { getState: () => ({ csvData, columnProfiles }) } as unknown as StoreApi;

        const repairable = resolveQualityRepairableColumns(store);
        expect(repairable).toEqual(['month', 'bidding_no', 'vehicle_class', 'quota', 'bids_success', 'bids_received', 'premium']);
        // nullRate + blankRate is the harness's own reported sum.
        expect(buildQualityIssueSummary(findings, repairable)).toEqual(['Column "premium" has 20% null/blank values']);
    });
});
