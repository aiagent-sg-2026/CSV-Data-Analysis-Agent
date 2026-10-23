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
import { createCleaningRun, retireFailedCleaningRun } from '../services/agent/cleaningRunState';
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
// when the initial analysis ends in `error` (fileOrchestrator.runPostImportPipeline).
const createStore = () => {
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
        cleaningRun: {
            ...createCleaningRun(),
            status: 'failed',
            lastError: 'Stage 5/9 failed: Structure review is required before automatic analysis.',
        },
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
});

describe('human structure confirmation on the ERP outstanding-orders report', () => {
    it('needs no review on the first pass once body noise and folded header layers are handled, and shows no raw code', () => {
        // Before the intake fixes this report stopped at structure review (page-break rows, subtotals and a
        // two-row header). The confirm tests below still start from this resolution's own boundary, so they
        // cover the stale-failed-cleaning-run path whether or not a review was needed.
        expect(blocked.pipelineOutcome).toMatchObject({ status: 'ready', canAutoAnalyze: true });
        expect(blocked.pipelineOutcome?.message ?? '').not.toMatch(SNAKE_CASE_CODE);
    });

    it('starts the analysis after the user confirms, even though the blocked attempt left the cleaning run failed', async () => {
        const { getState, setState, progress } = createStore();
        const boundary = toBoundary(blocked.reportStructureResolution!);

        await getState().saveReportStructureBoundaryOverride(boundary);

        expect(getState().reportStructureResolution.source).toBe('human_confirmed');
        expect(getState().pipelineOutcome).toMatchObject({ status: 'ready', canAutoAnalyze: true });
        expect(getState().cleaningRun.status).not.toBe('failed');
        expect(getState().handleInitialAnalysis).toHaveBeenCalledTimes(1);
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

describe('retiring a stale cleaning failure', () => {
    it('clears only a failed run', () => {
        const failed = { ...createCleaningRun(), status: 'failed' as const, lastError: 'boom', userFacingMessage: 'boom' };
        const cleared = retireFailedCleaningRun(failed)!;
        expect(cleared.status).toBe('idle');
        expect(cleared.lastError).toBeNull();
        expect(cleared.userFacingMessage).toBeNull();

        const completed = { ...createCleaningRun(), status: 'completed' as const };
        expect(retireFailedCleaningRun(completed)).toBe(completed);
        expect(retireFailedCleaningRun(null)).toBeNull();
    });
});
