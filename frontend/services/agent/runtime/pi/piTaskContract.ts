import type { DatasetScopeBinding, RuntimeTaskOutputRequirement } from '../../../../types';
import type { StoreApi } from '../../types';
import { assertRunActive, type ExecutionContext, type RunLease } from '../../../session/sessionOwnership';
import type { ResolvedAnswerScope } from './queryEvidence';
import { createTaskBudget, pauseTaskBudget, resumeTaskBudget, restoreTaskBudget, type TaskBudget } from './piTaskBudget';

export type AgentTaskStatus = 'queued' | 'awaiting_source' | 'inspecting' | 'programming' | 'executing'
    | 'validating' | 'awaiting_clarification' | 'awaiting_approval' | 'committing' | 'verifying'
    | 'completed' | 'blocked' | 'failed' | 'cancelled';
export interface TaskScopeContract { digest: string; intentDigest: string; answer: ResolvedAnswerScope }
export interface TaskReference { id: string; digest: string }
export type TaskOutputRequirement = RuntimeTaskOutputRequirement;
export interface AgentTaskDefinition {
    goal: string;
    kind: 'analysis' | 'repair' | 'artifact' | 'conversation';
    requiredOutputs: TaskOutputRequirement[];
    inputBindings: DatasetScopeBinding[];
    protectedInvariants: TaskReference[];
    scope: TaskScopeContract;
    capabilityGrants: TaskReference[];
}
export interface AgentTaskContract extends AgentTaskDefinition {
    schemaVersion: 1;
    taskId: string;
    sessionId: string;
    revision: number;
    status: AgentTaskStatus;
    budget: TaskBudget;
}
export interface TaskExecutionEnvelope {
    context: ExecutionContext;
    taskId: string;
    taskRevision: number;
    executorId: string;
    executorGeneration: string;
    inputBindings: DatasetScopeBinding[];
    workspaceRevision: string;
    grant: TaskReference;
    idempotencyKey: string;
}
export const TASK_EXECUTION_ERRORS = Object.freeze([
    'scope_revoked', 'input_version_changed', 'workspace_conflict', 'capability_unavailable',
    'protocol_incompatible', 'approval_invalid', 'validation_failed', 'resource_limit',
    'execution_failed', 'connector_disconnected', 'unknown_external_outcome',
] as const);
const transitions: Record<AgentTaskStatus, AgentTaskStatus[]> = {
    queued: ['awaiting_source', 'inspecting', 'cancelled'],
    awaiting_source: ['queued', 'inspecting', 'blocked', 'cancelled'],
    inspecting: ['programming', 'executing', 'awaiting_clarification', 'blocked', 'failed', 'cancelled'],
    programming: ['executing', 'awaiting_clarification', 'blocked', 'failed', 'cancelled'],
    executing: ['validating', 'programming', 'blocked', 'failed', 'cancelled'],
    validating: ['programming', 'awaiting_approval', 'committing', 'verifying', 'blocked', 'failed', 'cancelled'],
    awaiting_clarification: ['inspecting', 'blocked', 'cancelled'],
    awaiting_approval: ['committing', 'blocked', 'cancelled'],
    committing: ['verifying', 'blocked', 'failed', 'cancelled'],
    verifying: ['completed', 'executing', 'programming', 'awaiting_clarification', 'blocked', 'failed', 'cancelled'],
    blocked: ['queued', 'inspecting', 'cancelled'], completed: [], failed: [], cancelled: [],
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
const exact = (value: unknown, keys: string[]) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|'));
const definitionKeys = ['goal', 'kind', 'requiredOutputs', 'inputBindings', 'protectedInvariants', 'scope', 'capabilityGrants'];
const referenceList = (value: unknown): value is TaskReference[] => Array.isArray(value) && value.length <= 100
    && new Set(value.map(item => item?.id)).size === value.length
    && value.every(item => exact(item, ['id', 'digest']) && id(item.id) && hash(item.digest));
const isWaiting = (status: AgentTaskStatus) => ['awaiting_approval', 'awaiting_clarification', 'awaiting_source'].includes(status);
const validateDefinition = (value: AgentTaskDefinition) => {
    if (!value || typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > 4000
        || !['analysis', 'repair', 'artifact', 'conversation'].includes(value.kind)
        || !Array.isArray(value.requiredOutputs) || !value.requiredOutputs.length || value.requiredOutputs.length > 20
        || !value.requiredOutputs.some(output => output?.required === true)
        || new Set(value.requiredOutputs.map(output => output?.id)).size !== value.requiredOutputs.length
        || value.requiredOutputs.some(output => !exact(output, ['id', 'kind', 'required']) || !id(output.id)
            || !['dataset', 'answer', 'artifact', 'card'].includes(output.kind) || typeof output.required !== 'boolean')
        || !Array.isArray(value.inputBindings) || value.inputBindings.length > 20
        || new Set(value.inputBindings.map(binding => binding?.tableId)).size !== value.inputBindings.length
        || value.inputBindings.some(binding => !exact(binding, ['tableId', 'datasetVersion', 'relationshipSetId'])
            || !Object.values(binding).every(id))
        || !referenceList(value.protectedInvariants) || !referenceList(value.capabilityGrants)
        || !exact(value.scope, ['digest', 'intentDigest', 'answer']) || !hash(value.scope.digest) || !hash(value.scope.intentDigest)
        || !value.scope.answer || typeof value.scope.answer.requiresEvidence !== 'boolean'
        || !Array.isArray(value.scope.answer.queries) || !Array.isArray(value.scope.answer.unresolved)
        || typeof value.scope.answer.complete !== 'boolean'
        || value.scope.answer.dataPreparation !== undefined && value.scope.answer.dataPreparation !== 'canonical_fact_table') throw new Error('task_definition_invalid');
};
const snapshot = <T>(value: T): T => {
    const result = structuredClone(value);
    const freeze = (item: unknown) => {
        if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
    };
    freeze(result);
    return result;
};
const assertOwner = (store: StoreApi, task: AgentTaskContract, lease: RunLease) => {
    assertRunActive(store, lease);
    if (task.sessionId !== lease.scope.sessionId) throw new Error('task_session_mismatch');
};

/** Host API only. Model tool arguments cannot create ownership, grants or task identity. */
export const createAgentTask = (store: StoreApi, lease: RunLease, definition: AgentTaskDefinition): AgentTaskContract => {
    assertRunActive(store, lease);
    if (!exact(definition, definitionKeys)) throw new Error('task_definition_invalid');
    validateDefinition(definition);
    return snapshot({ ...definition, schemaVersion: 1, taskId: `task-${crypto.randomUUID()}`,
        sessionId: lease.scope.sessionId, revision: 1, status: 'queued', budget: createTaskBudget() });
};
export const restoreAgentTask = (value: unknown): AgentTaskContract => {
    const task = value as AgentTaskContract;
    if (!exact(task, [...definitionKeys, 'schemaVersion', 'taskId', 'sessionId', 'revision', 'status', 'budget'])
        || task.schemaVersion !== 1 || !id(task.taskId) || !id(task.sessionId)
        || !Number.isSafeInteger(task.revision) || task.revision < 1 || typeof task.status !== 'string'
        || !Object.hasOwn(transitions, task.status)) throw new Error('task_checkpoint_invalid');
    validateDefinition(task);
    const budget = restoreTaskBudget(task.budget);
    if (budget.pausedForUser !== isWaiting(task.status)) throw new Error('task_checkpoint_invalid');
    return snapshot({ ...task, budget });
};
export const transitionAgentTask = (store: StoreApi, task: AgentTaskContract, lease: RunLease, status: AgentTaskStatus): AgentTaskContract => {
    assertOwner(store, task, lease);
    if (!transitions[task.status]?.includes(status)) throw new Error('task_transition_invalid');
    const waiting = isWaiting(status);
    return snapshot({ ...task, status, budget: waiting ? pauseTaskBudget(task.budget) : resumeTaskBudget(task.budget) });
};
/** Object key order and absent optional fields do not change the semantic answer scope. Array order remains significant. */
export const serializeTaskAnswerScope = (answer: ResolvedAnswerScope): string => JSON.stringify(answer, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0)) : value);
export const reviseAgentTaskScope = (store: StoreApi, task: AgentTaskContract, lease: RunLease, scope: TaskScopeContract, goal = task.goal) => {
    assertOwner(store, task, lease);
    if (scope.intentDigest !== task.scope.intentDigest) throw new Error('task_intent_change_requires_clarification');
    validateDefinition({ ...task, scope, goal });
    const changed = scope.digest !== task.scope.digest;
    if (!changed && serializeTaskAnswerScope(scope.answer) !== serializeTaskAnswerScope(task.scope.answer)) throw new Error('task_scope_digest_mismatch');
    return { task: snapshot({ ...task, scope, goal, revision: task.revision + (changed ? 1 : 0) }),
        invalidated: changed ? ['evidence', 'candidates', 'approvals'] as const : [] as const };
};
export const createTaskExecutionEnvelope = (store: StoreApi, task: AgentTaskContract, context: ExecutionContext, options: {
    executorId: string; executorGeneration: string; workspaceRevision: string; grantRef: string;
}): TaskExecutionEnvelope => {
    assertOwner(store, task, context.lease);
    const grant = task.capabilityGrants.find(candidate => candidate.id === options.grantRef);
    if (!id(context.toolCallId) || (context.lease.kind === 'initial_analysis' ? !id(context.stepId) : !context.lease.turnId) || !grant
        || !['inspecting', 'programming', 'executing', 'validating', 'committing', 'verifying'].includes(task.status)
        || !exact(options, ['executorId', 'executorGeneration', 'workspaceRevision', 'grantRef'])
        || !Object.values(options).every(id)) throw new Error('task_execution_context_invalid');
    const state = store.getState();
    const inputBindings = task.inputBindings.map(binding => {
        const table = state.datasetBundle?.tables.find(candidate => candidate.tableId === binding.tableId);
        if (!table) throw new Error('task_input_unavailable');
        return { tableId: table.tableId, datasetVersion: table.datasetVersion,
            relationshipSetId: state.datasetBundle.relationshipSetId };
    });
    return Object.freeze({ context: Object.freeze({ ...context }), taskId: task.taskId, taskRevision: task.revision,
        executorId: options.executorId, executorGeneration: options.executorGeneration,
        workspaceRevision: options.workspaceRevision, inputBindings: snapshot(inputBindings),
        grant: snapshot(grant), idempotencyKey: crypto.randomUUID() });
};
