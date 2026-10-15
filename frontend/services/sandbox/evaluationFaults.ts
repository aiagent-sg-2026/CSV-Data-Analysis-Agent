import type { StoreApi } from '../agent/types';
import type { CodeExecutionReceipt } from '../agent/execution/codeExecutionContract';
import { captureSessionScope, ownsSessionScope, registerSessionResource, rootStore } from '../session/sessionOwnership';

export interface EvaluationFault {
    kind: 'program_failure'; execution: number; scheduleSha256: string;
}
export interface EvaluationFaultPolicy { scheduleSha256: string; executions: number[] }
const scopes = new WeakMap<StoreApi['getState'], {
    scope: ReturnType<typeof captureSessionScope>; policy: EvaluationFaultPolicy;
    execution: number; receipts: Readonly<CodeExecutionReceipt>[];
}>();

/** Explicit operator instrumentation. Neither model arguments nor persisted settings install this port. */
export const installEvaluationFaults = (store: StoreApi, policy: EvaluationFaultPolicy) => {
    const key = rootStore(store).getState;
    if (scopes.has(key) || !policy || Object.keys(policy).sort().join(',') !== 'executions,scheduleSha256'
        || !/^[a-f0-9]{64}$/.test(policy.scheduleSha256) || !Array.isArray(policy.executions)
        || policy.executions.length !== 1 || policy.executions[0] !== 1) throw new Error('evaluation_fault_policy_invalid');
    const state = { scope: captureSessionScope(store), policy: structuredClone(policy), execution: 0, receipts: [] as Readonly<CodeExecutionReceipt>[] };
    scopes.set(key, state);
    const dispose = () => { if (scopes.get(key) === state) scopes.delete(key); };
    const unregister = registerSessionResource(state.scope, dispose);
    return {
        snapshot: () => ({ scheduleSha256: state.policy.scheduleSha256, receipts: structuredClone(state.receipts) }),
        dispose: () => { dispose(); unregister(); },
    };
};

export const consumeEvaluationFault = (store: StoreApi): EvaluationFault | undefined => {
    const state = scopes.get(rootStore(store).getState);
    if (!state || !ownsSessionScope(store, state.scope)) return;
    const execution = ++state.execution;
    if (state.policy.executions.includes(execution)) return { kind: 'program_failure', execution, scheduleSha256: state.policy.scheduleSha256 };
};

export const recordEvaluationExecution = (store: StoreApi, receipt: Readonly<CodeExecutionReceipt>) => {
    const state = scopes.get(rootStore(store).getState);
    if (state && ownsSessionScope(store, state.scope) && state.receipts.length < 40
        && !state.receipts.some(item => item.jobId === receipt.jobId)) state.receipts.push(receipt);
};

/** Keep evaluator instrumentation in host custody; the model needs the failure, not the schedule identity. */
export const modelExecutionReceipt = (value: Readonly<CodeExecutionReceipt> | Readonly<CodeExecutionReceipt>[] | undefined): unknown => {
    if (Array.isArray(value)) return value.map(item => modelExecutionReceipt(item));
    if (!value?.environment?.evaluationFault) return value;
    const { environment: _environment, ...publicReceipt } = value;
    return publicReceipt;
};
