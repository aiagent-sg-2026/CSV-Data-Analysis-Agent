// An empty or failed AI final summary must not be shown as "Verified evidence".
// The real transport run produced "No final summary generated." under that
// badge: an errored response stream settled as empty text, and the empty text
// became a placeholder summary stored with the cards' verified provenance.

import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AnalysisArtifactProvenance, AnalysisCardData, CsvRow } from '../types';
import { FinalSummary } from '../components/FinalSummary';
import { streamGenerateText } from '../services/ai/streamGenerateText';
import { generateAllSummaries } from '../services/agent/execution/summaryManager';

const aiServiceMocks = vi.hoisted(() => ({
    generateSummary: vi.fn(),
    generateCoreAnalysisSummary: vi.fn(),
    generateFinalSummary: vi.fn(),
    generateProactiveInsights: vi.fn(),
}));

vi.mock('../services/aiService', () => aiServiceMocks);

afterEach(cleanup);

const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: 0, reasoning: undefined },
};

const streamOf = (parts: LanguageModelV3StreamPart[]) => ({
    stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
            parts.forEach(part => controller.enqueue(part));
            controller.close();
        },
    }),
});

describe('streamGenerateText with an error inside the response stream', () => {
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('rejects with the streamed error instead of resolving to empty text', async () => {
        const streamedError = new Error('Demo session request limit reached');
        const model = new MockLanguageModelV3({
            doStream: async () => streamOf([
                { type: 'stream-start', warnings: [] },
                { type: 'error', error: streamedError },
                { type: 'finish', finishReason: { unified: 'error', raw: 'failed' }, usage },
            ]),
        });

        await expect(streamGenerateText({ model, messages: [{ role: 'user', content: 'Summarize.' }], maxRetries: 0 }))
            .rejects.toBe(streamedError);
    });

    it('still returns text that arrived before a late stream error', async () => {
        const model = new MockLanguageModelV3({
            doStream: async () => streamOf([
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'Partial brief' },
                { type: 'text-end', id: 't1' },
                { type: 'error', error: new Error('late failure') },
                { type: 'finish', finishReason: { unified: 'error', raw: 'failed' }, usage },
            ]),
        });

        const result = await streamGenerateText({ model, messages: [{ role: 'user', content: 'Summarize.' }], maxRetries: 0 });
        expect(result.text).toBe('Partial brief');
    });
});

const SERIES = 'Average Daily Ridership - MRT';
const verifiedProvenance = (datasetVersion: string): AnalysisArtifactProvenance => ({
    schemaVersion: 1,
    datasetId: 'transport',
    datasetVersion,
    evidenceStatus: 'verified',
    evidenceReasons: [],
    method: { operation: 'line', groupByColumns: ['Period'], aggregations: [], sourceColumns: ['Period', 'Value'], filterCount: 1, pivotRows: [], pivotColumns: [] },
    queryEvidence: null,
    evidenceRefs: [],
    createdAt: '2026-10-23T00:00:00.000Z',
});

