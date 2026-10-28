import type { ClarificationRequest, ClarificationOption } from '../../../../types';
import type { StoreApi } from '../../types';
import type { SpillMeaningProposal } from '../../../data/spillMeaningProposal';
import type { DualGrainCandidateMeaning } from '../../../data/dualGrainCandidateMeaning';
type MeaningProposal = SpillMeaningProposal | DualGrainCandidateMeaning;
import { codeDigest } from '../../execution/codeTableInputs';
import { captureSourceRangeFence } from '../../../data/immutableCsvSource';
import { checkpointLineageSignature } from './piInitialCheckpoint';
import { assertRunActive, captureSessionScope, registerSessionResource, rootStore, type SessionScope } from '../../../session/sessionOwnership';

type Entry = { id: string; proposal: MeaningProposal; alternative?: DualGrainCandidateMeaning; pending: ClarificationRequest; check: () => void;
    goal: string; taskId: string; sealed: boolean; resume?: (store: StoreApi) => Promise<unknown> };
const entries = new WeakMap<SessionScope, Entry>();
const confirmations = new WeakMap<SessionScope, { proposal: string; id: string; check: () => void; goal: string; taskId: string }>();

/** Semantic selections authorize one exact meaning interpretation, never a candidate or commit. */
export const spillMeaningConfirmation = (store: StoreApi, proposal: MeaningProposal) => {
    const c = confirmations.get(captureSessionScope(store));
    if (!c) return undefined;
    try { c.check(); } catch { confirmations.delete(captureSessionScope(store)); return undefined; }
    return c.taskId === store.piTask?.snapshot.taskId && c.goal === store.piTask?.snapshot.goal && c.proposal === JSON.stringify(proposal) ? c.id : undefined;
};
export const requestSpillMeaningChoice = (store: StoreApi, proposal: MeaningProposal, reasons: string[], alternative?: DualGrainCandidateMeaning, labels?: string[]) => {
    const scope = captureSessionScope(store), source = store.getState().datasetBundle!.source.inspection!;
    const root = rootStore(store), fence = captureSourceRangeFence(root, source.sourceId), signature = JSON.stringify(source), id = crypto.randomUUID();
    const captured = root.getState();
    const capturedLineage = checkpointLineageSignature(captured);
    const task = store.piTask!.snapshot, taskSignature = JSON.stringify([task.taskId, task.revision, task.goal, task.inputBindings, task.scope]);
    const check = () => {
        fence();
        const now = root.getState();
        if (JSON.stringify(now.datasetBundle?.source.inspection) !== signature || now.datasetBundle !== captured.datasetBundle
            || now.confirmedAnalysisGoal !== captured.confirmedAnalysisGoal || now.csvData !== captured.csvData
            || now.rawCsvData !== captured.rawCsvData || now.canonicalCsvData !== captured.canonicalCsvData
            || checkpointLineageSignature(now) !== capturedLineage
            || JSON.stringify([store.piTask!.snapshot.taskId, store.piTask!.snapshot.revision, store.piTask!.snapshot.goal, store.piTask!.snapshot.inputBindings, store.piTask!.snapshot.scope]) !== taskSignature) throw new Error('meaning_choice_stale');
    };
    check();
    const pending: ClarificationRequest = { interactionKind: 'clarification', clarificationMode: 'options', allowFreeText: false,
        question: 'tables' in proposal
            ? `Confirm only the exact source roles, alignment, grains, keys, units and footer scopes below — NOT Dataset Commit. Source SHA-256 ${source.sha256}. A: ${labels?.[0]}. ${JSON.stringify(proposal)}\nB: ${labels?.[1]}. ${JSON.stringify(alternative)}\nNeither stops without execution. Both interpretations passed structural checks; totals do not establish business meaning. Atomic multi-table acceptance is unavailable; only independently validated read-only drafts can follow.`
            : `Confirm only this source meaning (not Dataset Commit). Source SHA-256 ${source.sha256}. Header is physical record 1; grain is one ordered source record. ${reasons.join('; ')}. Interpretation A: ${JSON.stringify(proposal.stream.meaning)}. A declares these exact numeric units/scales and, if requested, that physical record ${source.recordCount} is a summary of ALL preceding detail records, not another detail record. B preserves ALL non-header records as raw text with no inferred units or summary exclusion. Neither stops; inspect/repair structural evidence rather than guessing.`,
        options: [{ label: 'A — Confirm exact interpretation', value: 'A' }, { label: alternative ? 'B — Confirm alternative interpretation' : 'B — Preserve raw text', value: 'B' }, { label: 'Neither', value: 'neither' }],
        resumeContext: { piSpillMeaningChoice: { id } } };
    entries.set(scope, { id, proposal: structuredClone(proposal), alternative: alternative && structuredClone(alternative), pending, check, goal: store.piTask!.snapshot.goal, taskId: store.piTask!.snapshot.taskId, sealed: false });
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
        || store.piTask?.snapshot.taskId !== e.taskId || store.piTask?.snapshot.goal !== e.goal || !e.pending.options?.some(o => o.value === choice.value && o.label === choice.label)) throw new Error('meaning_choice_stale');
    entries.delete(scope); e.check();
    store.setState({ pendingClarification: null });
    if (choice.value === 'neither') { store.setState({ isBusy: false, chatLifecycleState: 'blocked', initialAnalysisStatus: 'paused' }); return; }
    const proposal = structuredClone(choice.value === 'B' && e.alternative ? e.alternative : e.proposal);
    if (choice.value === 'B' && 'stream' in proposal) {
        proposal.stream.meaning.summary = 'none';
        proposal.stream.meaning.columns = proposal.stream.meaning.columns.map(c => ({ name: c.name, sourceColumn: c.sourceColumn, conversion: 'identity' }));
        proposal.assumptions = ['Human selected raw source-record text preservation; no business units or summary role inferred.'];
    }
    const id = await codeDigest({ selection: e.id, choice: choice.value, proposal }); e.check();
    assertRunActive(store, store.executionContext!.lease);
    confirmations.set(scope, { id, proposal: JSON.stringify(proposal), check: e.check, goal: e.goal, taskId: e.taskId });
    store.setState(state => ({ workspaceFiles: { ...state.workspaceFiles, '/intake/meaning-confirmation.json': JSON.stringify({ proposal, selectionDigest: id, commitAllowed: false }) } }));
    await e.resume!(store);
};
