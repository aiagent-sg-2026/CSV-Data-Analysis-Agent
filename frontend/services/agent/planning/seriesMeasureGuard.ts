import type {
    CanonicalBuildMeta,
    ColumnProfile,
    CsvCellValue,
    EvidenceValueGateReasonCode,
    FilterPredicate,
    QueryAggregateClause,
    QueryWhereClause,
    SeriesMeasureSemantics,
    SqlEvidenceQueryPlan,
} from '../../../types';

/**
 * Guards analyses of a melted period-header wide table, where every row is one
 * series in one period and the value column means whatever that series
 * measures. The intake records whether the series share one unit
 * (`SeriesMeasureSemantics.additiveAcrossSeries`); this module turns that fact
 * into planner guidance, a pre-execution plan check and an evidence-gate verdict.
 */

const same = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();
const COUNT_FUNCTIONS = new Set<QueryAggregateClause['function']>(['count', 'count_distinct']);
const MAX_SERIES_IN_GUIDANCE = 40;

/**
 * Reads the series measure recorded at intake for the current analysis
 * dataset. When column profiles are known, both the series and measure columns
 * must still exist, so a later reshape or rename silently drops the guard
 * instead of steering against columns that are gone.
 */
export const resolveSeriesMeasure = (state: {
    canonicalBuildMeta?: Pick<CanonicalBuildMeta, 'seriesMeasure'> | null;
    columnProfiles?: readonly Pick<ColumnProfile, 'name'>[] | null;
}): SeriesMeasureSemantics | null => {
    const semantics = state.canonicalBuildMeta?.seriesMeasure ?? null;
    if (!semantics) return null;
    const profiles = state.columnProfiles ?? [];
    if (profiles.length === 0) return semantics;
    const has = (column: string) => profiles.some(profile => same(profile.name, column));
    return has(semantics.seriesColumn) && has(semantics.measureColumn) ? semantics : null;
};

const toTextList = (value: CsvCellValue | CsvCellValue[] | undefined): string[] =>
    (Array.isArray(value) ? value : [value])
        .filter((entry): entry is string | number | boolean => entry !== null && entry !== undefined)
        .map(entry => String(entry));

/** Values a predicate admits for one column; null when it does not restrict that column to a finite set. */
const predicateValues = (predicate: FilterPredicate, column: string): string[] | null => {
    if (!same(predicate.column, column)) return null;
    if (predicate.operator === 'eq' || predicate.operator === 'in') {
        const values = toTextList(predicate.value);
        return values.length > 0 ? values : null;
    }
    return null;
};

const intersect = (left: string[] | null, right: string[] | null): string[] | null => {
    if (left === null) return right;
    if (right === null) return left;
    return left.filter(value => right.some(candidate => same(candidate, value)));
};

/**
 * Values of `column` a WHERE clause admits: top-level predicates are ANDed and
 * groups are ORed, so a group set only restricts when every group restricts.
 */
const restrictedValues = (where: QueryWhereClause | undefined, column: string): string[] | null => {
    let allowed: string[] | null = null;
    for (const predicate of where?.predicates ?? []) {
        allowed = intersect(allowed, predicateValues(predicate, column));
    }
    const groups = where?.groups ?? [];
    if (groups.length > 0) {
        const groupSets = groups.map(group => group.predicates.reduce<string[] | null>(
            (current, predicate) => intersect(current, predicateValues(predicate, column)),
            null,
        ));
        if (groupSets.every((set): set is string[] => set !== null)) {
            allowed = intersect(allowed, groupSets.flat());
        }
    }
    return allowed;
};

const findSeries = (semantics: SeriesMeasureSemantics, name: string) =>
    semantics.series.find(series => same(series.name, name)) ?? null;

const ancestorsOf = (semantics: SeriesMeasureSemantics, name: string): string[] => {
    const ancestors: string[] = [];
    let current = findSeries(semantics, name)?.parent ?? null;
    while (current && !ancestors.some(entry => same(entry, current!))) {
        ancestors.push(current);
        current = findSeries(semantics, current)?.parent ?? null;
    }
    return ancestors;
};

