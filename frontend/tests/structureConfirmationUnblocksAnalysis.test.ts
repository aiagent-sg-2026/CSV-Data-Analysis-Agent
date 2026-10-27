// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDataSlice } from '../store/slices/dataSlice';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { buildCsvDataFromIntakeIr } from '../services/data/reportCsvIntake';
import { profileData } from '../services/data/dataProfiler';
import { resolveReportStructureArtifactsWithProposal } from '../services/agent/orchestration/reportStructureOrchestrator';
import { createInitialAnalysisStageExecutors } from '../services/agent/runtime/pi/initialAnalysisStageExecutors';
import { HUMAN_CONFIRMABLE_VERIFICATION_SIGNALS, resolvePipelineOutcome } from '../services/agent/pipelineOutcomeResolver';
import { createCleaningRun, updateCleaningRun } from '../services/agent/cleaningRunState';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import { describeInitialAnalysisFailure } from '../services/agent/runtime/pi/initialAnalysisFailure';
import { getPipelineOutcomeUserText, getTranslation } from '../utils/localization';
import { createTestSettings } from './testSettings';
import type { CsvData, ReportStructureResolution } from '../types';

vi.mock('../services/duckdb/queryEngine', () => ({
    primeDuckDbDataset: vi.fn().mockResolvedValue(null),
    DUCKDB_INIT_TIMEOUT_MS: 5000,
}));

// Synthetic ERP "outstanding orders" report (see fixtures/weird-reports/README.md).
const FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/weird-reports/w1_erp_outstanding.csv');
// The raw check code the review dialog used to leak into user-facing text.
const RAW_CODE = 'label_layer_retention_complete';
const SNAKE_CASE_CODE = /\b[a-z]+(?:_[a-z]+)+\b/;

const plan = {
    explanation: 'Import keeps the source rows unchanged.',
    operations: [],
    outputColumns: [],
    planStatus: 'schema_only' as const,
    consistencyIssues: [],
};

let intake: Awaited<ReturnType<typeof processCsvWithIntakeIr>>;
let rawCsvData: CsvData;
let blocked: Awaited<ReturnType<typeof resolveReportStructureArtifactsWithProposal>>;
let ordinary: { intake: typeof intake; rawCsvData: CsvData; blocked: typeof blocked };

const toBoundary = (resolution: ReportStructureResolution) => ({
    headerRowIndex: resolution.headerRowIndex,
    headerLayerRowIndexes: [...resolution.headerLayerRowIndexes],
    bodyStartIndex: resolution.bodyStartIndex,
    summaryStartIndex: resolution.summaryStartIndex,
    parameterRowIndexes: [...resolution.parameterRowIndexes],
    repeatedHeaderRowIndexes: [...resolution.repeatedHeaderRowIndexes],
});

// The app state after the first analysis attempt stopped at the structure check:
// the post-import pipeline marks the cleaning run failed with the stage error
// when the initial analysis ends in `error` (fileOrchestrator.runPostImportPipeline),
// and records that the analysis, not cleaning, caused it.
const analysisStopMarker = () => ({
    ...createCleaningRun(),
    status: 'failed' as const,
    lastError: 'Stage 5/9 failed: Structure review is required before automatic analysis.',
    failureOrigin: 'initial_analysis' as const,
});

// A failure written by the cleaning loop itself: real, with its own user text and technical detail.
const realCleaningFailure = () => ({
    ...createCleaningRun(),
    status: 'failed' as const,
    lastError: 'Cleaning loop exhausted after 3 rounds: numeric reconciliation did not match.',
    userFacingMessage: 'Cleaning could not be verified.',
    technicalDetail: 'rounds=3; reconciliation delta 12.5',
    shouldAutoResume: false,
});

