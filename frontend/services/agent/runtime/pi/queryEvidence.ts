import { normalizeEvidenceQueryPlan } from '../../execution/queryEvidencePolicy';
import type { ActiveDataQuery, QueryPlan, AppLanguage } from '../../../../types';
import type { StoreApi } from '../../types';
import type { QueryUnderstandingArtifact, GroundingResult, IntentClassificationFindings } from '../intentClassificationTypes';
import { getCurrentAnalysisDatasetVersion } from '../../artifactProvenance';
import { resolveDatasetScopeBinding } from '../../../data/datasetBundle';
import { buildEffectiveColumnRegistryFromState, getAllowedColumns, resolveColumnReference } from '../../../data/columnRegistry';
import { normalizeDataQueryPlanLike, validateDataQueryPayload } from '../../execution/dataQueryContract';
import { captureSessionScope, ownsSessionScope, assertRunActive, canCommitRun, type SessionScope, type RunLease } from '../../../session/sessionOwnership';
import { normalizeAbortError } from '../runtimeAbort';
import { getPreferredAnalysisDataset } from '../../reportStructureState';
import { requiresCompleteAggregateEvidence } from '../../derivedMetricIntent';

export interface RequestedQueryScope { role: string; plan: QueryPlan }
export interface QueryCalculation { operation: 'ratio' | 'percentage' | 'difference' | 'percent_change'; leftRole: string; rightRole: string }
export interface ResolvedAnswerScope {
    dataPreparation?: import('./piTaskPlan').TaskDataPreparation;
    requiresEvidence: boolean;
    queries: RequestedQueryScope[];
    complete: boolean;
    unresolved: string[];
    calculation?: QueryCalculation;
    computation?: import('../../execution/computationEvidence').RequestedComputationScope;
}
export interface QueryExecutionReceipt {
    taskId?: string;
    taskRevision?: number;
    answerScopeDigest?: string;
    queryId: string;
    scope: SessionScope;
    runId: string;
    turnId: string;
    toolCallId: string;
    query: ActiveDataQuery;
    semanticValidation: 'passed' | 'unverifiable';
}
declare const validatedEvidence: unique symbol;
export type ValidatedQueryEvidence = ActiveDataQuery & { readonly [validatedEvidence]: true };
export interface QueryGroundingVerdict {
    status: 'accepted' | 'clarification' | 'blocked';
    queryIds: string[];
    computationIds?: string[];
    reasons: string[];
    scope: ResolvedAnswerScope;
}

const issuedReceipts = new WeakMap<QueryExecutionReceipt, string>();

export const captureQueryIdentity = (store: StoreApi) => {
    if (store.isActive?.() === false) throw normalizeAbortError('The query owner was replaced.');
    const state = store.getState();
    const scope = captureSessionScope(store);
    const binding = resolveDatasetScopeBinding(state.datasetBundle);
    const datasetVersion = getCurrentAnalysisDatasetVersion(state);
    const context = store.executionContext;
    const task = store.piTask?.snapshot;
    const fields = {
        ...(task ? { taskId: task.taskId, taskRevision: task.revision, answerScopeDigest: task.scope.digest } : {}),
        ...binding, datasetVersion, datasetId: state.currentDatasetId ?? null,
        sessionId: scope.sessionId, sessionEpoch: scope.epoch, queryId: `query-${crypto.randomUUID()}`,
        runId: context?.lease.runId ?? state.activeTurn?.runId,
        turnId: context?.lease.turnId ?? state.activeTurn?.turnId,
        stepId: context?.stepId ?? state.activeTurn?.steps.at(-1)?.stepId,
        toolCallId: context?.toolCallId ?? state.activeTurn?.steps.at(-1)?.toolCallId,
    };
    const assertCurrent = () => {
        if (context) assertRunActive(store, context.lease);
        if (task && (store.piTask?.snapshot.taskId !== task.taskId || store.piTask.snapshot.revision !== task.revision
            || store.piTask.snapshot.scope.digest !== task.scope.digest)) throw normalizeAbortError('The query task was revised.');
        const currentBinding = resolveDatasetScopeBinding(store.getState().datasetBundle);
        if (store.isActive?.() === false || !ownsSessionScope(store, scope)
            || getCurrentAnalysisDatasetVersion(store.getState()) !== datasetVersion
            || JSON.stringify(currentBinding) !== JSON.stringify(binding)) {
            throw normalizeAbortError('The query no longer belongs to the current dataset.');
        }
    };
    return { fields, scope, assertCurrent };
};

