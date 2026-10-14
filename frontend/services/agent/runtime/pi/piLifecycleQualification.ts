import type { StoreApi } from '../../types';
import { beginRun, beginSessionTransition, captureSessionScope, canCommitRun, finishRun,
    ownsSessionScope, registerSessionResource, scopeStore } from '../../../session/sessionOwnership';

/** Independent expected identities: a shortened, duplicated or renamed run cannot pass by count. */
export const LIFECYCLE_CASES = {
    retirement: ['revocation-before-cleanup', 'cleanup-failure-isolated', 'direct-replacement-fenced'],
    guest: ['complete-input', 'guest-global', 'network', 'storage', 'host-callback', 'import', 'serializer-tampering', 'utf8-output', 'infinite-loop', 'heap', 'heap-control', 'stack', 'stop-running-guest', 'recovery', 'input-ceiling', 'joint-ceiling', 'output-overflow'],
    sql: ['locked-pinned-profile', 'cte-current-binding', 'structured-query-compatible', 'app-unpivot-compatible', 'honest-truncation', 'access-write-refusals', 'output-byte-ceiling', 'replacement-binding', 'owned-cpu-stop', 'same-client-stop-recovery'],
    preparation: ['initial-default-off', 'initial-real-error-repair', 'initial-stateful-tail', 'initial-stop', 'initial-switch-new-run', 'initial-legacy-commit-refused', 'initial-legacy-cleaning-refused', 'follow-up-shared-real-executor'],
    staging: ['follow-up-stage-read-diff', 'partial-output-blocked', 'forged-lineage-blocked', 'abandoned-candidate-blocks-completion', 'source-cell-ragged-quoted-multiline', 'candidate-not-current-answer-evidence', 'shared-initial-candidate-stage'],
    validation: ['valid', 'wrong-group', 'duplicate', 'unit', 'amplification', 'ambiguous', 'missing-contract', 'forged', 'factual', 'source'],
    commit: ['atomic-success', 'abort-retry', 'quota-retry', 'same-key-concurrent', 'payload-conflict', 'version-contenders', 'approval-consumption', 'lost-ack', 'unknown-reconcile', 'unknown-abort-retry', 'head-read-failure', 'stale-projections', 'session-switch', 'binding-failure', 'metadata-reopen'],
    approval: ['fresh-commit-query', 'deny', 'edited-program', 'edited-input', 'revoked-grant', 'edited-policy', 'active-run-rejection', 'late-rebind', 'stop-before-admission'],
    recovery: ['source-reload', 'retained-reopen', 'source-mismatch', 'environment-unavailable', 'uncertain-effect', 'lost-ack-reload', 'uncertain-read', 'missing-retained-file', 'retention-quota', 'retention-write-failure', 'gc-pins-expiry', 'gc-session-boundary', 'gc-read-pin', 'rollback-append', 'rollback-awaiting-source', 'rollback-contender', 'interrupted-approval', 'interrupted-budget', 'history-fork-reopen', 'stateful-replay', 'multi-table-rollback'],
    skills: ['builtin-complete-table-through-real-pi', 'malicious-guidance-has-no-host-capabilities', 'support-guest-and-host-lineage', 'changed-instructions-refused', 'malicious-skill-cannot-complete-a-factual-answer', 'changed-support-refused', 'bad-hash-refused-before-execution', 'model-restriction-hides-guidance', 'unavailable-profile-visible-before-execution', 'central-policy-cannot-be-expanded', 'support-program-is-readonly', 'new-task-snapshot-retains-previous-digest'],
} as const;
export type LifecycleGroup = keyof typeof LIFECYCLE_CASES;
export interface LifecycleCase { id: string; passed: boolean; status?: string; elapsedMs?: number; details?: Record<string, unknown> }
export interface LifecycleResult { group: LifecycleGroup; passed: boolean; cases: LifecycleCase[]; error?: string }

export const completeLifecycleGroup = (expected: readonly string[], cases: readonly LifecycleCase[]): boolean =>
    expected.length > 0 && new Set(expected).size === expected.length
    && cases.length === expected.length && new Set(cases.map(c => c.id)).size === cases.length
    && cases.every(c => expected.includes(c.id) && c.passed === true);

export const completeLifecycleMatrix = (groups: readonly LifecycleResult[]): boolean =>
    groups.length === Object.keys(LIFECYCLE_CASES).length && new Set(groups.map(g => g.group)).size === groups.length
    && groups.every(g => g.passed === true && !g.error && Object.hasOwn(LIFECYCLE_CASES, g.group)
        && completeLifecycleGroup(LIFECYCLE_CASES[g.group], g.cases));

