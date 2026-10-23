import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import React from 'react';
import { render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisCardData, CsvRow, SqlEvidenceQueryPlan, SqlPresentationPlan } from '../types';
import { executeDataQuery } from '../services/agent/execution/dataQueryExecutor';
import {
    buildEvidenceResultSummary,
    executePresentationPlanAndCreateCard,
} from '../services/agent/execution/sqlCardExecutor';
import { measureLeadingGroupSampleSize } from '../services/agent/planning/groupSampleSize';
import { evaluateEvidenceValue } from '../services/agent/evidenceValueGate';
import { evaluateAutoAnalysisCards } from '../services/agent/autoAnalysisEvaluation';
import { useAnalysisCardData } from '../hooks/useAnalysisCardData';
import { AnalysisCardCaveats } from '../components/analysis-card/AnalysisCardCaveats';
import * as useAppStoreModule from '../store/useAppStore';

vi.mock('../store/useAppStore', () => ({
    useAppStore: vi.fn(),
}));

/**
 * Regression for a live gpt-5.4-mini run on the public graduate-employment demo
 * data: the card asked for the schools with the LOWEST median 25th-percentile
 * pay (query ordered ascending, LIMIT 20), but the chart re-sorted the 20 rows
 * largest-first and kept 8, so it showed a block of eight schools tied at 3,000
 * from the middle of the distribution under a "Top 8 view" label.
 */

const CSV_PATH = path.resolve(process.cwd(), '../demo-data/sg-graduate-employment.csv');
const rows: CsvRow[] = Papa.parse<CsvRow>(fs.readFileSync(CSV_PATH, 'utf8'), {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
}).data;
const columns = Object.keys(rows[0]);

const LOWEST_ALIAS = 'median_gross_mthly_25_percentile';
const lowestPayPlan: SqlEvidenceQueryPlan = {
    title: 'Schools by lower-end gross monthly pay',
    queryMode: 'aggregate',
    intentSummary: 'Rank schools by the median 25th-percentile gross monthly pay; lower values first.',
    preferredResultShape: 'ranked_aggregate',
    query: {
        select: ['school', LOWEST_ALIAS],
        groupBy: ['school'],
        aggregates: [{ function: 'median', column: 'gross_mthly_25_percentile', as: LOWEST_ALIAS }],
        orderBy: [{ column: LOWEST_ALIAS, direction: 'asc' }],
        limit: 20,
    },
};

const runQuery = (plan: SqlEvidenceQueryPlan) => ({
    result: executeDataQuery(rows, plan.query, { allowedColumns: columns, maxRows: 2000 }),
});

// A school whose metric is "na" in every row has a NULL median; it is not a value of 0.
const valuesOf = (data: CsvRow[], key: string) => data.map(row => (row[key] === null || row[key] === undefined ? null : Number(row[key])));

let storeCards: AnalysisCardData[] = [];

const createCardThroughRealPath = async (evidencePlan: SqlEvidenceQueryPlan, presentation: SqlPresentationPlan) => {
    const execution = runQuery(evidencePlan);
    const profiles = [
        { name: 'school', type: 'categorical', uniqueValues: 78 },
        { name: 'gross_mthly_25_percentile', type: 'numerical' },
        { name: 'basic_monthly_median', type: 'numerical' },
    ] as never;
    const state = {
        settings: { language: 'English' },
        analysisCards: [] as AnalysisCardData[],
        columnProfiles: profiles,
        csvData: { fileName: 'sg-graduate-employment.csv', data: rows },
        progressMessages: [],
        addProgress: vi.fn(),
        recordAgentEvent: vi.fn(),
    } as any;
    const store = {
        getState: () => state,
        setState: (partial: any) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial),
    } as any;
    const summary = buildEvidenceResultSummary(evidencePlan, execution.result, profiles);
    const result = await executePresentationPlanAndCreateCard(evidencePlan, presentation, store, summary, {
        ...execution,
        execution: { engine: 'native', sqlPreview: null, tableName: null, loadVersion: null, fallbackReason: null, fallbackStage: null },
        activeDataQuery: { result: execution.result },
        queryTrace: undefined,
        binding: null,
        allowedColumns: columns,
    } as any);
    return { card: result.card!, execution };
};

