// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { resolveReportStructureArtifactsWithProposal } from '../services/agent/orchestration/reportStructureOrchestrator';
import { verifyCleanedDatasetShape } from '../services/agent/cleaningVerification';
import { createTestSettings } from './testSettings';
import type { CsvData } from '../types';

// Synthetic fixtures (see fixtures/weird-reports/README.md). Intake folds each
// header layer into the column names ("Order :: Date", "FY2025 :: Q1"), so no
// band label is lost and the label-layer check must not ask for a review.
const plan = {
    explanation: 'Import keeps the source rows unchanged.',
    operations: [],
    outputColumns: [],
    planStatus: 'schema_only' as const,
    consistencyIssues: [],
};

type Loaded = { rawCsvData: CsvData; csvData: CsvData; intakeIr: Awaited<ReturnType<typeof processCsvWithIntakeIr>>['intakeIr'] };

const load = async (fileName: string): Promise<Loaded> => {
    const text = fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures/weird-reports', fileName), 'utf8');
    const file = { name: fileName, size: text.length, text: async () => text } as unknown as File;
    const { csvData, intakeIr } = await processCsvWithIntakeIr(file);
    return { rawCsvData: buildCsvDataFromIntakeIr(intakeIr), csvData, intakeIr };
};

const resolve = (loaded: Loaded) => resolveReportStructureArtifactsWithProposal({
    rawCsvData: loaded.rawCsvData,
    csvData: loaded.csvData,
    rawIntakeIr: loaded.intakeIr,
    cleaningRun: null,
    dataPreparationPlan: plan,
    columnProfiles: profileData(loaded.csvData.data).profiles,
    settings: createTestSettings(),
});

// Rename columns of the prepared table, as a faulty cleaning step would.
const renameColumns = (data: CsvData, rename: (column: string) => string): CsvData => ({
    ...data,
    data: data.data.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => [rename(column), value]))),
});

describe('header layers folded into column names', () => {
    let w1: Loaded;
    let w6: Loaded;
    beforeAll(async () => {
        w1 = await load('w1_erp_outstanding.csv');
        w6 = await load('w6_grouped_header_carryforward.csv');
    });

    it('keeps the ERP report fold out of the label-layer review (Order / Delivery / Quantity / Amount)', async () => {
        expect(Object.keys(w1.csvData.data[0]!)).toEqual(expect.arrayContaining(['Order :: Date', 'Delivery :: Date', 'Quantity :: Ordered', 'Amount :: Balance Amount']));
        const verification = verifyCleanedDatasetShape(w1.rawCsvData, w1.csvData, plan);
        expect(verification.signalKey).not.toBe('label_layer_retention_complete');
        expect(verification.signalKey).not.toBe('multi_header_layer_retention_rate');

        const artifacts = await resolve(w1);
        expect(artifacts.reportStructureResolution?.blockingReasons).not.toContain('label_layer_retention_complete');
    });

    it('does not review the grouped FY2025 / FY2026 header at all', async () => {
        expect(Object.keys(w6.csvData.data[0]!)).toEqual(expect.arrayContaining(['FY2025 :: Q1', 'FY2026 :: Q3']));
        const verification = verifyCleanedDatasetShape(w6.rawCsvData, w6.csvData, plan);
        expect(verification).toMatchObject({ passed: true, signalKey: null });

        const artifacts = await resolve(w6);
        expect(artifacts.pipelineOutcome?.status).not.toBe('needs_structure_review');
        expect(artifacts.pipelineOutcome).toMatchObject({ status: 'ready', canAutoAnalyze: true });
    });

    it('still blocks when a layer of the ERP header is dropped from the column names', () => {
        const dropped = renameColumns(w1.csvData, column => column.startsWith('Delivery :: ')
            ? `${column.slice('Delivery :: '.length)} (delivery)`
            : column);
        const verification = verifyCleanedDatasetShape(w1.rawCsvData, dropped, plan);
        expect(verification).toMatchObject({ passed: false, signalKey: 'label_layer_retention_complete' });
    });

    it('still blocks when the whole band layer of the grouped header is dropped', () => {
        // Keeping only the quarter names leaves no trace of FY2025 / FY2026 in any column name.
        const dropped = renameColumns(w6.csvData, column => column.includes(' :: ') ? column.split(' :: ')[1]! : column);
        const verification = verifyCleanedDatasetShape(w6.rawCsvData, dropped, plan);
        expect(verification).toMatchObject({ passed: false, signalKey: 'label_layer_retention_complete' });
    });
});
