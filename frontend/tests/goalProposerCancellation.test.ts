// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { proposeAnalysisGoals } from '../services/agent/planning/goalProposer';

const mocks = vi.hoisted(() => ({
    generateAnalysisGoalCandidates: vi.fn(),
}));

vi.mock('../services/aiService', () => ({
    generateAnalysisGoalCandidates: mocks.generateAnalysisGoalCandidates,
}));
vi.mock('../services/agent/memory/cardRetrieval', () => ({ findTemplateMatches: vi.fn(async () => []) }));
vi.mock('../services/vectorStore', () => ({ vectorStore: { searchIfReady: vi.fn(async () => []) } }));
vi.mock('../services/agent/memory/analysisPatternExtractor', () => ({ formatPatternPreferences: vi.fn(() => '') }));
vi.mock('../services/agent/datasetSemantics', () => ({ getSemanticSampleRows: vi.fn(() => []) }));
vi.mock('../services/agent/analysisBrief', () => ({
    buildAnalysisIntentBrief: vi.fn(() => ({})),
    buildAnalysisRankingHints: vi.fn(() => ({})),
}));
vi.mock('../services/agent/reportContext', () => ({ resolveEffectiveReportContext: vi.fn(() => null) }));
vi.mock('../services/agent/memory/memoryScope', () => ({ resolveReportMemoryScope: vi.fn(() => null) }));

describe('change-goal proposal cancellation', () => {
    it('does not restore a goal prompt after a late provider result', async () => {
        let finishProposal: ((goals: Array<{ title: string; description: string; isRecommended: boolean }>) => void) | undefined;
        mocks.generateAnalysisGoalCandidates.mockImplementationOnce(() => new Promise(resolve => {
            finishProposal = resolve;
        }));
        const dataset = { fileName: 'sample.csv', data: [{ Town: 'North' }] };
        let state = {
            addProgress: vi.fn(),
            columnProfiles: [],
            settings: { language: 'English', complexModel: 'test-model' },
            isChangingGoal: true,
            isBusy: true,
            goalState: 'pending_ai',
            chatHistory: [{ type: 'ai_message', text: 'Existing result' }],
        } as any;
        const store = {
            getState: () => state,
            setState: (partial: any) => {
                state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
            },
        };
        const controller = new AbortController();

        const pending = proposeAnalysisGoals(dataset as never, store as never, {
            mode: 'change_goal', signal: controller.signal,
        });
        expect(mocks.generateAnalysisGoalCandidates).toHaveBeenCalledOnce();

        controller.abort();
        store.setState({ isChangingGoal: false, isBusy: false, goalState: 'confirmed' });
        finishProposal?.([{ title: 'Late goal', description: 'Should stay hidden', isRecommended: true }]);
        await pending;

        expect(state.chatHistory).toEqual([{ type: 'ai_message', text: 'Existing result' }]);
        expect(state.goalState).toBe('confirmed');
        expect(state.isBusy).toBe(false);
    });
});
