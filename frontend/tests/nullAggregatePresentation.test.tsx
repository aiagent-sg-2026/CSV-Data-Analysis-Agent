import React from 'react';
import { cleanup, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisCardData, AnalysisPlan, CsvRow, SqlEvidenceQueryPlan } from '../types';
import { initialAppState, useAppStore } from '../store/useAppStore';
import { executeDataQuery } from '../services/agent/execution/dataQueryExecutor';
import { buildEvidenceResultSummary, executePresentationPlanAndCreateCard } from '../services/agent/execution/sqlCardExecutor';
import { useAnalysisCardData } from '../hooks/useAnalysisCardData';
import { AnalysisCard } from '../components/analysis-card/AnalysisCard';
import { createChartConfig } from '../utils/chartConfigFactory';
import { formatChartDataLabel } from '../utils/chartConfigs/common';
import { applyTopNWithOthers } from '../utils/dataHelpers';
import { rankRowsByValue } from '../utils/rankedPresentation';
import { buildExecutiveKpis } from '../services/dashboard/executiveKpis';
import { evaluateAggregationQuality } from '../services/agent/execution/aggregationQuality';
import { synthesizeCrossCardInsights } from '../services/reporting/synthesizeCrossCardInsights';
import { getTranslation } from '../utils/localization';
import { buildGroundedRankedShareReply } from '../services/agent/runtime/pi/groundedQueryReply';

/**
 * Regression for a real-AI run on sg-hdb-median-rent.csv: flat type 1-RM has
 * only `na`/`-` rent cells, so its median is NULL. DuckDB returned NULL, but the
 * card "Flat types with the highest typical rent" still showed `1-RM 0.00`.
 * A NULL aggregate is "no data"; a genuine 0 must still read as 0.
 */

const chartCalls = vi.hoisted(() => [] as Array<{ dataForDisplay: CsvRow[]; plan: AnalysisPlan; displayChartType: string }>);
vi.mock('../components/analysis-card/AnalysisCardChart', () => ({
    AnalysisCardChart: (props: { dataForDisplay: CsvRow[]; plan: AnalysisPlan; displayChartType: string }) => {
        chartCalls.push({ dataForDisplay: props.dataForDisplay, plan: props.plan, displayChartType: props.displayChartType });
        return <canvas data-testid="card-chart" />;
    },
}));

// Raw rows whose median per flat type is NULL (1-RM), 2,000 (3-RM) and a real 0 (X).
const RAW_ROWS: CsvRow[] = [
    { flat_type: '1-RM', median_rent: 'na' },
    { flat_type: '1-RM', median_rent: '-' },
    { flat_type: '3-RM', median_rent: '2000' },
    { flat_type: 'X', median_rent: '0' },
];
const COLUMNS = ['flat_type', 'median_rent'];

const evidencePlan: SqlEvidenceQueryPlan = {
    title: 'Flat types with the highest typical rent',
    queryMode: 'aggregate',
    intentSummary: 'Median rent by flat type.',
    preferredResultShape: 'ranked_aggregate',
    query: {
        select: ['flat_type', 'v'],
        groupBy: ['flat_type'],
        aggregates: [{ function: 'median', column: 'median_rent', as: 'v' }],
        // A label sort keeps the NULL group first in the raw result, so every
        // view has to move it last on its own.
        orderBy: [{ column: 'flat_type', direction: 'asc' }],
        limit: 50,
    },
};

const createCardThroughRealPath = async (chartType: 'bar' | 'line' = 'bar') => {
    const result = executeDataQuery(RAW_ROWS, evidencePlan.query, { allowedColumns: COLUMNS, maxRows: 2000 });
    const profiles = [
        { name: 'flat_type', type: 'categorical', uniqueValues: 3, missingPercentage: 0 },
        { name: 'median_rent', type: 'numerical', missingPercentage: 50 },
    ] as never;
    useAppStore.setState({ columnProfiles: profiles, csvData: { fileName: 'rent.csv', data: RAW_ROWS } });
    const summary = buildEvidenceResultSummary(evidencePlan, result, profiles);
    const created = await executePresentationPlanAndCreateCard(evidencePlan, {
        title: 'Flat types with the highest typical rent',
        description: 'Median rent by flat type.',
        presentationMode: 'chart',
        chartType,
        bindings: { groupByColumn: 'flat_type', valueColumn: 'v' },
    }, useAppStore, summary, {
        result,
        execution: { engine: 'native', sqlPreview: null, tableName: null, loadVersion: null, fallbackReason: null, fallbackStage: null },
        activeDataQuery: { result },
        queryTrace: undefined,
        binding: null,
        allowedColumns: COLUMNS,
    } as never);
    return { card: created.card!, result };
};