const createStore = (initialCleaningRun: Record<string, unknown> = analysisStopMarker(), fixture = ordinary) => {
    const { intake, rawCsvData, blocked } = fixture;
    let state: Record<string, any> = {
        sessionId: 'session-test',
        currentDatasetId: 'dataset-test',
        settings: createTestSettings(),
        progressMessages: [],
        csvData: intake.csvData,
        rawCsvData,
        rawIntakeIr: intake.intakeIr,
        reportStructureResolution: blocked.reportStructureResolution,
        canonicalCsvData: blocked.canonicalCsvData,
        canonicalBuildMeta: blocked.canonicalBuildMeta,
        canonicalizationStatus: blocked.canonicalizationStatus,
        pipelineOutcome: blocked.pipelineOutcome,
        dataPreparationPlan: plan,
        cleaningRun: initialCleaningRun,
        columnProfiles: profileData(intake.csvData.data).profiles,
        datasetSemanticSnapshot: null,
        semanticStatus: 'idle',
        semanticDatasetVersion: null,
        duckDbSessionStatus: { status: 'idle' },
        activeDataQuery: null,
        confirmedAnalysisGoal: null,
        analysisCards: [],
        finalSummary: null,
        addProgress: vi.fn(),
        logAgentToolUsage: vi.fn(),
        recordAgentEvent: vi.fn(),
        setIsReportBoundaryConfirmModalOpen: vi.fn(),
    };
    const setState = (update: Record<string, unknown> | ((current: typeof state) => Record<string, unknown>)) => {
        state = { ...state, ...(typeof update === 'function' ? update(state) : update) };
    };
    const getState = () => state;
    state = { ...state, ...createDataSlice(setState as never, getState as never, {} as never) };
    state.ensureDatasetSemanticSnapshot = vi.fn().mockResolvedValue(null);
    state.handleInitialAnalysis = vi.fn().mockResolvedValue({ status: 'ready' });
    state.proposeAnalysisGoals = vi.fn().mockResolvedValue(undefined);
    // The slice's own addProgress is replaced by the real one; capture the user-facing log instead.
    const progress: string[] = [];
    state.addProgress = (text: string) => { progress.push(text); };
    return { getState, setState, progress };
};

beforeAll(async () => {
    const text = fs.readFileSync(FIXTURE, 'utf8');
    const file = { name: 'w1_erp_outstanding.csv', size: text.length, text: async () => text } as unknown as File;
    intake = await processCsvWithIntakeIr(file);
    rawCsvData = buildCsvDataFromIntakeIr(intake.intakeIr);
    blocked = await resolveReportStructureArtifactsWithProposal({
        rawCsvData,
        csvData: intake.csvData,
        rawIntakeIr: intake.intakeIr,
        cleaningRun: null,
        dataPreparationPlan: plan,
        columnProfiles: profileData(intake.csvData.data).profiles,
        settings: createTestSettings(),
    });
    // Legacy boundary/cleaning-marker behavior still applies to ordinary unchanged CSVs.
    // ERP raw anomalies now require the automatic scan/repair path, tested separately below.
    const cleanFile = new File(['Entity,Category,Quantity,Amount\n' + Array.from({ length: 40 }, (_, i) => `Item ${i},Group ${i % 3},${i + 1},${(i + 1) * 10}\n`).join('')], 'ordinary.csv');
    const cleanIntake = await processCsvWithIntakeIr(cleanFile);
    const cleanRaw = buildCsvDataFromIntakeIr(cleanIntake.intakeIr);
    const cleanArtifacts = await resolveReportStructureArtifactsWithProposal({
        rawCsvData: cleanRaw, csvData: cleanIntake.csvData, rawIntakeIr: cleanIntake.intakeIr,
        cleaningRun: null, dataPreparationPlan: plan, columnProfiles: profileData(cleanIntake.csvData.data).profiles, settings: createTestSettings(),
    });
    ordinary = { intake: cleanIntake, rawCsvData: cleanRaw, blocked: cleanArtifacts };
});