export const createQueryReceipt = (store: StoreApi, query: ActiveDataQuery): QueryExecutionReceipt | null => {
    const lease = store.executionContext?.lease;
    if (!lease?.turnId || !store.executionContext?.toolCallId) return null;
    assertRunActive(store, lease);
    if (!query.queryId || query.sessionId !== lease.scope.sessionId || query.sessionEpoch !== lease.scope.epoch
        || query.runId !== lease.runId || query.turnId !== lease.turnId
        || query.toolCallId !== store.executionContext.toolCallId) return null;
    const task = store.piTask?.snapshot;
    if (task && (query.taskId !== task.taskId || query.taskRevision !== task.revision || query.answerScopeDigest !== task.scope.digest)) return null;
    const receipt: QueryExecutionReceipt = { taskId: task?.taskId, taskRevision: task?.revision, answerScopeDigest: task?.scope.digest, queryId: query.queryId, scope: lease.scope, runId: lease.runId, turnId: lease.turnId,
        toolCallId: query.toolCallId, query: structuredClone(query), semanticValidation: query.queryMode === 'raw_sql' || query.queryMode === 'unpivot' ? 'unverifiable' : 'passed' };
    issuedReceipts.set(receipt, JSON.stringify(receipt));
    return receipt;
};

const canonicalValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalValue(item)]));
    return value;
};
const canonicalWhere = (where: QueryPlan['where'] | QueryPlan['postAggregateFilter']) => ({
    predicates: (where?.predicates ?? []).map(item => JSON.stringify(canonicalValue(item))).sort(),
    groups: (where?.groups ?? []).map(group => group.predicates.map(item => JSON.stringify(canonicalValue(item))).sort()).sort(),
});
const same = (a: unknown, b: unknown) => JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
const completeList = /\b(all|every|each|complete|entire)\b|全部|所有|完整|すべて|全て/i;
const dataRequest = /\b(total|sum|average|count|margin|ratio|share|correlation|covariance|regression|median|percentile|variance|sales|revenue|October|September|rows?|dataset|data)\b|数据|數據|总额|總額|利润|利潤|占比|相关系数|相關係數/i;

const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const isoDate = (year: number, month: number) => new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);

