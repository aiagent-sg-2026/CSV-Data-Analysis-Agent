import type {
    CanonicalBuildMeta,
    ColumnProfile,
    EvidenceHarnessContext,
    PreFilterClause,
    SqlEvidenceQueryPlan,
} from '../../../types';
import { mergeEvidencePreFilterIntoQuery } from './evidenceQuerySemantics';
import { restrictedValues, type SeriesMeasurePlanVerdict } from './seriesMeasureGuard';

/**
 * Guards analyses of a row table whose label column carried a verified
 * indentation hierarchy (Region / Country / Customer). The intake keeps the
 * published parent rows in the table, tagged RowClass = 'subtotal', next to
 * the detail rows (RowClass = 'fact'). Any aggregate that reads both counts
 * the same amount once per level, so every aggregate over the data must read
 * detail rows only. This module turns the intake's record
 * (`CanonicalBuildMeta.rowHierarchy`) into planner guidance, a deterministic
 * detail-row default, a pre-execution plan check and an evidence-gate verdict.
 */

export interface RowHierarchyContract {
    labelColumn: string;
    parentColumn: string;
    depthColumn: string;
    rowClassColumn: string;
    levelColumns: string[];
    detailRowValue: string;
}

const same = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Reads the hierarchy recorded at intake for the current analysis dataset.
 * When column profiles are known, the row-class and label columns must still
 * exist, so a later reshape or rename drops the guard instead of steering
 * against columns that are gone.
 */
export const resolveRowHierarchy = (state: {
    canonicalBuildMeta?: Pick<CanonicalBuildMeta, 'rowHierarchy'> | null;
    columnProfiles?: readonly Pick<ColumnProfile, 'name'>[] | null;
}): RowHierarchyContract | null => {
    const recorded = state.canonicalBuildMeta?.rowHierarchy ?? null;
    if (!recorded) return null;
    const profiles = state.columnProfiles ?? [];
    const has = (column: string) => profiles.some(profile => same(profile.name, column));
    if (profiles.length > 0 && !(has(recorded.rowClassColumn) && has(recorded.labelColumn))) return null;
    return {
        labelColumn: recorded.labelColumn,
        parentColumn: recorded.parentColumn,
        depthColumn: recorded.depthColumn,
        rowClassColumn: recorded.rowClassColumn,
        levelColumns: [...(recorded.levelColumns ?? [])],
        detailRowValue: recorded.detailRowValue,
    };
};

type PlanLike = Pick<SqlEvidenceQueryPlan, 'title' | 'queryMode' | 'query'> & Partial<Pick<SqlEvidenceQueryPlan, 'preFilter'>>;

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The detail-row restriction every aggregate over the table must carry. */
export const rowHierarchyDetailFilter = (contract: RowHierarchyContract) => ({
    column: contract.rowClassColumn,
    value: contract.detailRowValue,
});

type WhereClause = SqlEvidenceQueryPlan['query']['where'];

const readsDetailRowsOnly = (where: WhereClause, contract: RowHierarchyContract): boolean => {
    const values = restrictedValues(where, contract.rowClassColumn);
    return values !== null && values.length > 0 && values.every(value => same(value, contract.detailRowValue));
};

/**
 * A scope that cannot mix hierarchy levels without the detail-row filter: one
 * depth, or one named row.
 */
const readsOneLevelOrRow = (where: WhereClause, contract: RowHierarchyContract): boolean =>
    restrictedValues(where, contract.depthColumn)?.length === 1
    || restrictedValues(where, contract.labelColumn)?.length === 1;

const isSafeScope = (where: WhereClause, contract: RowHierarchyContract) =>
    readsDetailRowsOnly(where, contract) || readsOneLevelOrRow(where, contract);