describe('final summary when the AI returns no usable text', () => {
    let seriesRows: CsvRow[] = [];
    let canonicalCsvData: { fileName: string; data: CsvRow[] };
    let datasetVersion = '';

    beforeAll(async () => {
        const { processCsvWithIntakeIr } = await import('../services/data/csvParser');
        const { buildCsvDataFromIntakeIr } = await import('../services/data/reportCsvIntake');
        const { profileData } = await import('../services/data/dataProfiler');
        const { resolveReportStructureArtifactsWithProposal } = await import('../services/agent/orchestration/reportStructureOrchestrator');
        const { getCurrentAnalysisDatasetVersion } = await import('../services/agent/artifactProvenance');
        const { createTestSettings } = await import('./testSettings');
        const fileName = 'sg-public-transport-ridership.csv';
        const text = readFileSync(path.resolve(process.cwd(), '../demo-data', fileName), 'utf8');
        const file = ({ name: fileName, size: text.length, text: async () => text }) as unknown as File;
        const { csvData, intakeIr } = await processCsvWithIntakeIr(file);
        const artifacts = await resolveReportStructureArtifactsWithProposal({
            rawCsvData: buildCsvDataFromIntakeIr(intakeIr),
            csvData,
            rawIntakeIr: intakeIr,
            cleaningRun: null,
            dataPreparationPlan: { explanation: '', operations: [], outputColumns: [], planStatus: 'schema_only', consistencyIssues: [] },
            columnProfiles: profileData(csvData.data).profiles,
            settings: createTestSettings(),
        });
        canonicalCsvData = artifacts.canonicalCsvData!;
        datasetVersion = getCurrentAnalysisDatasetVersion({ canonicalCsvData: artifacts.canonicalCsvData!, csvData })!;
        // One value per year: the single-series trend the real run verified.
        seriesRows = canonicalCsvData.data
            .filter(row => row.DataSeries === SERIES && row.Value !== null)
            .map(row => ({ Period: row.Period, avg_value: row.Value }))
            .sort((left, right) => String(left.Period).localeCompare(String(right.Period)));
    }, 60_000);

    const seriesCard = (): AnalysisCardData => ({
        id: 'card-mrt',
        plan: {
            chartType: 'line',
            title: 'Avg Value by Period',
            description: 'Average daily MRT ridership per year.',
            groupByColumn: 'Period',
            valueColumn: 'avg_value',
            aggregation: 'avg',
            periodSeries: { periodColumn: 'Period', periodGrain: 'year', seriesName: SERIES },
        },
        aggregatedData: seriesRows,
        summary: { language: 'English', text: 'Card summary' },
        displayChartType: 'line',
        isDataVisible: false,
        topN: null,
        hideOthers: false,
        hiddenLabels: [],
        provenance: verifiedProvenance(datasetVersion),
        autoAnalysisEvaluation: { verdict: 'trusted', reasonCodes: [], detail: 'trusted', evaluatedAt: new Date().toISOString(), source: 'auto_analysis_evaluator_v1' },
    });

    const createStore = (card: AnalysisCardData) => {
        const state: any = {
            isChangingGoal: false,
            analysisCards: [card],
            columnProfiles: [],
            canonicalCsvData,
            csvData: canonicalCsvData,
            settings: { provider: 'google', geminiApiKey: 'key', openAIApiKey: '', simpleModel: 'm', complexModel: 'm', language: 'English', autoConfirmGoal: true },
            chatHistory: [],
            aiCoreAnalysisSummary: null,
            finalSummary: null,
            finalSummaryProvenance: null,
            addProgress: vi.fn(),
        };
        return {
            state,
            store: {
                getState: () => state,
                setState: (partial: any) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial),
            },
        };
    };

    beforeEach(() => {
        vi.clearAllMocks();
        aiServiceMocks.generateSummary.mockResolvedValue({ language: 'English', text: 'Card summary' });
        aiServiceMocks.generateCoreAnalysisSummary.mockResolvedValue({ language: 'English', text: 'Core summary' });
        aiServiceMocks.generateProactiveInsights.mockResolvedValue(null);
    });

    it.each([
        'No final summary generated.',
        'Failed to generate the final AI summary.',
    ])('replaces "%s" with a summary read from the verified series card', async placeholder => {
        aiServiceMocks.generateFinalSummary.mockResolvedValue({ language: 'English', text: placeholder });
        const { state, store } = createStore(seriesCard());

        await generateAllSummaries(store as never);

        const first = seriesRows[0];
        const latest = seriesRows[seriesRows.length - 1];
        expect(state.finalSummary.text).not.toContain(placeholder);
        expect(state.finalSummary.text).toContain(`**${SERIES} by year**`);
        expect(state.finalSummary.text).toContain(`in ${String(latest.Period).slice(0, 4)}, compared with`);
        expect(state.finalSummary.text).toContain(`in ${String(first.Period).slice(0, 4)}.`);
        expect(state.finalSummary.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(state.finalSummaryProvenance?.evidenceStatus).toBe('verified');
        expect(state.addProgress).toHaveBeenCalledWith(expect.stringContaining('AI final summary unavailable'), 'warning');
    });

    it('records that the summary was read from the cards, not written by the AI', async () => {
        aiServiceMocks.generateFinalSummary.mockRejectedValue(new Error('Demo session request limit reached'));
        const { state, store } = createStore(seriesCard());

        await generateAllSummaries(store as never);

        expect(state.finalSummaryProvenance?.evidenceStatus).toBe('verified');
        expect(state.finalSummaryProvenance?.narrativeSource).toBe('evidence_fallback');
    });

    it('records an AI summary that was kept as such', async () => {
        aiServiceMocks.generateFinalSummary.mockResolvedValue({ language: 'English', text: '### Key Findings\n1. MRT ridership recovered.' });
        const { state, store } = createStore(seriesCard());

        await generateAllSummaries(store as never);

        expect(state.finalSummaryProvenance?.narrativeSource).toBe('ai_summary');
    });

    it('keeps a real AI summary as written', async () => {
        aiServiceMocks.generateFinalSummary.mockResolvedValue({ language: 'English', text: '### Key Findings\n1. MRT ridership recovered.' });
        const { state, store } = createStore(seriesCard());

        await generateAllSummaries(store as never);

        expect(state.finalSummary.text).toBe('### Key Findings\n1. MRT ridership recovered.');
    });
});