/** Conservative interval matching; ambiguous or unsupported natural-language ranges stay unresolved. */
const validateTimeScope = (artifact: QueryUnderstandingArtifact, grounding: GroundingResult | undefined,
    queries: RequestedQueryScope[], store: StoreApi): string[] => {
    if (!artifact.timeScope || artifact.timeScope.kind === 'none') return [];
    const raw = artifact.timeScope.value ?? '';
    const anchor = grounding?.resolvedAnchors.find(item => item.type === 'time');
    const phrase = artifact.timeScope.kind === 'explicit' ? raw : anchor?.resolved ?? '';
    const state = store.getState();
    const dateColumns = state.columnProfiles.filter(profile => profile.type === 'date' || profile.type === 'time').map(profile => profile.name);
    // Lightweight profiles deliberately collapse strings to categorical. A
    // current independently validated date schema retains the stronger type.
    const bundle = state.datasetBundle;
    const version = getCurrentAnalysisDatasetVersion(state);
    const primary = bundle?.tables.find(table => table.tableId === bundle.primaryTableId);
    if (state.datasetCommitBindingStatus === 'ready' && bundle?.acceptedCommit && version
        && bundle.datasetVersion === version && primary?.datasetVersion === version) {
        dateColumns.push(...primary.schema.filter(column => column.dataType === 'date').map(column => column.name));
    }
    const used = queries.flatMap(query => [...(query.plan.where?.predicates ?? []), ...(query.plan.where?.groups ?? []).flatMap(group => group.predicates)]).map(predicate => predicate.column);
    const candidates = [...new Set(dateColumns)].filter(column => used.includes(column) && (!anchor?.column || anchor.column === column));
    if (candidates.length !== 1) return ['Specify an unambiguous date column for the requested period.'];
    const column = candidates[0];
    let year = phrase.match(/\b(?:19|20)\d{2}\b/)?.[0];
    if (!year && artifact.timeScope.kind === 'explicit') {
        const dataset = getPreferredAnalysisDataset(store.getState());
        // A bounded file preview cannot prove that a year is unique in the full dataset.
        if (dataset && dataset.backing?.mode !== 'duckdb_file') {
            const years = new Set(dataset.data.map(row => String(row[column] ?? '').match(/^(?:19|20)\d{2}/)?.[0]).filter(Boolean));
            if (years.size === 1) year = [...years][0];
        }
    }
    if (!year) return ['Specify the year and date column for the requested period.'];
    const monthIndex = months.findIndex(month => phrase.toLowerCase().includes(month));
    const month = monthIndex >= 0 ? monthIndex : phrase.match(/^\d{4}-(\d{2})(?:$|\b)/) ? Number(phrase.slice(5, 7)) - 1 : null;
    const quarter = phrase.match(/\bQ([1-4])\b/i)?.[1];
    const dates = phrase.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    const startMonth = quarter ? (Number(quarter) - 1) * 3 : month ?? 0;
    const width = quarter ? 3 : month !== null ? 1 : 12;
    const start = isoDate(Number(year), startMonth);
    const end = isoDate(Number(year), startMonth + width);
    if (dates.length || (month === null && !quarter && !/\byear\b|^\d{4}$|年/i.test(phrase))) {
        // Explicit day/range scopes remain typed contracts, but require exact ISO bounds from the user.
        if (dates.length !== 2) return ['Specify an exact date range or a month/quarter/year scope.'];
    }
    const reasons: string[] = [];
    for (const query of queries) {
        const previous = query.role === 'previous' && artifact.comparisonScope?.kind === 'previous_period';
        const expectedStart = dates.length ? dates[0] : previous ? isoDate(Number(year), startMonth - width) : start;
        const expectedEnd = dates.length ? dates[1] : previous ? start : end;
        const branches = query.plan.where?.groups?.length ? query.plan.where.groups.map(group => [...(query.plan.where?.predicates ?? []), ...group.predicates]) : [query.plan.where?.predicates ?? []];
        if (branches.some(branch => {
            const period = branch.filter(predicate => predicate.column === column);
            return period.length !== 2
                || !period.some(predicate => predicate.operator === 'gte' && predicate.value === expectedStart)
                || !period.some(predicate => predicate.operator === 'lt' && predicate.value === expectedEnd);
        })) reasons.push(`The ${query.role} query must cover the exact requested date interval [${expectedStart}, ${expectedEnd}).`);
    }
    return reasons;
};

export const canonicalPlan = (plan: QueryPlan, store: StoreApi): QueryPlan | null => {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || (plan.limit !== undefined && (typeof plan.limit !== 'number' || !Number.isInteger(plan.limit) || plan.limit <= 0)) || plan.rawSql || validateDataQueryPayload({ explanation: 'Requested answer scope', plan }).length) return null;
    const registry = buildEffectiveColumnRegistryFromState(store.getState());
    const allowed = new Set(getAllowedColumns(registry, 'select'));
    if (!allowed.size) store.getState().columnProfiles?.forEach(profile => allowed.add(profile.name));
    const column = (name: string) => resolveColumnReference(name, registry) ?? name;
    const normalized = normalizeDataQueryPlanLike(plan);
    if (!normalized) return null;
    const aliases = new Set(normalized.aggregates?.map(aggregate => aggregate.as) ?? []);
    const predicateColumns = (where: QueryPlan['where']) => [...(where?.predicates ?? []), ...(where?.groups ?? []).flatMap(group => group.predicates)].map(predicate => predicate.column);
    const sourceColumns = [...(normalized.groupBy ?? []), ...(normalized.select ?? []).filter(name => !aliases.has(name)),
        ...(normalized.aggregates ?? []).flatMap(aggregate => aggregate.column ? [aggregate.column] : []),
        ...predicateColumns(normalized.where), ...(normalized.aggregates ?? []).flatMap(aggregate => predicateColumns(aggregate.where)),
        ...(normalized.orderBy ?? []).filter(order => !aliases.has(order.column)).map(order => order.column)];
    if (sourceColumns.some(name => !allowed.has(column(name)))) return null;
    const normalizeWhere = (where: QueryPlan['where']) => where ? {
        predicates: where.predicates?.map(predicate => ({ ...predicate, column: column(predicate.column) })),
        groups: where.groups?.map(group => ({ predicates: group.predicates.map(predicate => ({ ...predicate, column: column(predicate.column) })) })),
    } : undefined;
    if (predicateColumns(normalized.postAggregateFilter).some(name => !aliases.has(name) && !(normalized.groupBy ?? []).includes(name))) return null;
    const where = normalizeWhere(normalized.where);
    return { ...normalized, where, select: normalized.select?.map(name => aliases.has(name) ? name : column(name)),
        groupBy: normalized.groupBy?.map(column),
        aggregates: normalized.aggregates?.map(aggregate => ({ ...aggregate, column: aggregate.column ? column(aggregate.column) : undefined, where: normalizeWhere(aggregate.where) })),
        orderBy: normalized.orderBy?.map(order => ({ ...order, column: aliases.has(order.column) ? order.column : column(order.column) })) };
};