const legendRow = (label: string) => {
    const button = screen.getAllByRole('button').find(element => element.title?.includes(label) && element.textContent?.startsWith(label));
    expect(button, `legend row for ${label}`).toBeDefined();
    return button!;
};

const bodyRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1).map(row =>
    within(row).getAllByRole('cell').map(cell => cell.textContent));

describe('a NULL aggregate is presented as no data, never 0', () => {
    beforeEach(() => {
        chartCalls.length = 0;
        useAppStore.setState({ ...initialAppState, settings: { ...initialAppState.settings, language: 'English', enableVisualEvaluation: false } });
    });
    afterEach(() => {
        cleanup();
        useAppStore.setState(initialAppState);
    });

    it('keeps NULL, 2,000 and a real 0 apart in the table, chart, sort order and summary', async () => {
        const { card, result } = await createCardThroughRealPath();
        expect(result.rows).toEqual([
            { flat_type: '1-RM', v: null },
            { flat_type: '3-RM', v: 2000 },
            { flat_type: 'X', v: 0 },
        ]);

        // Summary text: the NULL group reads "No data", the real zero reads 0.
        expect(card.summary.text).toContain('- 1-RM: No data');
        expect(card.summary.text).toContain('- 3-RM: 2000');
        expect(card.summary.text).toContain('- X: 0');
        expect(card.summary.text).not.toMatch(/1-RM: 0/);

        useAppStore.setState({ analysisCards: [{ ...card, isDataVisible: true }] });
        render(<AnalysisCard cardId={card.id} isSpotlighted />);

        // Legend rows under the chart.
        expect(within(legendRow('1-RM')).getByText('No data')).toBeInTheDocument();
        expect(legendRow('1-RM').textContent).not.toContain('0.00');
        expect(legendRow('3-RM').textContent).toContain('2,000.00');
        expect(legendRow('X').textContent).toContain('0.00');

        // Result table: ranked largest first with the NULL group last.
        expect(bodyRows(screen.getByRole('table'))).toEqual([
            ['3-RM', '2,000.00'],
            ['X', '0.00'],
            ['1-RM', 'No data'],
        ]);

        // Chart data: no bar for the NULL group, a real 0 bar for X.
        const chart = chartCalls[chartCalls.length - 1];
        const config = createChartConfig({
            chartType: chart.displayChartType as never,
            data: chart.dataForDisplay,
            plan: chart.plan,
            selectedIndices: [],
            onElementClick: () => undefined,
            onZoomChange: () => undefined,
            showDataLabels: true,
        });
        expect(config.data.labels).toEqual(['3-RM', 'X', '1-RM']);
        expect(config.data.datasets[0].data).toEqual([2000, 0, null]);
        const labelFormatter = config.options.plugins.datalabels.formatter;
        expect(labelFormatter(null, { chart: { width: 800 } })).toBe('');
        expect(labelFormatter(0, { chart: { width: 800 } })).toBe('0.00');
    });

    it('sorts the NULL group last in both table sort directions', async () => {
        const { card } = await createCardThroughRealPath();
        for (const direction of ['asc', 'desc'] as const) {
            useAppStore.setState({ analysisCards: [{ ...card, tableSort: { column: 'v', direction } }] });
            const { result, unmount } = renderHook(() => useAnalysisCardData(card.id));
            expect(result.current.tableDataForDisplay.map(row => row.flat_type))
                .toEqual(direction === 'asc' ? ['X', '3-RM', '1-RM'] : ['3-RM', 'X', '1-RM']);
            unmount();
        }
        expect(rankRowsByValue([{ g: 'a', v: null }, { g: 'b', v: 0 }, { g: 'c', v: 5 }], 'v', 'asc').map(row => row.g)).toEqual(['b', 'c', 'a']);
    });

    it('breaks a line chart at the NULL point instead of dropping to 0', async () => {
        const { card } = await createCardThroughRealPath('line');
        const config = createChartConfig({
            chartType: 'line',
            data: card.aggregatedData,
            plan: card.plan,
            selectedIndices: [],
            onElementClick: () => undefined,
            onZoomChange: () => undefined,
        });
        expect(config.data.datasets[0].data).toEqual([null, 2000, 0]);
        expect(config.data.datasets[0].spanGaps).not.toBe(true);
        expect(formatChartDataLabel(undefined)).toBe('');
    });

    it('localizes the no-data label in all four languages', () => {
        expect(['English', 'Mandarin', 'Japanese', 'Malay'].map(language => getTranslation('card_value_no_data', language)))
            .toEqual(['No data', '无数据', 'データなし', 'Tiada data']);
    });
});