describe('ranked card presentation follows the evidence query direction', () => {
    beforeEach(() => {
        storeCards = [];
        (useAppStoreModule.useAppStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
            (selector: (value: { analysisCards: AnalysisCardData[] }) => unknown) => selector({ analysisCards: storeCards }),
        );
    });

    it('shows the lowest schools, lowest first, for an ascending evidence query on the real demo CSV', async () => {
        const { card, execution } = await createCardThroughRealPath(lowestPayPlan, {
            title: 'Median Gross Mthly 25 Percentile by School',
            description: 'Rank schools by the median of gross_mthly_25_percentile; lower values first.',
            presentationMode: 'chart',
            chartType: 'horizontal_bar',
            bindings: { groupByColumn: 'school', valueColumn: LOWEST_ALIAS },
        });

        // The query itself orders before it limits: its 20 rows are the 20 lowest medians overall.
        const allMedians = valuesOf(runQuery({ ...lowestPayPlan, query: { ...lowestPayPlan.query, limit: 1000 } }).result.rows, LOWEST_ALIAS);
        const returned = valuesOf(execution.result.rows, LOWEST_ALIAS);
        expect(returned).toEqual(allMedians.slice(0, 20));
        expect(card.plan.rankDirection).toBe('asc');
        expect(card.topN).toBe(8);

        storeCards = [card];
        const { result } = renderHook(() => useAnalysisCardData(card.id));
        const shown = valuesOf(result.current.chartDataForDisplay, result.current.valueKey);

        expect(shown).toEqual(allMedians.slice(0, 8));
        expect(shown[0]).toBe(Math.min(...allMedians.filter((value): value is number => value !== null)));
        // The tie block in the middle of the distribution must not be what is shown.
        expect(shown.every(value => value === 3000)).toBe(false);
        expect(result.current.rankDirection).toBe('asc');
        expect(result.current.tiedLeadingWindow).toBeNull();
    });

    it('keeps the largest-first window for a descending evidence query', async () => {
        const descendingPlan: SqlEvidenceQueryPlan = {
            ...lowestPayPlan,
            title: 'Schools by upper-end gross monthly pay',
            query: { ...lowestPayPlan.query, orderBy: [{ column: LOWEST_ALIAS, direction: 'desc' }] },
        };
        const { card } = await createCardThroughRealPath(descendingPlan, {
            title: 'Median Gross Mthly 25 Percentile by School',
            description: 'Highest first.',
            presentationMode: 'chart',
            chartType: 'horizontal_bar',
            bindings: { groupByColumn: 'school', valueColumn: LOWEST_ALIAS },
        });
        const allMedians = valuesOf(runQuery({ ...descendingPlan, query: { ...descendingPlan.query, limit: 1000 } }).result.rows, LOWEST_ALIAS);

        storeCards = [card];
        const { result } = renderHook(() => useAnalysisCardData(card.id));

        expect(card.plan.rankDirection).toBe('desc');
        expect(valuesOf(result.current.chartDataForDisplay, result.current.valueKey)).toEqual(allMedians.slice(0, 8));
    });

    it('flags a shown window whose values are all tied instead of presenting it as a ranking', () => {
        const tiedRows = [
            ...Array.from({ length: 8 }, (_, index) => ({ school: `Tied ${index}`, median_pay: 3000 })),
            { school: 'Lower A', median_pay: 2500 },
            { school: 'Lower B', median_pay: 2000 },
            ...Array.from({ length: 10 }, (_, index) => ({ school: `Rest ${index}`, median_pay: 1000 + index })),
        ];
        const tiedCard = {
            id: 'tied-card',
            plan: {
                title: 'Median pay by school',
                description: 'Highest first.',
                chartType: 'horizontal_bar',
                aggregation: 'median',
                groupByColumn: 'school',
                valueColumn: 'median_pay',
            },
            aggregatedData: tiedRows,
            summary: { language: 'English', text: '' },
            displayChartType: 'horizontal_bar',
            isDataVisible: false,
            topN: 8,
            hideOthers: false,
            hiddenLabels: [],
        } as unknown as AnalysisCardData;
        storeCards = [tiedCard];

        const { result } = renderHook(() => useAnalysisCardData('tied-card'));
        expect(result.current.tiedLeadingWindow).toEqual({ count: 8, value: 3000, tiedGroupCount: 8, totalGroupCount: 20 });
        expect(evaluateAutoAnalysisCards([tiedCard]).cards[0].reasonCodes).toContain('tied_leading_values');

        render(<AnalysisCardCaveats tiedLeadingWindow={result.current.tiedLeadingWindow} language="English" />);
        expect(screen.getByTestId('analysis-card-caveat-tied-window').textContent)
            .toContain('All 8 shown groups share the same value (3,000.00)');

        // A window with distinct values is an ordinary ranking.
        const distinctCard = { ...tiedCard, id: 'distinct-card', aggregatedData: tiedRows.slice(7) } as AnalysisCardData;
        storeCards = [distinctCard];
        const distinct = renderHook(() => useAnalysisCardData('distinct-card'));
        expect(distinct.result.current.tiedLeadingWindow).toBeNull();
        expect(evaluateAutoAnalysisCards([distinctCard]).cards[0].reasonCodes).not.toContain('tied_leading_values');
    });
});