export const resolveAnswerScope = (message: string, artifact: QueryUnderstandingArtifact | undefined,
    grounding: GroundingResult | undefined, store: StoreApi, findings?: IntentClassificationFindings): ResolvedAnswerScope => {
    const methodOnly = /\b(formula|definition|method|how (?:do|can|does|to)|explain how)\b|公式|计算方法|計算方法/i.test(message)
        && !/\b(by|where|only|October|September|this dataset|our data)\b|\d{4}-\d{2}|本数据|本數據/i.test(message);
    const requiresEvidence = findings?.intent === 'data_query' || artifact?.taskSignal && artifact.taskSignal !== 'converse'
        || Boolean(artifact?.requestedQueryScopes?.length) || Boolean(artifact?.requestedComputationScope) || artifact?.timeScope?.kind && artifact.timeScope.kind !== 'none'
        || !methodOnly && dataRequest.test(message);
    const unresolved = [...(grounding?.unresolvedAnchors ?? []), ...(artifact?.unresolvedReferences ?? [])
        .filter(reference => !grounding?.resolvedAnchors.some(anchor => anchor.raw === reference))];
    const dataPreparation = artifact?.requestedDataPreparation;
    if (dataPreparation !== undefined && dataPreparation !== null && dataPreparation !== 'canonical_fact_table') unresolved.push('Unsupported typed data preparation request.');
    const queries: RequestedQueryScope[] = [];
    for (const requested of artifact?.requestedQueryScopes ?? []) {
        if (!requested || typeof requested !== 'object' || typeof requested.role !== 'string') { unresolved.push('Invalid requested query scope.'); continue; }
        const plan = canonicalPlan(requested.plan, store);
        if (!plan || !requested.role || queries.some(query => query.role === requested.role)) unresolved.push('Invalid or duplicate requested query scope.');
        else queries.push({ role: requested.role, plan: normalizeEvidenceQueryPlan(plan, message) });
    }
    let computation = artifact?.requestedComputationScope;
    if (computation) {
        const bundle = store.getState().datasetBundle;
        const columns=computation.method==='pearson_correlation'&&typeof computation.x==='string'&&typeof computation.y==='string'
            ?[computation.x,computation.y]:(computation.method==='lower_weighted_median'||computation.method==='weighted_mean')&&typeof computation.value==='string'&&typeof computation.weight==='string'
                &&(computation.unitColumn===undefined||typeof computation.unitColumn==='string'&&computation.unitColumn.trim().length>0)?[computation.value,computation.weight,...(computation.unitColumn?[computation.unitColumn]:[])]:null;
        const allowed=computation.method==='pearson_correlation'?['method','x','y','where','missingPolicy','seed','tableId']
            :['method','value','weight','unitColumn','where','missingPolicy','weightPolicy','seed','tableId'];
        // Classifier examples use empty arrays for the full population. Only an explicitly empty,
        // well-shaped computation filter canonicalizes to no filter; malformed predicates still fail.
        const where=computation.where;
        const emptyWhere=where&&typeof where==='object'&&!Array.isArray(where)&&Object.keys(where).length>0
            &&Object.entries(where).every(([key,value])=>['predicates','groups'].includes(key)&&Array.isArray(value)&&value.length===0);
        const plan=columns?canonicalPlan({select:columns,where:emptyWhere?undefined:where},store):null;
        if (Object.keys(computation).some(key => !allowed.includes(key))
            || !['pearson_correlation','lower_weighted_median','weighted_mean'].includes(computation.method) || computation.missingPolicy !== 'pairwise_complete' || computation.seed !== 'none'
            || computation.method!=='pearson_correlation'&&computation.weightPolicy!=='nonnegative_integer_frequency'
            || !plan || !plan.select?.length || new Set(plan.select).size!==plan.select.length || !bundle?.primaryTableId
            || computation.tableId && computation.tableId !== bundle.primaryTableId || queries.length || artifact?.queryCalculation) {
            unresolved.push('Resolve one supported computation method, distinct value/weight or paired columns, typed scope, missing/weight policy and seed.');
            computation = undefined;
        } else {
            computation = computation.method==='pearson_correlation'
                ?{...computation,x:plan.select![0],y:plan.select![1],where:plan.where,tableId:bundle.primaryTableId}
                :{...computation,value:plan.select![0],weight:plan.select![1],...(computation.unitColumn?{unitColumn:plan.select![2]}:{}),where:plan.where,tableId:bundle.primaryTableId};
            const pseudo = [{role:'computation-input',plan}];
            if (artifact?.filterDescription && !plan.where?.predicates?.length && !plan.where?.groups?.length) unresolved.push('The computation filter has no typed predicate.');
            unresolved.push(...validateTimeScope(artifact!, grounding, pseudo, store));
        }
    }
    if (requiresEvidence && !queries.length && !computation) unresolved.push('The metric, grouping and typed filter scope must be resolved before answering.');
    if (artifact?.filterDescription && queries.some(query => !query.plan.where?.predicates?.length && !query.plan.where?.groups?.length)) {
        unresolved.push('The requested filter has no typed predicate.');
    }
    if (artifact && !computation) unresolved.push(...validateTimeScope(artifact, grounding, queries, store));
    const calculation = artifact?.queryCalculation;
    if (calculation && (!['ratio', 'percentage', 'difference', 'percent_change'].includes(calculation.operation)
        || calculation.leftRole === calculation.rightRole
        || ![calculation.leftRole, calculation.rightRole].every(role => queries.some(query => query.role === role)))) {
        unresolved.push('The derived calculation requires distinct, explicitly resolved evidence roles.');
    }
    return { requiresEvidence: Boolean(requiresEvidence), queries, calculation, computation, ...(dataPreparation === 'canonical_fact_table' ? {dataPreparation} : {}), complete: Boolean(calculation) || Boolean(computation) || requiresCompleteAggregateEvidence(message) || artifact?.taskSignal === 'derive_metric' || artifact?.resultCompleteness === 'complete' || completeList.test(message), unresolved: [...new Set(unresolved)] };
};

