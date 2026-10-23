import { AGGREGATION_TYPES, isAggregationType } from '../../../../types/analysis';
import type { AggregationType, ColumnAdditivity, ColumnProfile, DataAnalysisHypothesis, ResearchPlan, ResearchPlanQuestion, SeriesMeasureSemantics } from '../../../../types';
import { assessVolumeDependence, describeVolumeDependence, isTimeDimension, isVolumeCheckCancellation, type GroupSumAndCount } from '../../planning/volumeDrivenSum';
import type { RowHierarchyContract } from '../../planning/rowHierarchyGuard';

export const MIN_PLAN_QUESTIONS = 2;
export const MAX_PLAN_QUESTIONS = 6;
const MAX_TITLE_CHARS = 140;
const MAX_RATIONALE_CHARS = 300;

// Aggregations that need a numeric column; counting works on any column or on rows.
const NUMERIC_AGGREGATIONS = new Set<AggregationType>(['sum', 'avg', 'median', 'min', 'max', 'percentile']);
const NUMERIC_COLUMN_TYPES = new Set<ColumnProfile['type']>(['numerical', 'currency', 'percentage']);

const readText = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';

const sameName = (left: string, right: string): boolean =>
    left.trim().toLowerCase() === right.trim().toLowerCase();

const resolveColumn = (name: unknown, columns: readonly ColumnProfile[]): ColumnProfile | null => {
    if (typeof name !== 'string' || !name.trim()) return null;
    return columns.find(column => sameName(column.name, name)) ?? null;
};

export interface ResearchPlanValidation {
    questions: ResearchPlanQuestion[];
    rejected: Array<{ title: string; reason: string }>;
}

/**
 * Checks Pi's proposed questions against the real dataset. The model decides
 * what is worth asking; this only guarantees each question can be executed:
 * known columns, an aggregation that fits the column, no duplicates.
 */
export const validateResearchQuestions = (
    raw: unknown,
    columns: readonly ColumnProfile[],
    maxQuestions = MAX_PLAN_QUESTIONS,
): ResearchPlanValidation => {
    const proposed = Array.isArray((raw as { questions?: unknown })?.questions)
        ? (raw as { questions: unknown[] }).questions
        : [];
    const questions: ResearchPlanQuestion[] = [];
    const rejected: ResearchPlanValidation['rejected'] = [];
    const seen = new Set<string>();

    for (const entry of proposed) {
        const item = (entry ?? {}) as Record<string, unknown>;
        const title = readText(item.title, MAX_TITLE_CHARS);
        const reject = (reason: string) => rejected.push({ title: title || '(untitled)', reason });
        if (!title) { reject('The question has no title.'); continue; }
        if (questions.length >= maxQuestions) { reject(`Only ${maxQuestions} questions are used.`); continue; }

        const dimension = item.dimension === null || item.dimension === undefined || item.dimension === ''
            ? null : resolveColumn(item.dimension, columns);
        if (item.dimension && !dimension) { reject(`Unknown dimension column "${String(item.dimension)}".`); continue; }
        const metric = item.metric === null || item.metric === undefined || item.metric === ''
            ? null : resolveColumn(item.metric, columns);
        if (item.metric && !metric) { reject(`Unknown metric column "${String(item.metric)}".`); continue; }
        if (!dimension && !metric) { reject('The question needs a dimension, a metric, or both.'); continue; }

        const aggregationRaw = item.aggregation === null || item.aggregation === undefined || item.aggregation === ''
            ? null : item.aggregation;
        if (aggregationRaw !== null && !isAggregationType(aggregationRaw)) {
            reject(`Unsupported aggregation "${String(aggregationRaw)}". Use one of ${AGGREGATION_TYPES.join(', ')}.`);
            continue;
        }
        const aggregation = aggregationRaw as AggregationType | null;
        if (metric && !aggregation) { reject('A question with a metric needs an aggregation.'); continue; }
        if (aggregation && NUMERIC_AGGREGATIONS.has(aggregation)) {
            if (!metric) { reject(`"${aggregation}" needs a numeric metric column.`); continue; }
            if (!NUMERIC_COLUMN_TYPES.has(metric.type)) {
                reject(`"${metric.name}" is ${metric.type}, so "${aggregation}" does not apply. Use count or count_distinct.`);
                continue;
            }
        }
        if (dimension && metric && sameName(dimension.name, metric.name)) {
            reject('The dimension and the metric are the same column.'); continue;
        }

        // Questions on different named series of a melted table are distinct.
        const series = readText(item.series, MAX_TITLE_CHARS);
        const key = [dimension?.name, metric?.name, aggregation, series].map(part => (part ?? '').toLowerCase()).join('|');
        if (seen.has(key)) { reject('This duplicates another question.'); continue; }
        seen.add(key);

        // A total-volume intent only means something for a SUM.
        const totalIntent = aggregation === 'sum' && (item.total_intent === true || item.totalIntent === true);
        questions.push({
            title,
            rationale: readText(item.rationale, MAX_RATIONALE_CHARS),
            dimension: dimension?.name ?? null,
            metric: metric?.name ?? null,
            aggregation,
            comparison: readText(item.comparison, MAX_TITLE_CHARS) || null,
            ...(totalIntent ? { totalIntent: true } : {}),
            ...(series ? { series } : {}),
        });
    }
    return { questions, rejected };
};