describe('small-group leaders carry a visible caveat', () => {
    const BASIC_ALIAS = 'typical_basic_monthly_pay';
    const basicPayPlan: SqlEvidenceQueryPlan = {
        title: 'Typical basic monthly pay by school',
        queryMode: 'aggregate',
        intentSummary: 'Rank schools by the median of basic_monthly_median.',
        query: {
            select: ['school', BASIC_ALIAS],
            groupBy: ['school'],
            aggregates: [{ function: 'median', column: 'basic_monthly_median', as: BASIC_ALIAS }],
            orderBy: [{ column: BASIC_ALIAS, direction: 'desc' }],
            limit: 20,
        },
    };

    const gateFor = (
        plan: SqlEvidenceQueryPlan,
        evidenceResult: ReturnType<typeof runQuery>['result'],
        caveat: Awaited<ReturnType<typeof measureLeadingGroupSampleSize>>,
    ) =>
        evaluateEvidenceValue({
            semanticUnderstanding: {
                businessGrains: ['school'], candidateMetrics: ['basic_monthly_median'], timeGrains: [], helperDimensions: [],
                blockedDimensions: [], detailRowPolicy: 'preserve_all_rows', businessGlossary: [],
                businessGrainConfidence: 'high', unsafeForBusinessNarrative: false,
            },
            evidencePlan: plan,
            evidenceSummary: buildEvidenceResultSummary(plan, evidenceResult, [
                { name: 'school', type: 'categorical' },
                { name: 'university', type: 'categorical' },
            ] as never),
            sampleSizeCaveat: caveat,
        });

    it('caveats a leader computed from two rows on the real demo CSV and keeps it out of the trusted headline', async () => {
        const evidence = runQuery(basicPayPlan);
        const companionTitles: string[] = [];
        const caveat = await measureLeadingGroupSampleSize(basicPayPlan, evidence.result.rows, async checkPlan => {
            companionTitles.push(checkPlan.title);
            expect(checkPlan.query.aggregates).toEqual([{ function: 'count', as: 'sample_size_rows' }]);
            return runQuery(checkPlan);
        });

        expect(companionTitles).toEqual(['Sample size check for Typical basic monthly pay by school']);
        expect(caveat).not.toBeNull();
        // The leader (5,881.5) rests on 2 rows, the runner-up on 3; the typical school has more.
        expect(caveat!.leaders[0]).toMatchObject({ rank: 1, rows: 2 });
        expect(caveat!.leaders[0].label).toContain('Computer Science');
        expect(caveat!.leaders.map(leader => leader.rows)).toEqual([2, 3, 2]);
        expect(caveat!.medianGroupRows).toBeGreaterThanOrEqual(5);

        const gate = gateFor(basicPayPlan, evidence.result, caveat);
        expect(gate.decision).toBe('pass');
        expect(gate.reasonCodes).toContain('small_group_leader');
        expect(gate.sampleSizeCaveat).toEqual(caveat);
        expect(gate.detail).toContain('Leading groups rest on very few rows');

        const card = {
            id: 'basic-pay',
            plan: { title: 'Typical Basic Monthly Pay by School', description: '', chartType: 'horizontal_bar', aggregation: 'median', groupByColumn: 'school', valueColumn: BASIC_ALIAS },
            aggregatedData: evidence.result.rows,
            summary: { language: 'English', text: '' },
            displayChartType: 'horizontal_bar', isDataVisible: false, topN: 8, hideOthers: false, hiddenLabels: [],
            evidenceValueGate: { ...gate, evaluatedAt: 'now', source: 'evidence_value_gate_v1' },
        } as unknown as AnalysisCardData;
        const evaluation = evaluateAutoAnalysisCards([card]).cards[0];
        expect(evaluation.reasonCodes).toContain('small_sample_leader');
        expect(evaluation.verdict).toBe('caveated');

        render(<AnalysisCardCaveats sampleSizeCaveat={gate.sampleSizeCaveat} language="English" />);
        const text = screen.getByTestId('analysis-card-caveat-small-group').textContent ?? '';
        expect(text).toMatch(/Computer Science \* \(rank 1\) is based on only 2 rows\./);
        expect(text).toContain(`The median group has ${caveat!.medianGroupRows} rows`);
    });

    it('does not caveat leaders that rest on adequate rows', async () => {
        const UNIVERSITY_ALIAS = 'typical_gross_monthly_pay';
        const universityPlan: SqlEvidenceQueryPlan = {
            title: 'Typical gross monthly pay by university',
            queryMode: 'aggregate',
            intentSummary: 'Rank universities by the median of gross_monthly_median.',
            query: {
                groupBy: ['university'],
                aggregates: [{ function: 'median', column: 'gross_monthly_median', as: UNIVERSITY_ALIAS }],
                orderBy: [{ column: UNIVERSITY_ALIAS, direction: 'desc' }],
                limit: 20,
            },
        };
        const evidence = runQuery(universityPlan);
        const caveat = await measureLeadingGroupSampleSize(universityPlan, evidence.result.rows, async checkPlan => runQuery(checkPlan));

        expect(caveat).toBeNull();
        const gate = gateFor(universityPlan, evidence.result, caveat);
        expect(gate.reasonCodes).not.toContain('small_group_leader');
        expect(gate.sampleSizeCaveat).toBeUndefined();
        const { container } = render(<AnalysisCardCaveats sampleSizeCaveat={gate.sampleSizeCaveat} language="English" />);
        expect(container).toBeEmptyDOMElement();
    });
});
