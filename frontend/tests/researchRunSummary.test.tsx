import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ResearchRunSummary } from '../components/analysis-panel/ResearchRunSummary';
import { createDataAnalysisSessionState } from '../services/agent/runtime/dataAnalysisSessionState';
import { useAppStore } from '../store/useAppStore';

describe('ResearchRunSummary', () => {
    afterEach(cleanup);

    it('shows the version-bound brief and evidence classification', () => {
        const base = createDataAnalysisSessionState({
            sessionId: 'session-1',
            origin: 'auto_analysis',
        });
        render(<ResearchRunSummary session={{
            ...base,
            status: 'completed',
            stopReason: 'all_hypotheses_exhausted',
            researchBrief: {
                goal: 'Find revenue drivers',
                datasetVersionId: 'version-123',
                questions: [{
                    id: 'question-1',
                    hypothesisId: 'hyp-1',
                    question: 'Which region has the highest revenue?',
                    priority: 3,
                    status: 'supported',
                }],
                stopConditions: ['all_hypotheses_exhausted'],
                clarification: null,
                createdAt: new Date('2026-07-25T00:00:00Z'),
            },
            researchFindings: [{
                id: 'finding-1',
                questionId: 'question-1',
                hypothesisId: 'hyp-1',
                claim: 'North has the highest revenue.',
                status: 'supported',
                evidenceRefs: [{ kind: 'query', ref: 'query-1' }],
                reasonCodes: [],
            }],
        }} />);

        expect(screen.getByRole('region', { name: 'Research run' })).toBeInTheDocument();
        expect(screen.getByText('Find revenue drivers')).toBeInTheDocument();
        expect(screen.getByText(/version-123/)).toBeInTheDocument();
        expect(screen.getByText('Which region has the highest revenue?')).toBeInTheDocument();
        expect(screen.getByText('1 supported')).toBeInTheDocument();
        expect(screen.getByText('Technical details')).toBeInTheDocument();
        expect(screen.getByText('all_hypotheses_exhausted')).toBeInTheDocument();
    });

    it('surfaces the clarification boundary', () => {
        const base = createDataAnalysisSessionState({
            sessionId: 'session-1',
            origin: 'auto_analysis',
        });
        render(<ResearchRunSummary session={{
            ...base,
            status: 'degraded',
            researchBrief: {
                goal: 'Analyze the report',
                datasetVersionId: null,
                questions: [],
                stopConditions: [],
                clarification: {
                    reason: 'No safe business grain was verified.',
                    question: 'Which business grain or metric should the research run prioritize?',
                },
                createdAt: new Date('2026-07-25T00:00:00Z'),
            },
        }} />);

        expect(screen.getByText('Clarification needed')).toBeInTheDocument();
        expect(screen.getByText('Which business grain or metric should the research run prioritize?')).toBeInTheDocument();
        expect(screen.getByText('No safe business grain was verified.')).toBeInTheDocument();
    });
    const sessionWith = (statuses: string[], findingStatuses: string[]) => {
        const base = createDataAnalysisSessionState({ sessionId: 'session-1', origin: 'auto_analysis' });
        return {
            ...base,
            status: 'completed' as const,
            researchBrief: {
                goal: 'Summarize key patterns',
                datasetVersionId: null,
                questions: statuses.map((status, index) => ({
                    id: `q-${index}`, hypothesisId: `h-${index}`, question: `Question ${index + 1}`, priority: 4 - index, status,
                })) as never,
                stopConditions: [],
                clarification: null,
                createdAt: new Date('2026-07-25T00:00:00Z'),
            },
            researchFindings: findingStatuses.map((status, index) => ({
                id: `f-${index}`, questionId: `q-${index}`, hypothesisId: `h-${index}`, claim: `Claim ${index}`,
                status: status as never, evidenceRefs: [], reasonCodes: [],
            })),
        };
    };

    it('counts what the question rows say: a "Not supported" row is never "need review" in the pills', () => {
        render(<ResearchRunSummary session={sessionWith(
            ['supported', 'supported', 'unsupported', 'supported'],
            ['supported', 'supported', 'hypothesis', 'supported'],
        )} />);

        expect(screen.getByText('3 supported')).toBeInTheDocument();
        expect(screen.getByText('1 not supported')).toBeInTheDocument();
        expect(screen.queryByText(/need review/)).not.toBeInTheDocument();
        expect(screen.getAllByText('Not supported')).toHaveLength(1);
    });

    it('hides pills with a zero count', () => {
        render(<ResearchRunSummary session={sessionWith(['supported', 'supported'], ['supported', 'supported'])} />);

        expect(screen.getByText('2 supported')).toBeInTheDocument();
        expect(screen.queryByText(/not supported|need review|not answered/)).not.toBeInTheDocument();
        expect(screen.queryByText(/^0 /)).not.toBeInTheDocument();
    });

    it('explains a not-supported question in one plain line, in every language', () => {
        const expected: Record<string, string> = {
            English: 'The data did not allow this calculation.',
            Mandarin: '这份数据无法完成此项计算。',
            Japanese: 'このデータではこの計算ができませんでした。',
            Malay: 'Data ini tidak membenarkan pengiraan ini.',
        };
        for (const [language, text] of Object.entries(expected)) {
            useAppStore.setState({ settings: { ...useAppStore.getState().settings, language: language as never } });
            const { unmount } = render(<ResearchRunSummary session={sessionWith(['supported', 'unsupported'], ['supported', 'hypothesis'])} />);
            expect(screen.getAllByText(text)).toHaveLength(1);
            unmount();
        }
        useAppStore.setState({ settings: { ...useAppStore.getState().settings, language: 'English' } });
    });

    it('shows unanswered questions of a finished run as their own pill', () => {
        render(<ResearchRunSummary session={sessionWith(['supported', 'pending'], ['supported', 'hypothesis'])} />);

        expect(screen.getByText('1 not answered')).toBeInTheDocument();
        expect(screen.queryByText(/not supported/)).not.toBeInTheDocument();
    });
});