describe('human structure confirmation and full-source ERP scan safety', () => {
    it('recognizes ERP deterministic intake without treating preview readiness as full-source authorization', () => {
        // Intake still recognizes the ERP report. Full-source scan authorization is tested
        // independently below; ordinary boundary tests retain the cleaning-marker regression.
        expect(blocked.pipelineOutcome).toMatchObject({ status: 'ready', canAutoAnalyze: true });
        expect(blocked.pipelineOutcome?.message ?? '').not.toMatch(SNAKE_CASE_CODE);
    });

    it('starts ordinary analysis after confirmation even though a blocked attempt left the cleaning run failed', async () => {
        const { getState, setState, progress } = createStore();
        const boundary = toBoundary(getState().reportStructureResolution!);

        await getState().saveReportStructureBoundaryOverride(boundary);

        expect(getState().reportStructureResolution.source).toBe('human_confirmed');
        expect(getState().pipelineOutcome, JSON.stringify(getState().pipelineOutcome)).toMatchObject({ status: 'ready', canAutoAnalyze: true });
        expect(getState().handleInitialAnalysis).toHaveBeenCalledTimes(1);
        // Continue cleaning must keep working: the earlier failure and its text are not rewritten.
        expect(getState().cleaningRun).toMatchObject({ status: 'failed', lastError: analysisStopMarker().lastError });
        expect(progress.join(' ')).not.toMatch(SNAKE_CASE_CODE);

        // The stage gate of the analysis run that follows must pass on the confirmed state.
        const executors = createInitialAnalysisStageExecutors();
        const context = {
            request: { appSessionId: 's', datasetId: 'd', datasetVersion: 'v', researchGoal: 'g', provider: {} },
            store: { getState, setState },
            signal: new AbortController().signal,
        } as never;
        expect((await executors['dataset.profileStructure'](context, {})).decision).toBe('pass');
        const gate = await executors['dataset.validatePreparedData'](context, {});
        expect(gate.decision).toBe('pass');
        expect(gate.warningCodes).toEqual([]);
    });

    it('does not let legacy confirmation publish ERP data when the original full scan finds anomalies', async () => {
        const store = createStore(analysisStopMarker(), { intake, rawCsvData, blocked });
        try {
            const metadata = await captureCsvSource(store as never, new File([fs.readFileSync(FIXTURE)], 'w1_erp_outstanding.csv'));
            store.setState({ datasetBundle: { source: { inspection: metadata } } });
            const canonicalBefore = store.getState().canonicalCsvData;
            await expect(store.getState().saveReportStructureBoundaryOverride(toBoundary(blocked.reportStructureResolution!))).rejects.toThrow('source_scan_requires_automatic_repair_or_resume');
            expect(store.getState().handleInitialAnalysis).not.toHaveBeenCalled();
            expect(store.getState().canonicalCsvData).toBe(canonicalBefore);
            expect(store.getState().csvSourceScan.status).toBe('completed_anomalies');
            expect(store.getState().csvSourceScan.bytesRead).toBe(metadata.byteSize);
            expect(store.getState().csvSourceScan.parsingCoverage).toBe('complete');
            expect(store.getState().csvSourceScan.schemaConfidence).toBe('uncertain');
            expect(store.getState().csvSourceScan.counts.repeated_header).toBeGreaterThan(0);
            // Original ERP positive repair/acceptance qualification remains pending the coordinator,
            // not replaced by the ordinary cleaning-marker tests above.
            expect(store.getState().datasetBundle.acceptedCommit).toBeUndefined();
        } finally { beginSessionTransition(store as never); }
    });

    it('explains a block that confirmation cannot clear in plain words and keeps the code out of the text', () => {
        const outcome = { status: 'needs_structure_review', reasonCode: RAW_CODE };
        const english = getPipelineOutcomeUserText(outcome, 'English')!;
        expect(english).toContain('confirm the table structure');
        expect(english).toContain(getTranslation('structure_review_reason_label_layer_retention_complete', 'English'));
        for (const language of ['English', 'Mandarin', 'Japanese', 'Malay']) {
            const text = getPipelineOutcomeUserText(outcome, language)!;
            expect(text).not.toContain(RAW_CODE);
            expect(text).not.toMatch(SNAKE_CASE_CODE);
        }

        // The stage failure text built from a blocked "Quality" stage result.
        const translate = (key: string, params?: Record<string, string | number>) => getTranslation(key, 'English', params);
        const failure = describeInitialAnalysisFailure({
            results: [{
                decision: 'fail',
                toolName: 'dataset.validatePreparedData',
                summary: blocked.pipelineOutcome!.message,
                warningCodes: [RAW_CODE],
                artifactRefs: ['pipeline-outcome:needs_structure_review'],
            }],
            errorText: '',
            stageNames: ['dataset.profileStructure', 'dataset.detectNoiseRows', 'dataset.suggestCleaningPlan', 'dataset.applyTransform', 'dataset.validatePreparedData'],
            translate,
        });
        expect(failure).toContain('Quality');
        expect(failure).toContain(getTranslation('structure_review_reason_label_layer_retention_complete', 'English'));
        expect(failure).not.toMatch(SNAKE_CASE_CODE);
    });
});