/** A plan needs enough valid questions to be worth using; otherwise the app plans as before. */
export const buildResearchPlan = (
    validation: ResearchPlanValidation,
    datasetVersion: string,
): ResearchPlan | null =>
    validation.questions.length >= MIN_PLAN_QUESTIONS
        ? { datasetVersion, questions: validation.questions, rejected: validation.rejected, consumed: false }
        : null;

/**
 * The text the later SQL planner sees. It states the chosen measure explicitly
 * ("median of resale_price by town") so that choice survives into the query.
 */
export const buildResearchTopic = (question: ResearchPlanQuestion): string => {
    const measure = question.aggregation
        ? `${question.aggregation}${question.metric ? ` of ${question.metric}` : ''}`
        : question.metric;
    const detail = [
        measure,
        question.dimension ? `by ${question.dimension}` : null,
    ].filter(Boolean).join(' ');
    // The filter is written as `<column> = '<value>'` so planners and the
    // topic parser apply the same row scope Pi's question was checked with.
    const scope = question.filter ? `where ${question.filter.column} = '${question.filter.value.replace(/'/g, "''")}'` : null;
    const full = [detail, scope].filter(Boolean).join(', ');
    return full ? `${question.title} (${full})` : question.title;
};

/** The plan is used once, and only for the dataset version it was drafted for. */
export const getUsableResearchPlan = (
    plan: ResearchPlan | null | undefined,
    currentDatasetVersion: string | null,
): ResearchPlan | null =>
    plan && !plan.consumed && currentDatasetVersion !== null && plan.datasetVersion === currentDatasetVersion
        ? plan : null;

/** Gives hypotheses built from plan topics the structured fields Pi chose, instead of re-guessing them from text. */
export const applyPlanToHypotheses = (
    hypotheses: DataAnalysisHypothesis[],
    plan: ResearchPlan,
): DataAnalysisHypothesis[] => {
    const byTopic = new Map(plan.questions.map(question => [buildResearchTopic(question), question]));
    return hypotheses.map(hypothesis => {
        const question = byTopic.get(hypothesis.topic);
        if (!question) return hypothesis;
        return {
            ...hypothesis,
            grain: question.dimension ?? hypothesis.grain,
            metric: question.metric ?? hypothesis.metric,
            comparisonIntent: question.comparison ?? hypothesis.comparisonIntent,
            ...(question.filter ? { filterIntent: `${question.filter.column} = '${question.filter.value}'` } : {}),
            ...(question.totalIntent ? { totalIntent: true } : {}),
        };
    });
};

const ADDITIVITY_KINDS = new Set<ColumnAdditivity['kind']>(['additive', 'non_additive']);
const ADDITIVITY_NATURES = new Set<ColumnAdditivity['nature']>(['flow', 'stock', 'ratio', 'unit_value', 'identifier', 'other']);
const MAX_ADDITIVITY_ENTRIES = 40;

export interface ColumnAdditivityValidation {
    accepted: Record<string, ColumnAdditivity>;
    rejected: Array<{ column: string; reason: string }>;
}

/**
 * Pi says which numeric columns can be summed; the app keeps only judgements it can
 * stand behind. Unknown or non-numeric columns are dropped, an inconsistent
 * kind/nature pair is rejected, and a percentage column is always non-additive
 * because that is a fact about the data, whatever the model says.
 */