const qualifyRetirement = (): LifecycleCase[] => {
    const results: LifecycleCase[] = [];
    const fixture = () => {
        let state = { sessionId: `ca170-${crypto.randomUUID()}`, isBusy: false, finalSummary: {text: 'accepted', language: 'English'},
            initialAnalysisStatus: 'idle' } as unknown as ReturnType<StoreApi['getState']>;
        const root: StoreApi = {getState: () => state, setState: p => {state = {...state, ...(typeof p === 'function' ? p(state) : p)};}};
        return root;
    };
    {
        const root = fixture(), old = captureSessionScope(root), outgoing = scopeStore(root, old);
        let revoked = false;
        registerSessionResource(old, () => {revoked = !ownsSessionScope(root, old); outgoing.setState({finalSummary: {text: 'injected', language: 'English'}});});
        beginSessionTransition(root);
        results.push({id: 'revocation-before-cleanup', passed: revoked && root.getState().finalSummary?.text === 'accepted'});
    }
    {
        const root = fixture(), old = captureSessionScope(root), lease = beginRun(root, 'follow_up', 'old');
        let remaining = 0;
        registerSessionResource(old, () => {throw new Error('synthetic retirement fault');});
        registerSessionResource(old, () => {remaining++;});
        beginSessionTransition(root);
        const fresh = beginRun(root, 'follow_up', 'fresh');
        const passed = lease.signal.aborted && !ownsSessionScope(root, old) && remaining === 1 && canCommitRun(root, fresh);
        finishRun(root, lease, {isBusy: false});
        results.push({id: 'cleanup-failure-isolated', passed: passed && root.getState().activeExecution?.runId === 'fresh'});
        finishRun(root, fresh); beginSessionTransition(root);
    }
    {
        const root = fixture(), old = captureSessionScope(root), outgoing = scopeStore(root, old);
        registerSessionResource(old, () => outgoing.setState({isBusy: false}));
        root.setState({sessionId: 'replacement', isBusy: true}); captureSessionScope(root);
        results.push({id: 'direct-replacement-fenced', passed: root.getState().isBusy && !ownsSessionScope(root, old)});
        beginSessionTransition(root);
    }
    return results;
};

/** Synthetic namespaces only. Node HTTP/MCP and deferred coordination matrices are separate evidence. */
export const qualifyPiLifecycle = async (signal: AbortSignal, report?: (result: LifecycleResult) => void) => {
    const groups: LifecycleResult[] = [];
    const run = async (group: LifecycleGroup, work: () => Promise<readonly LifecycleCase[]> | readonly LifecycleCase[]) => {
        if (signal.aborted) return;
        let result: LifecycleResult;
        try {
            const cases = [...await work()];
            result = {group, cases, passed: !signal.aborted && completeLifecycleGroup(LIFECYCLE_CASES[group], cases)};
        } catch {
            result = {group, cases: [], passed: false, error: signal.aborted ? 'cancelled' : 'qualification_failed'};
        }
        groups.push(result); if (!signal.aborted) report?.(result);
    };
    await run('retirement', qualifyRetirement);
    await run('guest', async () => {
        const {qualifyJavaScriptGuest} = await import('../../../sandbox/javascriptGuestQualification');
        const state = {sessionId: `ca170-guest-${crypto.randomUUID()}`};
        const root = {getState: () => state, setState() {}} as unknown as StoreApi;
        return (await qualifyJavaScriptGuest(root, signal)).observations;
    });
    await run('sql', async () => (await (await import('../../../duckdb/sqlQualification')).qualifySqlWorker(signal)).checks);
    await run('preparation', async () => (await (await import('./piExecutorPreparationQualification')).qualifyPiExecutorPreparation(signal)).observations);
    await run('staging', async () => (await (await import('../../../data/candidateStagingQualification')).qualifyCandidateStaging(signal)).observations);
    await run('validation', async () => (await (await import('../../../data/candidateValidationQualification')).qualifyCandidateValidation(signal)).observations);
    await run('commit', async () => (await (await import('../../../data/candidateCommitQualification')).qualifyCandidateCommit(signal)).observations);
    await run('approval', async () => (await (await import('./piCandidateApprovalQualification')).qualifyPiCandidateApproval(signal)).observations);
    await run('recovery', async () => (await (await import('../../../data/datasetRecoveryQualification')).qualifyDatasetRecovery(signal)).observations);
    await run('skills', async () => (await (await import('../../skills/skillQualification')).qualifySkills(signal)).checks);
    return {profile: 'browser-first' as const, passed: !signal.aborted && completeLifecycleMatrix(groups), groups,
        limitations: ['Scripted providers only', 'HTTP MCP and deferred coordination require their separate real-server/runtime test evidence',
            'Full companion/stdio/native DB and Python have unavailable prerequisite tickets', 'Capacity and live-model qualification remain separate']};
};