/** True when the set holds a series together with one of its ancestors, whose sum double-counts. */
const mixesHierarchyLevels = (semantics: SeriesMeasureSemantics, names: string[]): boolean =>
    names.some(name => ancestorsOf(semantics, name).some(ancestor => names.some(other => same(other, ancestor))));

/** True when every named series is in one family the intake verified to share a unit. */
const sharesVerifiedUnit = (semantics: SeriesMeasureSemantics, names: string[]): boolean => {
    if (semantics.additiveAcrossSeries) return true;
    return semantics.unitFamilies.some(family => {
        const members = [family.parent, ...family.children];
        return names.every(name => members.some(member => same(member, name)));
    });
};

/** A table without published totals or subtotals has no hierarchy levels to double-count. */
const hasSummarySeries = (semantics: SeriesMeasureSemantics): boolean =>
    semantics.series.some(series => series.rowClass !== 'fact');

const filtersDetailRows = (where: QueryWhereClause | undefined, semantics: SeriesMeasureSemantics): boolean =>
    !hasSummarySeries(semantics) || semantics.detailRowColumns.some(column => {
        const values = restrictedValues(where, column);
        return values !== null && values.length > 0 && values.every(value => same(value, semantics.detailRowValue));
    });

export type SeriesMeasureReasonCode = Extract<EvidenceValueGateReasonCode,
    | 'cross_series_aggregate'
    | 'series_hierarchy_double_count'
    | 'mixed_unit_series_comparison'
    | 'series_hierarchy_mix'
    | 'series_record_count'>;

export interface SeriesMeasurePlanVerdict {
    decision: 'pass' | 'table_only' | 'reject';
    reasonCodes: SeriesMeasureReasonCode[];
    /** Planner feedback for a rejected plan; null otherwise. */
    feedback: string | null;
}

const PASS: SeriesMeasurePlanVerdict = { decision: 'pass', reasonCodes: [], feedback: null };

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The series a reader most likely wants first: published most recently, then the longest history. */
export const rankProminentSeries = (semantics: SeriesMeasureSemantics) => semantics.series
    .map((series, index) => ({ series, index }))
    .filter(({ series }) => series.observations > 1)
    .sort((left, right) =>
        String(right.series.latestPeriod ?? '').localeCompare(String(left.series.latestPeriod ?? ''))
        || right.series.observations - left.series.observations
        || left.index - right.index)
    .map(({ series }) => series);

const buildRejectFeedback = (semantics: SeriesMeasureSemantics, reason: SeriesMeasureReasonCode, title: string): string => {
    const { seriesColumn: s, measureColumn: m, periodColumn: p } = semantics;
    const example = rankProminentSeries(semantics)[0]?.name;
    const exampleClause = example ? ` For example WHERE "${s}" = ${quote(example)} grouped by "${p}".` : '';
    if (reason === 'series_hierarchy_double_count') {
        return `The plan "${title}" aggregates "${m}" across "${s}" values that include both published totals and their components, which double-counts. `
            + `Filter detail rows with WHERE "${semantics.detailRowColumns[0]}" = ${quote(semantics.detailRowValue)}, or restrict "${s}" to one series.${exampleClause}`;
    }
    return `The plan "${title}" aggregates "${m}" across different "${s}" values, but each series measures something different (${semantics.evidence.summary}) `
        + `Analyse one series over "${p}" with WHERE "${s}" = '<one series>', or group by "${s}" for a per-series summary. Do not sum, average or take the maximum of "${m}" across series.${exampleClause}`;
};

const verdict = (
    semantics: SeriesMeasureSemantics,
    title: string,
    decision: SeriesMeasurePlanVerdict['decision'],
    reason: SeriesMeasureReasonCode,
): SeriesMeasurePlanVerdict => ({
    decision,
    reasonCodes: [reason],
    feedback: decision === 'reject' ? buildRejectFeedback(semantics, reason, title) : null,
});

