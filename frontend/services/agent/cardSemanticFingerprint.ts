import type { AnalysisPlan, PreFilterClause } from '../../types';

const normalizeFilter = (filter: PreFilterClause) => ({
    column: filter.column.trim().toLowerCase(),
    operator: filter.operator ?? 'eq',
    value: Array.isArray(filter.value)
        ? [...filter.value].map(String).sort()
        : String(filter.value ?? ''),
});

export const buildCardSemanticFingerprint = (
    plan: AnalysisPlan,
    datasetVersion: string | null | undefined,
): string | null => {
    if (!datasetVersion) {
        return null;
    }

    return JSON.stringify({
        datasetVersion,
        artifactType: plan.artifactType ?? null,
        aggregation: plan.aggregation ?? null,
        secondaryAggregation: plan.secondaryAggregation ?? null,
        groupByColumn: plan.groupByColumn?.trim().toLowerCase() ?? null,
        valueColumn: plan.valueColumn?.trim().toLowerCase() ?? null,
        valueColumns: plan.valueColumns?.map(value => value.trim().toLowerCase()) ?? [],
        xValueColumn: plan.xValueColumn?.trim().toLowerCase() ?? null,
        yValueColumn: plan.yValueColumn?.trim().toLowerCase() ?? null,
        secondaryValueColumn: plan.secondaryValueColumn?.trim().toLowerCase() ?? null,
        // A lowest-first and a highest-first ranking of the same measure show different groups.
        rankDirection: plan.rankDirection ?? 'desc',
        preFilter: (plan.preFilter ?? [])
            .map(normalizeFilter)
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        pivotRows: plan.artifactMetadata?.matrixRowLabel?.trim().toLowerCase() ?? null,
        pivotColumns: plan.artifactMetadata?.matrixColumnLabel?.trim().toLowerCase() ?? null,
        pivotValues: plan.artifactMetadata?.matrixValueColumns?.map(value => value.trim().toLowerCase()) ?? [],
        // The series filter of a melted period table lives in the query, not
        // in preFilter; without it every one-series trend would look the same.
        series: plan.periodSeries?.seriesName?.trim().toLowerCase() ?? null,
    });
};
