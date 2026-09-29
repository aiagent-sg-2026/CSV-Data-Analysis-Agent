import { describe, expect, it } from 'vitest';
import type { AppStore } from '../store/useAppStore';
import {
    canRestoreHistoryAnalysis,
    captureHistoryAnalysisSnapshot,
    getRestoredHistoryAnalysisState,
} from '../services/agent/orchestration/historyAnalysisRestore';

const savedState = {
    csvData: null,
    datasetBundle: { datasetVersion: 'prepared-version' },
    initialAnalysisStatus: 'ready',
    cleaningRun: { status: 'completed' },
    analysisCards: [{ id: 'saved-card', provenance: { datasetVersion: 'source-version' } }],
    reportMemoryScope: { datasetVersion: 'source-version' },
    workspaceFiles: { report: 'saved-report' },
    finalSummary: 'Saved summary',
} as unknown as AppStore;

describe('history analysis restore', () => {
    it('keeps the prepared table version separate from analysis evidence', () => {
        const snapshot = captureHistoryAnalysisSnapshot(savedState);

        expect(snapshot?.datasetVersion).toBe('prepared-version');
        expect(snapshot?.analysisDatasetVersion).toBe('source-version');
        expect(canRestoreHistoryAnalysis(snapshot, true, 'prepared-version')).toBe(true);
        expect(canRestoreHistoryAnalysis(snapshot, true, 'source-version')).toBe(false);
        expect(canRestoreHistoryAnalysis(snapshot, false, 'prepared-version')).toBe(false);
    });

    it('does not reuse the saved analysis for an already loaded or incomplete session', () => {
        expect(captureHistoryAnalysisSnapshot({ ...savedState, csvData: {} } as AppStore)).toBeNull();
        expect(captureHistoryAnalysisSnapshot({ ...savedState, initialAnalysisStatus: 'running' } as AppStore)).toBeNull();
        expect(captureHistoryAnalysisSnapshot({ ...savedState, cleaningRun: { status: 'paused' } } as AppStore)).toBeNull();
        expect(captureHistoryAnalysisSnapshot({ ...savedState, initialAnalysisStatus: 'error', analysisCards: [] } as AppStore)).toBeNull();
    });

    it('restores completed analysis with review-only cards without marking it ready', () => {
        const reviewState = {
            ...savedState,
            initialAnalysisStatus: 'degraded',
            initialAnalysisFailureKind: null,
            finalSummary: null,
        } as AppStore;
        const snapshot = captureHistoryAnalysisSnapshot(reviewState);

        expect(snapshot?.analysisCards).toEqual(reviewState.analysisCards);
        expect(getRestoredHistoryAnalysisState(snapshot!, {}).initialAnalysisStatus).toBe('degraded');
    });

    it('preserves completed review-only cards and error status without claiming trusted results', () => {
        const reviewState = {
            ...savedState,
            initialAnalysisStatus: 'error',
            initialAnalysisFailureKind: 'analysis',
            finalSummary: null,
        } as AppStore;
        const snapshot = captureHistoryAnalysisSnapshot(reviewState);

        expect(snapshot?.analysisCards).toEqual(reviewState.analysisCards);
        expect(getRestoredHistoryAnalysisState(snapshot!, {})).toMatchObject({
            initialAnalysisStatus: 'error',
            initialAnalysisFailureKind: 'analysis',
        });
    });

    it('preserves current workspace files while restoring saved cards', () => {
        const snapshot = captureHistoryAnalysisSnapshot(savedState)!;
        const restored = getRestoredHistoryAnalysisState(snapshot, { current: 'new-file' });

        expect(restored.analysisCards).toBe(snapshot.analysisCards);
        expect(restored.workspaceFiles).toEqual({ report: 'saved-report', current: 'new-file' });
        expect(restored.initialAnalysisStatus).toBe('ready');
    });
});