const assessRawSql = (sql: string, semantics: SeriesMeasureSemantics, title: string): SeriesMeasurePlanVerdict => {
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const column = (name: string) => `(?:"${escape(name)}"|\\b${escape(name)}\\b)`;
    const measureAggregate = new RegExp(`\\b(?:sum|avg|mean|median|min|max|quantile_cont|percentile_cont)\\s*\\([^)]*${column(semantics.measureColumn)}`, 'i');
    if (!measureAggregate.test(sql)) return PASS;
    const singleSeries = new RegExp(`${column(semantics.seriesColumn)}\\s*=\\s*'(?:[^']|'')*'`, 'i');
    const groupedBySeries = new RegExp(`group\\s+by[^;]*${column(semantics.seriesColumn)}`, 'i');
    if (singleSeries.test(sql) || groupedBySeries.test(sql)) {
        // Raw SQL cannot be checked precisely, so a series-aware query is kept as a table.
        return semantics.additiveAcrossSeries ? PASS : verdict(semantics, title, 'table_only', 'mixed_unit_series_comparison');
    }
    if (semantics.additiveAcrossSeries) {
        const detailFilter = !hasSummarySeries(semantics) || semantics.detailRowColumns.some(name =>
            new RegExp(`${column(name)}\\s*=\\s*'${escape(semantics.detailRowValue)}'`, 'i').test(sql));
        return detailFilter ? PASS : verdict(semantics, title, 'reject', 'series_hierarchy_double_count');
    }
    return verdict(semantics, title, 'reject', 'cross_series_aggregate');
};

/**
 * Checks one evidence plan against the series measure.
 *
 * - A non-count aggregate of the measure is valid when it reads one series,
 *   groups by the series column, or (for verified same-unit series) sums
 *   detail rows without mixing a parent with its children.
 * - Aggregating across series of unverified units is rejected; grouping by
 *   series of unverified units is kept as a table, since one chart axis would
 *   compare different units.
 * - Record counts per series or period say little here and stay tables.
 */
export const assessSeriesMeasurePlan = (
    plan: Pick<SqlEvidenceQueryPlan, 'title' | 'queryMode' | 'query'>,
    semantics: SeriesMeasureSemantics | null | undefined,
): SeriesMeasurePlanVerdict => {
    if (!semantics) return PASS;
    const { query } = plan;
    if (typeof query.rawSql === 'string' && query.rawSql.trim()) {
        return assessRawSql(query.rawSql, semantics, plan.title);
    }
    const seriesColumn = semantics.seriesColumn;
    const groupedBySeries = (query.groupBy ?? []).some(column => same(column, seriesColumn));
    const querySeries = restrictedValues(query.where, seriesColumn);
    const detailFiltered = filtersDetailRows(query.where, semantics);
    const aggregates = query.aggregates ?? [];

    if (aggregates.length === 0) {
        // A row listing is not aggregated by the query, but a chart over it
        // would still draw several series on one axis.
        const selectsMeasure = (query.select ?? []).length === 0
            || (query.select ?? []).some(column => column === '*' || same(column, semantics.measureColumn));
        if (!selectsMeasure || (querySeries?.length ?? 0) === 1) return PASS;
        if (!semantics.additiveAcrossSeries) return verdict(semantics, plan.title, 'table_only', 'mixed_unit_series_comparison');
        return detailFiltered ? PASS : verdict(semantics, plan.title, 'table_only', 'series_hierarchy_mix');
    }

    const verdicts: SeriesMeasurePlanVerdict[] = aggregates.map(aggregate => {
        const isCount = COUNT_FUNCTIONS.has(aggregate.function);
        const series = intersect(querySeries, restrictedValues(aggregate.where, seriesColumn));
        if (series !== null && series.length === 1) return PASS;
        if (isCount) {
            return (query.groupBy ?? []).length > 0 ? verdict(semantics, plan.title, 'table_only', 'series_record_count') : PASS;
        }
        if (!aggregate.column || !same(aggregate.column, semantics.measureColumn)) return PASS;
        const detailOnly = detailFiltered || filtersDetailRows(aggregate.where, semantics);
        const mixesLevels = series === null ? !detailOnly : !detailOnly && mixesHierarchyLevels(semantics, series);
        const sameUnit = series === null ? semantics.additiveAcrossSeries : sharesVerifiedUnit(semantics, series);
        if (groupedBySeries) {
            if (!sameUnit) return verdict(semantics, plan.title, 'table_only', 'mixed_unit_series_comparison');
            return mixesLevels ? verdict(semantics, plan.title, 'table_only', 'series_hierarchy_mix') : PASS;
        }
        if (!sameUnit) return verdict(semantics, plan.title, 'reject', 'cross_series_aggregate');
        return mixesLevels ? verdict(semantics, plan.title, 'reject', 'series_hierarchy_double_count') : PASS;
    });

    const rank = { pass: 0, table_only: 1, reject: 2 } as const;
    const worst = verdicts.reduce((current, next) => (rank[next.decision] > rank[current.decision] ? next : current), PASS);
    return {
        decision: worst.decision,
        reasonCodes: [...new Set(verdicts.flatMap(entry => entry.reasonCodes))],
        feedback: worst.feedback,
    };
};