describe('a NULL aggregate never feeds Others, shares, KPIs or leaders', () => {
    it('skips NULL groups in additive Others bucketing but keeps a real 0', () => {
        const rows = [
            { g: 'A', v: null },
            { g: 'B', v: 50 },
            { g: 'C', v: 0 },
            { g: 'D', v: 30 },
            { g: 'E', v: null },
        ];
        expect(applyTopNWithOthers(rows, 'g', 'v', 2)).toEqual([
            { g: 'B', v: 50 },
            { g: 'D', v: 30 },
            { g: 'Others', v: 0 },
        ]);
        // An ascending window keeps the real 0 as its lowest group.
        expect(applyTopNWithOthers(rows, 'g', 'v', 1, 'asc')[0]).toEqual({ g: 'C', v: 0 });
        // A tail of only NULL groups is not an "Others" total of 0.
        expect(applyTopNWithOthers([{ g: 'B', v: 50 }, { g: 'A', v: null }], 'g', 'v', 1)).toEqual([{ g: 'B', v: 50 }]);
    });

    const kpiCard = (aggregatedData: CsvRow[], rankDirection?: 'asc' | 'desc'): AnalysisCardData => ({
        id: 'card-rent',
        plan: {
            title: 'Median net change by flat type',
            description: 'Compare flat types.',
            chartType: 'bar',
            aggregation: 'median',
            groupByColumn: 'flat_type',
            valueColumn: 'v',
            ...(rankDirection ? { rankDirection } : {}),
        },
        aggregatedData,
        summary: { language: 'English', text: 'Summary' },
        displayChartType: 'bar',
        isDataVisible: false,
        topN: null,
        hideOthers: false,
        hiddenLabels: [],
        provenance: {
            schemaVersion: 1,
            datasetId: 'dataset-rent',
            datasetVersion: 'version-current',
            evidenceStatus: 'verified',
            evidenceReasons: [],
            method: {
                operation: 'bar',
                groupByColumns: ['flat_type'],
                aggregations: [{ function: 'median', column: 'median_rent', alias: 'v' }],
                sourceColumns: ['flat_type', 'median_rent'],
                filterCount: 0,
                pivotRows: [],
                pivotColumns: [],
            },
            queryEvidence: null,
            queryEvidenceRequired: false,
            evidenceRefs: [],
            createdAt: '2026-10-23T00:00:00.000Z',
        },
        autoAnalysisEvaluation: {
            verdict: 'trusted',
            reasonCodes: [],
            detail: 'trusted',
            evaluatedAt: new Date().toISOString(),
            source: 'auto_analysis_evaluator_v1',
        },
    } as AnalysisCardData);
    const kpiInput = (card: AnalysisCardData) => ({
        cards: [card],
        columnProfiles: [
            { name: 'flat_type', type: 'categorical', uniqueValues: 3, missingPercentage: 0 },
            { name: 'v', type: 'numerical', missingPercentage: 0 },
        ] as never,
        csvData: { fileName: 'rent.csv', data: RAW_ROWS },
    });

    it('never leads a KPI with a NULL group read as 0', () => {
        // Highest-first with negative medians: a NULL read as 0 would lead.
        const negative = buildExecutiveKpis(kpiInput(kpiCard([
            { flat_type: '1-RM', v: null },
            { flat_type: '3-RM', v: -5 },
            { flat_type: 'X', v: -10 },
        ])));
        expect(negative[0]).toMatchObject({ id: 'top-group', value: '-5' });
        expect(negative[0].detail).toContain('3-RM');
        expect(negative.find(kpi => kpi.id === 'group-count')?.value).toBe('2');

        // A card whose every group lacks a value has no KPI at all.
        expect(buildExecutiveKpis(kpiInput(kpiCard([{ flat_type: '1-RM', v: null }, { flat_type: '2-RM', v: null }])))).toEqual([]);

        // A real 0 still leads a lowest-first card.
        const lowest = buildExecutiveKpis(kpiInput(kpiCard([
            { flat_type: '1-RM', v: null },
            { flat_type: '3-RM', v: 2000 },
            { flat_type: 'X', v: 0 },
        ], 'asc')));
        expect(lowest[0]).toMatchObject({ id: 'top-group', value: '0' });
        expect(lowest[0].detail).toContain('X');
    });

    it('does not count a NULL group as a distinct value when judging a flat metric', () => {
        const plan = kpiCard([]).plan;
        const flat = evaluateAggregationQuality(plan, [{ flat_type: 'A', v: 3000 }, { flat_type: 'B', v: 3000 }, { flat_type: 'C', v: null }]);
        expect(flat.verdict).toBe('flat_metric');
        const varied = evaluateAggregationQuality(plan, [{ flat_type: 'A', v: 3000 }, { flat_type: 'B', v: 0 }, { flat_type: 'C', v: null }]);
        expect(varied.verdict).not.toBe('flat_metric');
    });

    it('does not name a NULL group as the leader of a cross-card insight', () => {
        const evidence = (cardId: string, valueColumn: string, rows: CsvRow[]) => ({
            evidenceId: `ev-${cardId}`, cardId, isFallback: false, title: cardId, displayTitle: cardId, description: '',
            artifactType: null, chartType: 'bar', groupByColumn: 'flat_type', valueColumn, aggregation: 'median',
            rowCount: rows.length, summary: null, aggregatedDataSample: rows, autoAnalysisVerdict: 'trusted',
        }) as never;
        const insights = synthesizeCrossCardInsights([
            evidence('rent', 'rent', [{ flat_type: '1-RM', rent: null }, { flat_type: '5-RM', rent: 2600 }]),
            evidence('size', 'size', [{ flat_type: '5-RM', size: 110 }, { flat_type: '3-RM', size: 70 }]),
        ]);
        expect(insights[0]?.insight).toContain('5-RM leads');
        expect(insights[0]?.insight).not.toContain('1-RM');
    });

    it('does not give a NULL sum the lowest share in a grounded chat reply', () => {
        const reply = buildGroundedRankedShareReply({
            userMessage: 'Which UOM has the lowest total sales and what percentage of the overall total is it?',
            query: {
                explanation: 'Sum sales by UOM',
                engine: 'duckdb',
                plan: { groupBy: ['UOM'], aggregates: [{ function: 'sum', column: 'Sales', as: 'total_sales' }] },
                result: {
                    rows: [{ UOM: 'BOX', total_sales: null }, { UOM: 'PCS', total_sales: 100 }, { UOM: 'DOZ', total_sales: 0 }],
                    totalMatchedRows: 3, returnedRows: 3, truncated: false, selectedColumns: ['UOM', 'total_sales'],
                    appliedOrderBy: [], appliedLimit: 25, durationMs: 1,
                },
                appliedAt: new Date(), source: 'execute_data_query', sqlPreview: null, tableName: null, loadVersion: null,
            } as never,
            fileName: 'sales.csv',
            language: 'English',
        });
        expect(reply).toContain('UOM: DOZ');
        expect(reply).not.toContain('BOX');
    });
});
