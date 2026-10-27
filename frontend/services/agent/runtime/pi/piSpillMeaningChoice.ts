import type { ClarificationRequest, ClarificationOption } from '../../../../types';
import type { StoreApi } from '../../types';
import type { SpillMeaningProposal } from '../../../data/spillMeaningProposal';
import { codeDigest } from '../../execution/codeTableInputs';
import { captureSourceRangeFence } from '../../../data/immutableCsvSource';
import { assertRunActive, captureSessionScope, registerSessionResource, rootStore, type SessionScope } from '../../../session/sessionOwnership';

type Entry = { id: string; proposal: SpillMeaningProposal; pending: ClarificationRequest; check: () => void;
    goal: string; taskId: string; sealed: boolean; resume?: (store: StoreApi) => Promise<unknown> };
const entries = new WeakMap<SessionScope, Entry>();
const confirmations = new WeakMap<SessionScope, { proposal: string; id: string; check: () => void; goal: string }>();

/** Semantic selections authorize one exact meaning interpretation, never a candidate or commit. */
export const spillMeaningConfirmation = (store: StoreApi, proposal: SpillMeaningProposal) => {
    const c = confirmations.get(captureSessionScope(store));
    if (!c) return undefined;
    try { c.check(); } catch { confirmations.delete(captureSessionScope(store)); return undefined; }
    return c.goal === store.piTask?.snapshot.goal && c.proposal === JSON.stringify(proposal) ? c.id : undefined;
};
export const requestSpillMeaningChoice = (store: StoreApi, proposal: SpillMeaningProposal, reasons: string[]) => {
    const scope = captureSessionScope(store), source = store.getState().datasetBundle!.source.inspection!;
    const root = rootStore(store), fence = captureSourceRangeFence(root, source.sourceId), signature = JSON.stringify(source), id = crypto.randomUUID();
    const check = () => {
        fence();
        if (JSON.stringify(root.getState().datasetBundle?.source.inspection) !== signature) throw new Error('meaning_choice_stale');
    };
    check();
    const pending: ClarificationRequest = { interactionKind: 'clarification', clarificationMode: 'options', allowFreeText: false,
        question: `Confirm only this source meaning (not Dataset Commit). Source SHA-256 ${source.sha256}. Header is physical record 1; grain is one ordered source record. ${reasons.join('; ')}. Interpretation A: ${JSON.stringify(proposal.stream.meaning)}. A declares these exact numeric units/scales and, if requested, that physical record ${source.recordCount} is a summary of ALL preceding detail records, not another detail record. B preserves ALL non-header records as raw text with no inferred units or summary exclusion. Neither stops; inspect/repair structural evidence rather than guessing.`,
        options: [{ label: 'A — Confirm exact interpretation', value: 'A' }, { label: 'B — Preserve raw text', value: 'B' }, { label: 'Neither', value: 'neither' }],
        resumeContext: { piSpillMeaningChoice: { id } } };
    entries.set(scope, { id, proposal: structuredClone(proposal), pending, check, goal: store.piTask!.snapshot.goal, taskId: store.piTask!.snapshot.taskId, sealed: false });
    registerSessionResource(scope, () => { entries.delete(scope); confirmations.delete(scope); });
    return pending;
};
export const pendingSpillMeaningChoice = (store: StoreApi) => {
    const e = entries.get(captureSessionScope(store));
    return e && !e.sealed && e.taskId === store.piTask?.snapshot.taskId ? e.pending : undefined;
};
export const sealSpillMeaningChoice = (store: StoreApi, pending: ClarificationRequest, resume: NonNullable<Entry['resume']>) => {
    const e = entries.get(captureSessionScope(store));
    if (!e || e.sealed || pending.resumeContext?.piSpillMeaningChoice?.id !== e.id) throw new Error('meaning_choice_stale');
    e.check(); e.pending = structuredClone(pending); e.resume = resume; e.sealed = true;
};
export const resumeSpillMeaningChoice = async (store: StoreApi, pending: ClarificationRequest, choice: ClarificationOption) => {
    assertRunActive(store, store.executionContext!.lease);
    const scope = captureSessionScope(store), e = entries.get(scope);
    if (!e?.sealed || pending.resumeContext?.piSpillMeaningChoice?.id !== e.id || JSON.stringify([e.pending.question,e.pending.options,e.pending.resumeContext,e.pending.allowFreeText,e.pending.interactionKind,e.pending.clarificationMode]) !== JSON.stringify([pending.question,pending.options,pending.resumeContext,pending.allowFreeText,pending.interactionKind,pending.clarificationMode])
        || store.piTask?.snapshot.taskId !== e.taskId || !e.pending.options?.some(o => o.value === choice.value && o.label === choice.label)) throw new Error('meaning_choice_stale');
    entries.delete(scope); e.check();
    store.setState({ pendingClarification: null });
    if (choice.value === 'neither') { store.setState({ isBusy: false, chatLifecycleState: 'blocked', initialAnalysisStatus: 'paused' }); return; }
    const proposal = structuredClone(e.proposal);
    if (choice.value === 'B') {
        proposal.stream.meaning.summary = 'none';
        proposal.stream.meaning.columns = proposal.stream.meaning.columns.map(c => ({ name: c.name, sourceColumn: c.sourceColumn, conversion: 'identity' }));
        proposal.assumptions = ['Human selected raw source-record text preservation; no business units or summary role inferred.'];
    }
    const id = await codeDigest({ selection: e.id, choice: choice.value, proposal }); e.check();
    assertRunActive(store, store.executionContext!.lease);
    confirmations.set(scope, { id, proposal: JSON.stringify(proposal), check: e.check, goal: e.goal });
    store.setState(state => ({ workspaceFiles: { ...state.workspaceFiles, '/intake/meaning-confirmation.json': JSON.stringify({ proposal, selectionDigest: id, commitAllowed: false }) } }));
    await e.resume!(store);
};