/** True when the query's WHERE clause reads exactly one series, so parent and child rows cannot mix. */
export const selectsSingleSeries = (
    plan: Pick<SqlEvidenceQueryPlan, 'query'>,
    semantics: SeriesMeasureSemantics | null | undefined,
): boolean => {
    if (!semantics || plan.query.rawSql) return false;
    const series = restrictedValues(plan.query.where, semantics.seriesColumn);
    return series !== null && series.length === 1;
};

/** Planner guidance stating how the measure may be aggregated; shared by the AI topic, evidence and Pi planners. */
export const buildSeriesMeasureGuidance = (semantics: SeriesMeasureSemantics): string => {
    const { seriesColumn: s, measureColumn: m, periodColumn: p } = semantics;
    const detailColumn = semantics.detailRowColumns[0] ?? null;
    const lines = [
        `Each row is one "${s}" value in one "${p}" (${semantics.periodGrain}). "${m}" means whatever that series measures, so its meaning and unit depend on "${s}".`,
        `Intake check: ${semantics.evidence.summary}`,
    ];
    if (semantics.additiveAcrossSeries) {
        lines.push(
            detailColumn
                ? `Detail series (${detailColumn} = ${quote(semantics.detailRowValue)}) share one unit and add up to the published totals. Sum "${m}" across series only over ${detailColumn} = ${quote(semantics.detailRowValue)} rows, or restrict "${s}" to one series. Never add a total or subtotal series to its own components.`
                : `The series share one unit; sum "${m}" across series only when no series is a total of others.`,
        );
    } else {
        lines.push(
            `The series are not verified to share a unit. Never SUM, AVG, MEDIAN or MAX "${m}" across series, and never group by "${p}" without restricting "${s}" to one series. Analyse one series over "${p}" (WHERE "${s}" = '<series>'), or group by "${s}" only for a per-series table.`,
        );
        if (semantics.unitFamilies.length > 0) {
            lines.push(`Series verified to share a unit (parent = sum of children): ${semantics.unitFamilies
                .map(family => `${family.parent} = ${family.children.join(' + ')}`)
                .join('; ')}. Only these may be compared on one axis.`);
        }
    }
    lines.push(`Record counts per "${s}" or "${p}" only show how many periods were published; do not use them as findings.`);
    const listed = semantics.series.slice(0, MAX_SERIES_IN_GUIDANCE).map(series =>
        `- ${series.name}${series.parent ? ` (part of ${series.parent})` : ''}${series.rowClass !== 'fact' ? ` [${series.rowClass}]` : ''}: ${series.observations} periods, latest ${series.latestPeriod ?? 'n/a'}`);
    const more = semantics.series.length > MAX_SERIES_IN_GUIDANCE ? [`- ... ${semantics.series.length - MAX_SERIES_IN_GUIDANCE} more`] : [];
    return [...lines, `"${s}" values:`, ...listed, ...more].join('\n');
};