describe('what a human-confirmed structure may and may not clear', () => {
    const confirmed = {
        source: 'human_confirmed',
        requiresHumanReview: false,
        blockingReasons: [RAW_CODE],
        decision: { targetShape: 'row_table', shouldCanonicalize: true, reason: 'Structure resolved as row_table.' },
    } as unknown as ReportStructureResolution;
    const resolve = (signalKey: string) => resolvePipelineOutcome({
        reportStructureResolution: confirmed,
        intakeGuard: { shouldBlockAutomaticAnalysis: false, severity: 'clear' },
        cleaningRun: null,
        verificationReport: { passed: false, signalKey },
        hasCanonicalData: true,
    });

    it.each([...HUMAN_CONFIRMABLE_VERIFICATION_SIGNALS])('does not block a confirmed structure on %s', signalKey => {
        expect(resolve(signalKey).canAutoAnalyze).toBe(true);
    });

    it('still blocks on a signal nobody declared confirmable, and says why without the code', () => {
        const outcome = resolve('numeric_total_preserved');
        expect(outcome).toMatchObject({ status: 'blocked_by_shape_verification', canAutoAnalyze: false });
        expect(outcome.message).not.toMatch(SNAKE_CASE_CODE);
        const text = getPipelineOutcomeUserText(outcome, 'English')!;
        expect(text).toContain('did not pass');
        expect(text).not.toMatch(SNAKE_CASE_CODE);
    });

    it('still blocks a confirmed structure when the import check found parse errors', () => {
        const outcome = resolvePipelineOutcome({
            reportStructureResolution: confirmed,
            intakeGuard: {
                shouldBlockAutomaticAnalysis: true,
                blockingReasonCode: 'parse_errors',
                analysisBlockedMessage: 'Parsing errors were detected.',
                severity: 'blocked',
            },
            cleaningRun: null,
            verificationReport: null,
            hasCanonicalData: true,
        });
        expect(outcome).toMatchObject({ status: 'blocked_by_intake', canAutoAnalyze: false });
        expect(getPipelineOutcomeUserText(outcome, 'English')).not.toMatch(SNAKE_CASE_CODE);
    });
});

describe('a real cleaning failure is not mistaken for the analysis-stop marker', () => {
    it('keeps blocking a confirmation, starts nothing and leaves the failure text and detail alone', async () => {
        const { getState } = createStore(realCleaningFailure());
        const before = structuredClone(realCleaningFailure());
        await getState().saveReportStructureBoundaryOverride(toBoundary(getState().reportStructureResolution!));

        expect(getState().pipelineOutcome).toMatchObject({ status: 'cleaning_failed', canAutoAnalyze: false });
        expect(getState().handleInitialAnalysis).not.toHaveBeenCalled();
        const after = getState().cleaningRun;
        expect(after).toMatchObject({
            status: 'failed',
            lastError: before.lastError,
            userFacingMessage: before.userFacingMessage,
            technicalDetail: before.technicalDetail,
        });
    });

    it('only the analysis-stop marker lets the structure gate through', () => {
        const confirmed = {
            source: 'human_confirmed', requiresHumanReview: false, blockingReasons: [],
            decision: { targetShape: 'row_table', shouldCanonicalize: true, reason: '' },
        } as unknown as ReportStructureResolution;
        const resolve = (cleaningRun: Record<string, unknown>) => resolvePipelineOutcome({
            reportStructureResolution: confirmed,
            intakeGuard: { shouldBlockAutomaticAnalysis: false, severity: 'clear' },
            cleaningRun: cleaningRun as never,
            verificationReport: null,
            hasCanonicalData: true,
        });
        expect(resolve(analysisStopMarker()).canAutoAnalyze).toBe(true);
        expect(resolve(realCleaningFailure())).toMatchObject({ status: 'cleaning_failed', canAutoAnalyze: false });
    });

    it('drops the marker on any later update of the run, so a new failure is judged on its own', () => {
        const marked = analysisStopMarker();
        expect(updateCleaningRun(marked, { lastError: 'Cleaning failed for real.' }).failureOrigin).toBeNull();
        expect(updateCleaningRun(marked, { failureOrigin: 'initial_analysis' }).failureOrigin).toBe('initial_analysis');
    });
});
