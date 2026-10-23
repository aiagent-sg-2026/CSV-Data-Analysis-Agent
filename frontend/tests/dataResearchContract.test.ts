import { describe, expect, it } from 'vitest';
import {
    buildDataResearchBrief,
    buildDataResearchFindings,
    syncDataResearchBrief,
    tallyResearchQuestions,
} from '../services/agent/runtime/dataResearchContract';
import { createDataAnalysisSessionState } from '../services/agent/runtime/dataAnalysisSessionState';
import type { DataAnalysisHypothesis } from '../types';

const hypotheses: DataAnalysisHypothesis[] = [
    {
        id: 'hyp-supported',
        topic: 'Which region has the highest revenue?',
        grain: 'Region',
        metric: 'Revenue',
        filterIntent: null,
        comparisonIntent: 'rank regions',
        priority: 2,
        attemptsUsed: 1,
        status: 'accepted',
    },
    {
        id: 'hyp-unsupported',
        topic: 'Does discount explain margin?',
        grain: 'Discount',
        metric: 'Margin',
        filterIntent: null,
        comparisonIntent: 'relationship',
        priority: 1,
        attemptsUsed: 1,
        status: 'rejected',
    },
];

describe('data research contract', () => {
    it('builds a finite version-bound research brief', () => {
        const brief = buildDataResearchBrief({
            goal: 'Find commercial drivers',
            datasetVersionId: 'version-123',
            hypotheses,
        });

        expect(brief).toMatchObject({
            goal: 'Find commercial drivers',
            datasetVersionId: 'version-123',
            clarification: null,
        });
        expect(brief.questions.map(question => question.question)).toEqual([
            'Which region has the highest revenue?',
            'Does discount explain margin?',
        ]);
        expect(brief.stopConditions).toContain('step_budget_exhausted');
        expect(brief.stopConditions).toContain('user_cancelled');
    });

    it('keeps supported claims linked to query, card, and step evidence', () => {
        const base = createDataAnalysisSessionState({
            sessionId: 'session-1',
            origin: 'auto_analysis',
            runId: 'research-1',
        });
        const session = {
            ...base,
            status: 'completed' as const,
            hypotheses,
            researchBrief: buildDataResearchBrief({
                goal: 'Find commercial drivers',
                datasetVersionId: 'version-123',
                hypotheses,
            }),
            acceptedOutputs: [{
                cardId: 'card-1',
                querySignature: 'query-1',
                semanticSignature: 'semantic-1',
                sourceHypothesisId: 'hyp-supported',
                sourceStepIds: ['step-1'],
                valueDecision: 'pass' as const,
                presentationMode: 'chart' as const,
            }],
            rejectedOutputs: [{
                querySignature: 'query-2',
                semanticSignature: 'semantic-2',
                reason: 'weak_relationship',
                sourceHypothesisId: 'hyp-unsupported',
                sourceStepIds: ['step-2'],
                valueReasonCodes: ['weak_relationship'],
            }],
        };

        const findings = buildDataResearchFindings(session);
        const supported = findings.find(finding => finding.hypothesisId === 'hyp-supported');
        const rejected = findings.find(finding => finding.hypothesisId === 'hyp-unsupported');

        expect(supported).toMatchObject({
            claim: 'Which region has the highest revenue?',
            status: 'supported',
        });
        expect(supported?.evidenceRefs).toEqual(expect.arrayContaining([
            { kind: 'query', ref: 'query-1' },
            { kind: 'card', ref: 'card-1' },
            { kind: 'step', ref: 'step-1' },
        ]));
        expect(rejected).toMatchObject({
            claim: 'Does discount explain margin?',
            status: 'rejected',
            reasonCodes: ['weak_relationship'],
        });

        const synced = syncDataResearchBrief({
            ...session,
            researchFindings: findings,
        });
        expect(synced.researchBrief?.questions.map(question => question.status)).toEqual([
            'supported',
            'unsupported',
        ]);
    });

    it('labels an untested claim as a hypothesis with no fabricated evidence', () => {
        const base = createDataAnalysisSessionState({
            sessionId: 'session-1',
            origin: 'auto_analysis',
        });
        const session = {
            ...base,
            status: 'cancelled' as const,
            hypotheses: [hypotheses[0]],
            researchBrief: buildDataResearchBrief({
                goal: 'Find commercial drivers',
                datasetVersionId: 'version-123',
                hypotheses: [hypotheses[0]],
            }),
        };

        expect(buildDataResearchFindings(session)).toEqual([
            expect.objectContaining({
                claim: hypotheses[0].topic,
                status: 'hypothesis',
                evidenceRefs: [],
                reasonCodes: ['user_cancelled'],
            }),
        ]);
    });

    it('records the clarification boundary when no safe question exists', () => {
        const brief = buildDataResearchBrief({
            goal: 'Analyze the report',
            datasetVersionId: 'version-123',
            hypotheses: [],
            clarificationReason: 'No safe business grain was verified.',
        });

        expect(brief.questions).toEqual([]);
        expect(brief.clarification).toEqual({
            reason: 'No safe business grain was verified.',
            question: 'Which business grain or metric should the research run prioritize?',
        });
    });
    describe('tallyResearchQuestions', () => {
        const sessionWith = (statuses: Array<'pending' | 'investigating' | 'supported' | 'unsupported' | 'cancelled'>, status: 'running' | 'completed' = 'completed') => {
            const base = createDataAnalysisSessionState({ sessionId: 'session-1', origin: 'auto_analysis' });
            return {
                ...base,
                status,
                researchBrief: {
                    goal: 'Find drivers',
                    datasetVersionId: null,
                    questions: statuses.map((questionStatus, index) => ({
                        id: `q-${index}`, hypothesisId: `h-${index}`, question: `Question ${index}`, priority: 1, status: questionStatus,
                    })),
                    stopConditions: [],
                    clarification: null,
                    createdAt: new Date('2026-07-25T00:00:00Z'),
                },
            };
        };

        it('counts the statuses the research strip lists, so strip and banner share one count', () => {
            expect(tallyResearchQuestions(sessionWith(['supported', 'supported', 'supported', 'unsupported'])))
                .toEqual({ total: 4, supported: 3, notSupported: 1, unanswered: 0 });
        });

        it('counts questions left open once the run is over, but not while it is still running', () => {
            expect(tallyResearchQuestions(sessionWith(['supported', 'pending', 'investigating', 'cancelled'])))
                .toEqual({ total: 4, supported: 1, notSupported: 0, unanswered: 3 });
            expect(tallyResearchQuestions(sessionWith(['supported', 'pending', 'investigating'], 'running')))
                .toEqual({ total: 3, supported: 1, notSupported: 0, unanswered: 0 });
        });

        it('has no tally without a brief or without questions', () => {
            expect(tallyResearchQuestions(null)).toBeNull();
            expect(tallyResearchQuestions(sessionWith([]))).toBeNull();
        });
    });
});