/** Topic text naming one series explicitly, so every planner (and the topic parser) can apply the filter. */
export const buildSeriesTrendTopic = (semantics: SeriesMeasureSemantics, seriesName: string): string => {
    const aggregation = semantics.additiveAcrossSeries ? 'sum' : 'avg';
    return `${seriesName} trend by ${semantics.periodColumn} (${aggregation} of ${semantics.measureColumn} by ${semantics.periodColumn}, where ${semantics.seriesColumn} = ${quote(seriesName)})`;
};

/**
 * Deterministic topics for a melted table: trends of the most prominent
 * series, one series each. With verified additive series the published total
 * leads, followed by detail series, since that total is the headline figure.
 * Additive series without any total are summed across series directly.
 */
export const buildSeriesMeasureFallbackTopics = (semantics: SeriesMeasureSemantics, limit = 2): string[] => {
    const { seriesColumn: s, measureColumn: m, periodColumn: p } = semantics;
    if (semantics.additiveAcrossSeries && !hasSummarySeries(semantics)) {
        // Plain comparable series (products by year): the overall trend and
        // the per-series totals are the headline views, and both are sums.
        return [
            `${m} trend by ${p} (sum of ${m} by ${p})`,
            `${m} by ${s} (sum of ${m} by ${s})`,
        ].slice(0, limit);
    }
    const ranked = rankProminentSeries(semantics);
    const total = semantics.additiveAcrossSeries
        ? ranked.find(series => series.parent === null && series.rowClass === 'total') ?? null
        : null;
    const ordered = total
        ? [total, ...ranked.filter(series => series.rowClass === 'fact')]
        : ranked;
    return ordered.slice(0, limit).map(series => buildSeriesTrendTopic(semantics, series.name));
};

/** Lower-cases and unifies dash and space variants, so "Ridership – MRT" matches "Ridership - MRT". */
const normalizeMention = (value: string) => value
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

const isWordCharacter = (character: string | undefined) => Boolean(character && /[\p{L}\p{N}]/u.test(character));

/** True when `name` occurs in `text` as a whole phrase, not inside a longer word. */
const mentionsPhrase = (text: string, name: string): boolean => {
    if (!name) return false;
    for (let index = text.indexOf(name); index >= 0; index = text.indexOf(name, index + 1)) {
        if (!isWordCharacter(text[index - 1]) && !isWordCharacter(text[index + name.length])) return true;
    }
    return false;
};

/**
 * The one series a topic is about: named as `<seriesColumn> = '<series>'`, or
 * quoted verbatim as in an AI topic "Average Daily Ridership - MRT by Period".
 * A name that is part of a longer matched name does not count separately, and
 * a topic naming two different series (a comparison) resolves to none.
 */
export const resolveTopicSeriesFilter = (topic: string, semantics: SeriesMeasureSemantics | null | undefined): string | null => {
    if (!semantics) return null;
    const escaped = semantics.seriesColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`["\`]?${escaped}["\`]?\\s*=\\s*'((?:[^']|'')+)'`, 'i').exec(topic);
    if (match) return findSeries(semantics, match[1].replace(/''/g, "'"))?.name ?? null;

    const text = normalizeMention(topic);
    const mentioned = semantics.series
        .map(series => ({ name: series.name, key: normalizeMention(series.name) }))
        .filter(series => mentionsPhrase(text, series.key));
    const outermost = mentioned.filter(series => !mentioned.some(other =>
        other.key.length > series.key.length && mentionsPhrase(other.key, series.key)));
    const distinct = [...new Set(outermost.map(series => series.key))];
    return distinct.length === 1 ? outermost[0].name : null;
};