describe('FinalSummary badge', () => {
    const provenance = verifiedProvenance('v1');

    it('shows no evidence badge on a placeholder summary', () => {
        render(<FinalSummary title="Overall Insights" summary={{ language: 'English', text: 'No final summary generated.' }} language="English" provenance={provenance} />);
        expect(screen.queryByText('Verified evidence')).toBeNull();
    });

    it('names a summary built from the verified cards instead of calling it verified evidence', () => {
        render(<FinalSummary
            title="Overall Insights"
            summary={{ language: 'English', text: 'The AI summary could not be generated, so these points are read directly from 4 evidence card(s).' }}
            language="English"
            provenance={{ ...provenance, narrativeSource: 'evidence_fallback' }}
        />);
        expect(screen.getByText('Built from the verified cards')).toBeInTheDocument();
        expect(screen.queryByText('Verified evidence')).toBeNull();
    });

    it('treats a deterministic count summary the same way, and localizes the badge', () => {
        render(<FinalSummary
            title="Overall Insights"
            summary={{ language: 'English', text: 'Count summary.' }}
            language="Mandarin"
            provenance={{ ...provenance, narrativeSource: 'deterministic' }}
        />);
        expect(screen.getByText('根据已验证的卡片生成')).toBeInTheDocument();
    });

    it('keeps "Verified evidence" for an AI summary and for summaries saved before the source was recorded', () => {
        const { unmount } = render(<FinalSummary title="Overall Insights" summary={{ language: 'English', text: 'MRT ridership recovered to 2.1M.' }} language="English" provenance={{ ...provenance, narrativeSource: 'ai_summary' }} />);
        expect(screen.getByText('Verified evidence')).toBeInTheDocument();
        unmount();
        render(<FinalSummary title="Overall Insights" summary={{ language: 'English', text: 'MRT ridership recovered to 2.1M.' }} language="English" provenance={provenance} />);
        expect(screen.getByText('Verified evidence')).toBeInTheDocument();
    });

    it('keeps a stale or degraded fallback summary under its own warning badge', () => {
        render(<FinalSummary
            title="Overall Insights"
            summary={{ language: 'English', text: 'Read from the cards.' }}
            language="English"
            provenance={{ ...provenance, evidenceStatus: 'degraded', narrativeSource: 'evidence_fallback' }}
        />);
        expect(screen.getByText('Degraded evidence')).toBeInTheDocument();
    });

    it('keeps the badge on a real summary', () => {
        render(<FinalSummary title="Overall Insights" summary={{ language: 'English', text: 'MRT ridership recovered to 2.1M.' }} language="English" provenance={provenance} />);
        expect(screen.getByText('Verified evidence')).toBeInTheDocument();
    });
});