export const validateColumnAdditivity = (
    raw: unknown,
    columns: readonly ColumnProfile[],
): ColumnAdditivityValidation => {
    const entries = Array.isArray(raw) ? raw.slice(0, MAX_ADDITIVITY_ENTRIES) : [];
    const accepted: Record<string, ColumnAdditivity> = {};
    const rejected: ColumnAdditivityValidation['rejected'] = [];
    for (const entry of entries) {
        const item = (entry ?? {}) as Record<string, unknown>;
        const label = typeof item.column === 'string' ? item.column : '(unnamed)';
        const reject = (reason: string) => rejected.push({ column: label, reason });
        const column = resolveColumn(item.column, columns);
        if (!column) { reject('Unknown column.'); continue; }
        if (!NUMERIC_COLUMN_TYPES.has(column.type)) { reject(`"${column.name}" is ${column.type}, not numeric.`); continue; }
        if (!ADDITIVITY_KINDS.has(item.kind as ColumnAdditivity['kind'])) { reject('kind must be additive or non_additive.'); continue; }
        if (!ADDITIVITY_NATURES.has(item.nature as ColumnAdditivity['nature'])) { reject('nature must be flow, stock, ratio, unit_value, identifier or other.'); continue; }
        let kind = item.kind as ColumnAdditivity['kind'];
        const nature = item.nature as ColumnAdditivity['nature'];
        // Ratios, unit values and identifiers are never summed across rows.
        if (kind === 'additive' && (nature === 'ratio' || nature === 'unit_value' || nature === 'identifier')) {
            reject(`A ${nature} cannot be additive.`); continue;
        }
        if (column.type === 'percentage') kind = 'non_additive';
        accepted[column.name] = { kind, nature, rationale: readText(item.rationale, MAX_RATIONALE_CHARS) };
    }
    return { accepted, rejected };
};

/** Returns the profiles with the accepted additivity judgements attached; other fields are untouched. */
export const applyColumnAdditivity = (
    profiles: readonly ColumnProfile[],
    accepted: Record<string, ColumnAdditivity>,
): ColumnProfile[] =>
    profiles.map(profile => accepted[profile.name] ? { ...profile, additivity: accepted[profile.name] } : profile);

/** Judgements already on the profiles; a new submission's accepted entries are layered on top by the caller. */
export const readProfileAdditivity = (profiles: readonly ColumnProfile[]): Record<string, ColumnAdditivity> =>
    Object.fromEntries(profiles.filter(profile => profile.additivity).map(profile => [profile.name, profile.additivity!]));

/**
 * Holds each question to Pi's own additivity judgement. A SUM needs the metric
 * to be judged and judged additive; a metric judged to be an identifier is not
 * aggregated numerically at all. This checks consistency between the model's
 * statements; it does not guess meaning from column names.
 */
export const checkQuestionMethods = (
    questions: readonly ResearchPlanQuestion[],
    additivity: Readonly<Record<string, ColumnAdditivity>>,
): ResearchPlanValidation => {
    const kept: ResearchPlanQuestion[] = [];
    const rejected: ResearchPlanValidation['rejected'] = [];
    for (const question of questions) {
        const judgement = question.metric ? additivity[question.metric] : undefined;
        const reject = (reason: string) => rejected.push({ title: question.title, reason });
        if (question.metric && question.aggregation && NUMERIC_AGGREGATIONS.has(question.aggregation) && judgement?.nature === 'identifier') {
            reject(`You judged "${question.metric}" to be an identifier, so "${question.aggregation}" of it is meaningless. Use count or count_distinct, or measure a real quantity.`);
            continue;
        }
        if (question.aggregation === 'sum' && question.metric) {
            if (!judgement) {
                reject(`Classify "${question.metric}" in \`columns\` (additivity and nature) before summing it.`);
                continue;
            }
            if (judgement.kind === 'non_additive') {
                reject(`You judged "${question.metric}" non_additive (${judgement.nature}), so summing it across rows is not meaningful. Use median or avg.`);
                continue;
            }
        }
        kept.push(question);
    }
    return { questions: kept, rejected };
};

const COUNT_AGGREGATIONS = new Set<AggregationType>(['count', 'count_distinct']);

/**
 * Holds questions on a melted period-series table to what its value column
 * means. Each row is one series in one period, so a measure question must name
 * one series, group by the series column, or (only when the intake verified
 * the series as additive) read detail rows. Counting records only shows how
 * many periods were published and is sent back.
 */