/** True when the plan already states its own row scope, so no default filter is added. */
export const statesRowScope = (plan: Pick<SqlEvidenceQueryPlan, 'query'> & Partial<Pick<SqlEvidenceQueryPlan, 'preFilter'>>, contract: RowHierarchyContract): boolean => {
    const { where } = mergeEvidencePreFilterIntoQuery(plan.query, plan.preFilter);
    return isSafeScope(where, contract) || restrictedValues(where, contract.rowClassColumn) !== null;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assessRawSql = (sql: string, contract: RowHierarchyContract, title: string): SeriesMeasurePlanVerdict => {
    if (!/\b(?:sum|avg|mean|median|min|max|count|stddev|quantile_cont|percentile_cont)\s*\(/i.test(sql)) return PASS;
    const column = (name: string) => `(?:"${escapeRegex(name)}"|\\b${escapeRegex(name)}\\b)`;
    const detailFilter = new RegExp(`${column(contract.rowClassColumn)}\\s*(?:=|in\\s*\\()\\s*'${escapeRegex(contract.detailRowValue)}'`, 'i');
    const oneLevel = new RegExp(`${column(contract.depthColumn)}\\s*=\\s*\\d+`, 'i');
    if (detailFilter.test(sql) || oneLevel.test(sql)) return PASS;
    return reject(contract, title);
};

const PASS: SeriesMeasurePlanVerdict = { decision: 'pass', reasonCodes: [], feedback: null };

const reject = (contract: RowHierarchyContract, title: string): SeriesMeasurePlanVerdict => ({
    decision: 'reject',
    reasonCodes: ['series_hierarchy_double_count'],
    feedback: `The plan "${title}" aggregates rows that include both published parent rows ("${contract.rowClassColumn}" = 'subtotal') and their detail rows, so the same amount is counted once per hierarchy level. `
        + `Add WHERE "${contract.rowClassColumn}" = ${quote(contract.detailRowValue)} to every aggregate, including COUNT. `
        + (contract.levelColumns.length > 0
            ? `To compare one level, group by ${contract.levelColumns.map(column => `"${column}"`).join(' or ')} with that filter; each total is then the sum of its detail rows.`
            : `Group by "${contract.parentColumn}" or "${contract.labelColumn}" only together with that filter.`),
});

/**
 * Checks one evidence plan against the hierarchy recorded at intake.
 *
 * - An aggregate (SUM, AVG, MEDIAN, COUNT...) is valid when its rows are
 *   detail rows, one depth, or one named row. Otherwise it adds parents to
 *   their own children and the plan is rejected, so it is replanned or never
 *   shown as verified.
 * - A row listing over mixed levels stays a table.
 */
export const assessRowHierarchyPlan = (
    plan: PlanLike,
    contract: RowHierarchyContract | null | undefined,
): SeriesMeasurePlanVerdict => {
    if (!contract) return PASS;
    const query = mergeEvidencePreFilterIntoQuery(plan.query, plan.preFilter);
    if (typeof query.rawSql === 'string' && query.rawSql.trim()) {
        return assessRawSql(query.rawSql, contract, plan.title);
    }
    const aggregates = query.aggregates ?? [];
    if (aggregates.length === 0) {
        return isSafeScope(query.where, contract)
            ? PASS
            : { decision: 'table_only', reasonCodes: ['series_hierarchy_mix'], feedback: null };
    }
    const unsafe = aggregates.some(aggregate =>
        !isSafeScope(query.where, contract) && !isSafeScope(aggregate.where, contract));
    return unsafe ? reject(contract, plan.title) : PASS;
};

const RANK = { pass: 0, table_only: 1, reject: 2 } as const;

/** The stricter of two plan verdicts, with the reason codes of both. */
export const mergePlanVerdicts = (left: SeriesMeasurePlanVerdict, right: SeriesMeasurePlanVerdict): SeriesMeasurePlanVerdict => {
    const worst = RANK[right.decision] > RANK[left.decision] ? right : left;
    return {
        decision: worst.decision,
        reasonCodes: [...new Set([...left.reasonCodes, ...right.reasonCodes])],
        feedback: worst.feedback ?? left.feedback ?? right.feedback,
    };
};

/** Planner guidance stating how the hierarchy table may be aggregated; shared by every planner. */
export const buildRowHierarchyGuidance = (contract: RowHierarchyContract): string => {
    const { rowClassColumn: rc, detailRowValue: dv, labelColumn: label, parentColumn: parent } = contract;
    const levels = contract.levelColumns.length > 0
        ? ` Ancestor levels are columns ${contract.levelColumns.map(column => `"${column}"`).join(', ')}; grouping by one of them over detail rows gives that level's total, equal to the sum of its detail rows.`
        : '';
    return [
        `The rows of "${label}" form a hierarchy: published parent rows (${rc} = 'subtotal' or 'total') sit in the table next to their detail rows (${rc} = ${quote(dv)}), and each parent holds the sum of its children.`,
        `Every aggregate over the data (SUM, AVG, MEDIAN, MIN, MAX and COUNT of rows) must read detail rows only: WHERE "${rc}" = ${quote(dv)}. Without it each amount is counted once per level.`,
        `"${parent}" holds the direct parent of each row; with the detail-row filter, grouping by it compares one level.${levels}`,
        `Never rank parents and detail rows together, and never take shares against a total that includes parents.`,
    ].join('\n');
};

/** Steering with the hierarchy's detail-row contract, so every query path injects the same filter. */
export const withRowHierarchyDetailFilter = (
    steering: EvidenceHarnessContext,
    contract: RowHierarchyContract | null | undefined,
): EvidenceHarnessContext => {
    if (!contract) return steering;
    const filter = rowHierarchyDetailFilter(contract);
    return {
        ...steering,
        // The detail-row filter replaces the harness' label statistics (parent sums,
        // near-equal totals): a NOT IN list built from them removed real detail rows.
        excludeFromAggregation: [],
        hierarchyColumn: null,
        parentDescriptions: [],
        duplicateDescriptions: [],
        detailRowColumn: filter.column,
        detailRowValue: filter.value,
        detailRowFilter: { ...filter },
        detailRowPolicy: 'exclude_non_detail_rows',
        hierarchyMode: steering.hierarchyMode === 'none' || !steering.hierarchyMode ? 'preserve' : steering.hierarchyMode,
    };
};

/** Options for `applyEvidenceQuerySemanticDefaults` that apply the hierarchy's detail-row default. */
export const rowHierarchyDefaultOptions = (contract: RowHierarchyContract | null | undefined) =>
    contract
        ? {
            rowHierarchy: contract,
            statesRowScope: (plan: SqlEvidenceQueryPlan) => statesRowScope(plan, contract),
        }
        : {};

/**
 * Adds the detail-row filter to an evidence plan that states no row scope of
 * its own. It changes nothing else about the plan.
 */
export const withDetailRowScope = <T extends Pick<SqlEvidenceQueryPlan, 'query'> & { preFilter?: PreFilterClause[] }>(
    plan: T,
    contract: RowHierarchyContract | null | undefined,
): T => {
    if (!contract || statesRowScope(plan, contract)) return plan;
    const preFilter: PreFilterClause[] = [
        ...(plan.preFilter ?? []),
        { column: contract.rowClassColumn, operator: 'eq', value: contract.detailRowValue },
    ];
    return { ...plan, preFilter, query: mergeEvidencePreFilterIntoQuery(plan.query, preFilter) };
};
