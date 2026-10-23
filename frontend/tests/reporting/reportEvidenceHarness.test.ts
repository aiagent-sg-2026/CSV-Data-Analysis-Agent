// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { runReportEvidenceHarness } from '../../services/reporting/reportEvidenceHarness';
import type { ReportCardEvidence, ReportEvidenceBundle } from '../../types';

const createCard = (overrides?: Partial<ReportCardEvidence>): ReportCardEvidence => ({
    evidenceId: 'card.card-1',
    cardId: 'card-1',
    isFallback: false,
    title: 'Sum Net Exposure by Segment',
    displayTitle: 'Sum Net Exposure by Segment',
    description: 'Compare total exposure by segment.',
    artifactType: null,
    chartType: 'bar',
    groupByColumn: 'Segment',
    valueColumn: 'Net Exposure',
    aggregation: 'sum',
    rowCount: 4,
    summary: { language: 'English', text: 'Segment A leads exposure.' },
    aggregatedDataSample: [
        { Segment: 'A', 'Net Exposure': 6000 },
        { Segment: 'B', 'Net Exposure': 3000 },
    ],
    reportChartRows: [
        { Segment: 'A', 'Net Exposure': 6000 },
        { Segment: 'B', 'Net Exposure': 3000 },
        { Segment: 'C', 'Net Exposure': 1000 },
    ],
    semanticRole: 'business_dimension',
    helperExposureLevel: 'none',
    businessMeaningConfidence: 0.9,
    aggregationQualityFlags: [],
    ...overrides,
});

const createBundle = (overrides?: {
    cards?: ReportCardEvidence[];
    trustedCardsCount?: number;
    rowExpansionRatio?: number;
}): ReportEvidenceBundle => ({
    generatedAt: '2026-03-19T10:00:00.000Z',
    sessionId: 'session-1',
    datasetId: 'dataset-1',
    currentView: null,
    dataset: {
        fileName: 'generic-quality.csv',
        reportTitle: 'Generic Exposure Report',
        rawRowCount: 100,
        cleanedRowCount: 100,
        metadataRowCount: 0,
        headerDepth: 1,
        summaryRowCount: 0,
        parserStrategy: 'auto',
        parserConfidence: 'high',
        intakeGateStatus: 'clear',
        preparationState: 'complete',
        analysisState: 'complete',
        reportReadiness: 'ready',
        reportReadinessReason: 'Ready for bounded analyst synthesis.',
        readinessDrivers: [],
        readinessRisks: [],
        structuralSignals: {
            rowExpansionRatio: overrides?.rowExpansionRatio ?? 1,
            hasMetadataRows: false,
            hasMultiRowHeader: false,
            usedFallbackContext: false,
        },
        canAnalyze: true,
        cardsCount: overrides?.cards?.length ?? 1,
        trustedCardsCount: overrides?.trustedCardsCount ?? 1,
        caveats: [],
        reportGenerationGate: 'allowed',
        reportGenerationBlockers: [],
    },
    workflow: {
        topWarnings: [],
        issueMappings: [],
        verification: null,
        diff: null,
    },
    summaries: {
        coreAnalysisSummary: null,
        finalSummary: null,
        contextualSummary: null,
    },
    query: null,
    allCards: overrides?.cards ?? [createCard()],
    cards: overrides?.cards ?? [createCard()],
    includedCardIds: ['card-1'],
    excludedCardIds: [],
    excludedEvidence: [],
    evidenceCatalog: [],
} as unknown as ReportEvidenceBundle);

describe('reportEvidenceHarness', () => {
    it('flags large unclassified share from generic null-like labels', () => {
        const card = createCard({
            reportChartRows: [
                { Segment: 'Unknown', 'Net Exposure': 4000 },
                { Segment: 'A', 'Net Exposure': 3500 },
                { Segment: 'B', 'Net Exposure': 2500 },
            ],
        });

        const result = runReportEvidenceHarness(createBundle({ cards: [card] }));

        expect(result.qualitySignals).toEqual(expect.arrayContaining([
            expect.objectContaining({
                severity: 'critical',
            }),
        ]));
        expect(result.qualitySignals.some(signal => signal.signal.includes('unclassified category'))).toBe(true);
        expect(result.narrativeThemes.some(theme => theme.includes('unclassified amount'))).toBe(true);
    });

    it('flags structural expansion and zero trusted cards using generic dataset signals', () => {
        const result = runReportEvidenceHarness(createBundle({
            trustedCardsCount: 0,
            rowExpansionRatio: 8,
        }));

        expect(result.qualitySignals).toEqual(expect.arrayContaining([
            expect.objectContaining({
                severity: 'info',
                signal: expect.stringContaining('expanded the original file by 8 times'),
            }),
            expect.objectContaining({
                severity: 'warning',
                signal: expect.stringContaining('All 1 analysis cards carry caveats'),
            }),
        ]));
    });

    describe('a ranking the query limit cut off', () => {
        const cutOff = (groupCoverage: ReportCardEvidence['groupCoverage']) => createCard({
            rowCount: 3,
            reportChartRows: [
                { Segment: 'A', 'Net Exposure': 6000 },
                { Segment: 'B', 'Net Exposure': 3000 },
                { Segment: 'C', 'Net Exposure': 1000 },
            ],
            groupCoverage,
        });

        it('takes the total, the group count and every share from the measured total over all groups', () => {
            const result = runReportEvidenceHarness(createBundle({ cards: [cutOff({ status: 'partial', groupCount: 25, overallTotal: 40_000 })] }));

            expect(result.metricProfiles[0]).toMatchObject({ total: 40_000, groupCount: 25 });
            // 6,000 of 40,000, not of the 10,000 in the three returned rows.
            expect(result.concentration?.topGroupShare).toBeCloseTo(0.15);
            expect(result.concentration?.top3Share).toBeCloseTo(0.25);
        });

        it('states no total and no share when the total over all groups could not be measured', () => {
            const result = runReportEvidenceHarness(createBundle({ cards: [cutOff({ status: 'partial', groupCount: 25, overallTotal: null })] }));

            expect(result.metricProfiles).toEqual([]);
            expect(result.concentration).toBeNull();
        });

        it('leaves a complete card as it was', () => {
            const result = runReportEvidenceHarness(createBundle({ cards: [cutOff({ status: 'complete', groupCount: 3, overallTotal: 10_000 })] }));

            expect(result.metricProfiles[0]).toMatchObject({ total: 10_000, groupCount: 3 });
            expect(result.concentration?.topGroupShare).toBeCloseTo(0.6);
        });
    });
});