const planMatches = (expected: QueryPlan, actual: QueryPlan): boolean => {
    const aggregates = (plan: QueryPlan) => (plan.aggregates ?? []).map(canonicalValue);
    return !actual.rawSql && same(expected.groupBy ?? [], actual.groupBy ?? [])
        && same(aggregates(expected), aggregates(actual))
        && same(canonicalWhere(expected.where), canonicalWhere(actual.where))
        && same(canonicalWhere(expected.postAggregateFilter), canonicalWhere(actual.postAggregateFilter))
        && (!(expected.select?.length) || same(expected.select, actual.select))
        && same(expected.orderBy ?? [], actual.orderBy ?? [])
        && ((actual.limit ?? 500) === (expected.limit ?? 500));
};

export const admitQueryEvidence = (store: StoreApi, lease: RunLease, scope: ResolvedAnswerScope,
    receipts: QueryExecutionReceipt[]): { verdict: QueryGroundingVerdict; evidence: ValidatedQueryEvidence[] } => {
    const reasons = [...scope.unresolved];
    if (!canCommitRun(store, lease)) reasons.push('The run no longer owns the current session.');
    const evidence: ValidatedQueryEvidence[] = [];
    const queryIds: string[] = [];
    const binding = resolveDatasetScopeBinding(store.getState().datasetBundle);
    for (const required of scope.queries) {
        const task = store.piTask?.snapshot;
        const receipt = [...receipts].reverse().find(candidate => issuedReceipts.get(candidate) === JSON.stringify(candidate)
            && (!task || candidate.taskId === task.taskId && candidate.taskRevision === task.revision && candidate.answerScopeDigest === task.scope.digest)
            && candidate.scope === lease.scope
            && candidate.runId === lease.runId && candidate.turnId === lease.turnId
            && canCommitRun(store, lease) && candidate.semanticValidation === 'passed'
            && candidate.query.sessionId === lease.scope.sessionId && candidate.query.sessionEpoch === lease.scope.epoch
            && candidate.query.datasetId === (store.getState().currentDatasetId ?? null)
            && candidate.query.datasetVersion === getCurrentAnalysisDatasetVersion(store.getState())
            && candidate.query.tableId === binding.tableId && candidate.query.relationshipSetId === binding.relationshipSetId
            && planMatches(required.plan, candidate.query.plan)
            && same(candidate.query.plan.orderBy ?? [], candidate.query.result.appliedOrderBy)
            && ((candidate.query.plan.limit ?? 500) === candidate.query.result.appliedLimit)
            && Number.isSafeInteger(candidate.query.result.returnedRows) && candidate.query.result.returnedRows >= 0
            && Number.isSafeInteger(candidate.query.result.totalMatchedRows) && candidate.query.result.totalMatchedRows >= candidate.query.result.returnedRows
            && candidate.query.result.truncated === (candidate.query.result.totalMatchedRows > candidate.query.result.returnedRows)
            && (!candidate.query.plan.select?.length || same(candidate.query.plan.select, candidate.query.result.selectedColumns))
            && candidate.query.result.returnedRows <= candidate.query.result.appliedLimit
            && candidate.query.result.returnedRows === candidate.query.result.rows.length
            && (!scope.complete || (!candidate.query.result.truncated
                && candidate.query.result.returnedRows === candidate.query.result.totalMatchedRows)));
        if (!receipt) reasons.push(`No successful current-turn query matches the ${required.role} scope (execution/task/version, metric/group/filter/order/limit or completeness mismatch).`);
        else { evidence.push(receipt.query as ValidatedQueryEvidence); queryIds.push(receipt.queryId); }
    }
    const status = scope.unresolved.length ? 'clarification' : reasons.length || !queryIds.length ? 'blocked' : 'accepted';
    return { verdict: { status, queryIds, reasons, scope }, evidence };
};