export const checkQuestionSeriesScope = (
    questions: readonly ResearchPlanQuestion[],
    semantics: SeriesMeasureSemantics | null | undefined,
): ResearchPlanValidation => {
    if (!semantics) return { questions: [...questions], rejected: [] };
    const { seriesColumn, measureColumn, periodColumn } = semantics;
    const example = semantics.series.find(series => series.observations > 1)?.name ?? semantics.series[0]?.name ?? '';
    const kept: ResearchPlanQuestion[] = [];
    const rejected: ResearchPlanValidation['rejected'] = [];
    for (const question of questions) {
        const reject = (reason: string) => rejected.push({ title: question.title, reason });
        if (question.series) {
            const known = semantics.series.find(series => sameName(series.name, question.series!));
            if (!known) {
                const repeated = semantics.series.filter(series => series.label !== undefined && sameName(series.label, question.series!));
                reject(repeated.length > 0
                    ? `"${question.series}" names ${repeated.length} different series. Copy one exact ${seriesColumn} value: ${repeated.map(series => `"${series.name}"`).join(', ')}.`
                    : `"${question.series}" is not a ${seriesColumn} value. Copy one exact ${seriesColumn} value, for example "${example}".`);
                continue;
            }
            kept.push({ ...question, series: known.name, filter: { column: seriesColumn, value: known.name } });
            continue;
        }
        const groupsBySeries = question.dimension !== null && sameName(question.dimension, seriesColumn);
        if (question.aggregation && COUNT_AGGREGATIONS.has(question.aggregation)) {
            reject(`Counting rows here only shows how many periods each series published. Measure ${measureColumn} of one named series instead (set series, dimension ${periodColumn}).`);
            continue;
        }
        const measuresValue = question.metric !== null && sameName(question.metric, measureColumn);
        if (!measuresValue || groupsBySeries) {
            kept.push(question);
            continue;
        }
        if (semantics.additiveAcrossSeries) {
            // Without a hierarchy every row is already a detail row.
            kept.push(semantics.detailRowColumns.length > 0
                ? { ...question, filter: { column: semantics.detailRowColumns[0], value: semantics.detailRowValue } }
                : question);
            continue;
        }
        reject(`${measureColumn} means something different for each ${seriesColumn} (${semantics.evidence.summary}) `
            + `Set series to one exact ${seriesColumn} value, for example "${example}", with ${periodColumn} as the dimension for a trend, or use ${seriesColumn} as the dimension.`);
    }
    return { questions: kept, rejected };
};

/**
 * On a hierarchy table the parent rows sit next to their detail rows, so every
 * question that measures something (a metric or a row count) reads detail rows
 * only. The filter is written onto the question, so it reaches the topic text
 * and every planner downstream.
 */
export const applyRowHierarchyScope = (
    questions: readonly ResearchPlanQuestion[],
    contract: RowHierarchyContract | null | undefined,
): ResearchPlanQuestion[] => questions.map(question =>
    contract && !question.filter && (question.metric !== null || question.aggregation !== null)
        ? { ...question, filter: { column: contract.rowClassColumn, value: contract.detailRowValue } }
        : question);

/** Reads per-group SUM and row COUNT for one dimension/metric pair; null when the data cannot be read. */
export type MeasureGroupSumAndCount = (dimension: string, metric: string) => Promise<GroupSumAndCount[] | null>;

/**
 * Checks each grouped SUM question against the data: when the SUM ranking of
 * the groups is essentially their row-count ranking, the question mostly
 * measures how many rows each group has. Such a question is sent back unless
 * Pi marked it as explicitly about total volume. A total over a time dimension
 * (by the column's date/time type) is a trend and is not checked. A failed
 * measurement never rejects anything.
 */
export const checkSumVolumeDependence = async (
    questions: readonly ResearchPlanQuestion[],
    measure: MeasureGroupSumAndCount,
    options: { profiles?: readonly ColumnProfile[]; signal?: AbortSignal } = {},
): Promise<ResearchPlanValidation> => {
    const kept: ResearchPlanQuestion[] = [];
    const rejected: ResearchPlanValidation['rejected'] = [];
    for (const question of questions) {
        if (question.aggregation !== 'sum' || !question.metric || !question.dimension || question.totalIntent
            || isTimeDimension(question.dimension, { profiles: options.profiles })) {
            kept.push(question);
            continue;
        }
        let groups: GroupSumAndCount[] | null = null;
        try {
            groups = await measure(question.dimension, question.metric);
        } catch (error) {
            if (isVolumeCheckCancellation(error, options.signal)) throw error;
            groups = null;
        }
        const dependence = groups ? assessVolumeDependence(groups) : null;
        if (!dependence?.volumeDriven) {
            kept.push(question);
            continue;
        }
        rejected.push({
            title: question.title,
            reason: `${describeVolumeDependence({ metric: question.metric, dimension: question.dimension, dependence })} `
                + `To compare ${question.dimension} groups, use median or avg of ${question.metric} per row. `
                + 'Keep sum only if the question is explicitly about total volume or value: then set total_intent to true and say "total" in the title.',
        });
    }
    return { questions: kept, rejected };
};
