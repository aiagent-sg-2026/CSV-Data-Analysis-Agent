import type {
    AnalysisCardData,
    AnalysisPlan,
    AnalysisPlanPeriodSeries,
    QueryAggregateClause,
    QueryPlan,
    SeriesMeasureSemantics,
    SqlAnalysisPlan,
    SqlEvidenceQueryPlan,
} from '../../../types';
import { mergeEvidencePreFilterIntoQuery } from '../planning/evidenceQuerySemantics';
import { assessSeriesMeasurePlan, resolveSelectedSeries, type SeriesMeasurePlanVerdict } from '../planning/seriesMeasureGuard';
import { assessRowHierarchyPlan, mergePlanVerdicts, type RowHierarchyContract } from '../planning/rowHierarchyGuard';

/**
 * Chat and skill cards are built from plans the model writes directly, not
 * through the topic pipeline and its evidence gate. On a melted period table
 * they get the same series-measure decision, so "total visitors by month" in
 * chat cannot sum series of different meaning without a caveat.
 */

const isSqlPlan = (plan: AnalysisPlan | SqlAnalysisPlan): plan is SqlAnalysisPlan =>
    'query' in plan && Boolean(plan.query) && typeof plan.query === 'object';

/** The query a card plan runs, in the shape the series guard reads. */
export const toSeriesCheckPlan = (
    plan: AnalysisPlan | SqlAnalysisPlan,
): Pick<SqlEvidenceQueryPlan, 'title' | 'queryMode' | 'query'> => {
    if (isSqlPlan(plan)) {
        return { title: plan.title, queryMode: plan.queryMode, query: mergeEvidencePreFilterIntoQuery(plan.query, plan.preFilter) };
    }
    const valueColumns = plan.valueColumns?.length
        ? plan.valueColumns
        : [plan.valueColumn ?? plan.yValueColumn].filter((column): column is string => Boolean(column));
    const aggregation = plan.chartType === 'scatter' ? undefined : plan.aggregation;
    const aggregates: QueryAggregateClause[] = !aggregation
        ? []
        : valueColumns.length > 0
            ? valueColumns.map(column => ({ function: aggregation, column, as: column }))
            : [{ function: aggregation, as: aggregation }];
    const query = mergeEvidencePreFilterIntoQuery({
        ...(plan.groupByColumn && aggregates.length > 0 ? { groupBy: [plan.groupByColumn] } : {}),
        ...(aggregates.length > 0
            ? { aggregates }
            : { select: [plan.xValueColumn, plan.yValueColumn, ...valueColumns].filter((column): column is string => Boolean(column)) }),
    }, plan.preFilter);
    return { title: plan.title, queryMode: aggregates.length > 0 ? 'aggregate' : 'rowset', query };
};

type SeriesTableOnlyGate = NonNullable<AnalysisCardData['evidenceValueGate']>;

export type CardSeriesScope =
    | { decision: 'pass'; evidenceValueGate: null }
    | { decision: 'table_only'; evidenceValueGate: SeriesTableOnlyGate }
    /** `tableOnlyGate` is for results that are already computed and can only be caveated. */
    | { decision: 'reject'; feedback: string; tableOnlyGate: SeriesTableOnlyGate };

const describeTableOnly = (
    verdict: SeriesMeasurePlanVerdict,
    semantics: SeriesMeasureSemantics | null | undefined,
    rowHierarchy: RowHierarchyContract | null | undefined,
): string => {
    if (!semantics) {
        const rowClass = rowHierarchy?.rowClassColumn ?? 'RowClass';
        return verdict.decision === 'reject'
            ? `The rows include published parent rows next to their detail rows ("${rowClass}" is not restricted to detail rows), so the same amount is counted once per hierarchy level. The result is kept as a table and not verified.`
            : `The rows mix hierarchy levels ("${rowClass}" is not restricted to detail rows), so the result is kept as a table.`;
    }
    const { seriesColumn: s, measureColumn: m } = semantics;
    if (verdict.decision === 'reject') {
        return `"${m}" is aggregated across "${s}" series that cannot be added together, so the result is kept as a table and not verified. ${semantics.evidence.summary}`;
    }
    if (verdict.reasonCodes.includes('mixed_unit_series_comparison')) {
        return `"${m}" of different "${s}" series measures different things, so it is kept as a table, not compared on one chart axis. ${semantics.evidence.summary}`;
    }
    if (verdict.reasonCodes.includes('series_hierarchy_mix')) {
        return `The rows mix published totals with their own components, so "${m}" is kept as a table.`;
    }
    return `Record counts per "${s}" or period only show how many periods were published, so they are kept as a table.`;
};

const buildTableOnlyGate = (
    verdict: SeriesMeasurePlanVerdict,
    semantics: SeriesMeasureSemantics | null | undefined,
    rowHierarchy: RowHierarchyContract | null | undefined,
): SeriesTableOnlyGate => ({
    decision: 'table_only',
    reasonCodes: verdict.reasonCodes,
    detail: describeTableOnly(verdict, semantics, rowHierarchy),
    querySignature: '',
    semanticSignature: '',
    semanticRisk: 'high',
    degradationPath: `series_measure_${verdict.decision}→table_only`,
    evaluatedAt: new Date().toISOString(),
    source: 'evidence_value_gate_v1',
});

/**
 * Applies the series-measure and row-hierarchy checks to a card plan: pass,
 * keep as a caveated table, or reject with planner feedback.
 */
export const assessCardSeriesScope = (
    plan: AnalysisPlan | SqlAnalysisPlan,
    semantics: SeriesMeasureSemantics | null | undefined,
    rowHierarchy?: RowHierarchyContract | null,
): CardSeriesScope => {
    if (!semantics && !rowHierarchy) return { decision: 'pass', evidenceValueGate: null };
    const checkPlan = toSeriesCheckPlan(plan);
    const verdict = mergePlanVerdicts(assessSeriesMeasurePlan(checkPlan, semantics), assessRowHierarchyPlan(checkPlan, rowHierarchy));
    if (verdict.decision === 'reject') {
        return {
            decision: 'reject',
            feedback: verdict.feedback ?? `The plan "${plan.title}" aggregates "${semantics?.measureColumn ?? 'the measure'}" across rows that cannot be added together.`,
            tableOnlyGate: buildTableOnlyGate(verdict, semantics, rowHierarchy),
        };
    }
    if (verdict.decision === 'table_only') {
        return { decision: 'table_only', evidenceValueGate: buildTableOnlyGate(verdict, semantics, rowHierarchy) };
    }
    return { decision: 'pass', evidenceValueGate: null };
};

/**
 * Display facts for a card on a melted period-series table: the period grain
 * recorded at intake and the one series the card reads, taken from the query
 * that produced its rows (or the card plan's own filters without a trace).
 */
export const buildPlanPeriodSeries = (
    plan: AnalysisPlan,
    semantics: SeriesMeasureSemantics | null | undefined,
    executedQuery?: Pick<QueryPlan, 'where'> | null,
): AnalysisPlanPeriodSeries | null => {
    if (!semantics) return null;
    const where = executedQuery?.where
        ? mergeEvidencePreFilterIntoQuery({ where: executedQuery.where }, plan.preFilter).where
        : toSeriesCheckPlan(plan).query.where;
    return {
        periodColumn: semantics.periodColumn,
        periodGrain: semantics.periodGrain,
        seriesName: resolveSelectedSeries(where, semantics)?.name ?? null,
    };
};