export const formatValidatedQueryReply = (query: ValidatedQueryEvidence, language: AppLanguage): string => {
    const escaped = (value: unknown) => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
    if (!query.result.returnedRows) return language === 'Mandarin' ? '本轮查询没有匹配记录。' : 'The current query matched no rows.';
    const columns = query.result.selectedColumns;
    const table = [`| ${columns.map(escaped).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`,
        ...query.result.rows.map(row => `| ${columns.map(column => escaped(row[column])).join(' | ')} |`)];
    if (query.result.truncated) table.push('', `Showing ${query.result.returnedRows} of ${query.result.totalMatchedRows} matching rows.`);
    return table.join('\n');
};

/** Fixed formulas consume only admitted, complete inputs; there is no executable model expression. */
export const formatValidatedCalculation = (scope: ResolvedAnswerScope, evidence: ValidatedQueryEvidence[]): string | null => {
    const calculation = scope.calculation;
    if (!calculation) return null;
    const left = evidence[scope.queries.findIndex(query => query.role === calculation.leftRole)];
    const right = evidence[scope.queries.findIndex(query => query.role === calculation.rightRole)];
    if (!left || !right || !same(left.plan.groupBy ?? [], right.plan.groupBy ?? [])
        || left.plan.aggregates?.length !== 1 || right.plan.aggregates?.length !== 1) return null;
    const groups = left.plan.groupBy ?? [];
    const key = (row: typeof left.result.rows[number]) => JSON.stringify(groups.map(column => row[column]));
    const rightRows = new Map(right.result.rows.map(row => [key(row), row]));
    if (rightRows.size !== right.result.rows.length || rightRows.size !== left.result.rows.length) return null;
    if (!left.result.rows.length) return 'The current queries matched no rows.';
    const rows: string[] = [];
    for (const row of left.result.rows) {
        const other = rightRows.get(key(row));
        const a = row[left.plan.aggregates[0].as];
        const b = other?.[right.plan.aggregates[0].as];
        if (a === null || b === null || a === undefined || b === undefined || !Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return null;
        if (calculation.operation !== 'difference' && Number(b) === 0) return null;
        const value = calculation.operation === 'difference' ? Number(a) - Number(b)
            : calculation.operation === 'percent_change' ? (Number(a) - Number(b)) / Number(b) * 100
            : Number(a) / Number(b) * (calculation.operation === 'percentage' ? 100 : 1);
        if (!Number.isFinite(value)) return null;
        const percentage = calculation.operation === 'percentage' || calculation.operation === 'percent_change';
        rows.push(`${groups.map(column => `${column}: ${String(row[column]).replace(/[\r\n]+/g, ' ')}`).join(', ') || 'Result'}: ${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}${percentage ? '%' : ''}`);
    }
    return `${calculation.operation} (${calculation.leftRole}, ${calculation.rightRole}):\n${rows.join('\n')}`;
};
