import type { StoreApi } from './types';
import type { StructureRepairReview } from '../../types/structureRepair';
import type { ReportIntakeIr } from '../../types/intake';
import { captureRecoverySource } from '../data/immutableCsvSource';
import { parseCsvTextWithDetection } from '../data/csvDialectDetector';
import { sha256Bytes } from '../data/sourceDigest';
import { solveHeaderAlignment } from './headerAlignment';
import { assertSessionResourceActive, captureSessionScope, ownsSessionScope, registerSessionResource, type SessionScope } from '../session/sessionOwnership';

type Entry = { view: StructureRepairReview; signature: string };
const reviews = new WeakMap<SessionScope, Entry>();
const repairRequired = new WeakSet<SessionScope>();
const signature = (intake: ReportIntakeIr) => JSON.stringify([intake.columnCount, intake.rawRows]);
const digest = (value: unknown) => sha256Bytes(new TextEncoder().encode(JSON.stringify(value)));
const publish = (store: StoreApi, entry: Entry) => {
    store.setState({ structureRepairReview: structuredClone(entry.view) });
    return structuredClone(entry.view);
};
const current = (store: StoreApi, scope: SessionScope, inputSignature: string, sha: string) => {
    assertSessionResourceActive(store, scope);
    const state = store.getState();
    if (!state.rawIntakeIr || signature(state.rawIntakeIr) !== inputSignature
        || state.datasetBundle?.source.inspection?.sha256 !== sha) throw new Error('repair_source_changed');
};

/** Reparse the complete retained bytes with the real intake parser, not a filename/metadata assertion.
 * Bound this initial slice to the existing 8 MiB recovery capture limit; never sample the identity.
 */
const evidence = async (store: StoreApi, scope: SessionScope) => {
    assertSessionResourceActive(store, scope);
    const state = store.getState(), intake = state.rawIntakeIr;
    const inspection = state.datasetBundle?.source.inspection;
    if (!intake || !inspection) throw new Error('repair_source_unavailable');
    const snapshot = structuredClone(intake), inputSignature = signature(snapshot);
    const source = captureRecoverySource(store, inspection.sourceId);
    const sha = await sha256Bytes(source.bytes);
    current(store, scope, inputSignature, sha);
    if (sha !== inspection.sha256 || sha !== source.metadata.sha256
        || inspection.byteSize !== source.bytes.length || source.metadata.diagnostics.includes('invalid_utf8')) throw new Error('repair_source_unverified');
    const parsed = parseCsvTextWithDetection(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes));
    if (JSON.stringify(parsed.rawRows) !== JSON.stringify(snapshot.rawRows)
        || parsed.rawRows.reduce((width, row) => Math.max(width, row.length), 0) !== snapshot.columnCount) throw new Error('repair_raw_rows_unverified');
    const alignment = await solveHeaderAlignment(snapshot);
    current(store, scope, inputSignature, sha);
    if (alignment.status !== 'semantic_review_required' || alignment.ambiguities.some(code => code === 'candidate_limit_reached' || code === 'header_scan_limited'))
        throw new Error('repair_alignment_unavailable');
    const candidateSetDigest = await digest(alignment.candidates);
    const choices = await Promise.all(alignment.candidates.map(async (candidate, i) => ({
        label: i < 26 ? String.fromCharCode(65 + i) : String(i + 1), candidateDigest: await digest(candidate), candidate,
    })));
    current(store, scope, inputSignature, sha);
    return { snapshot, inputSignature, sha, candidateSetDigest, choices };
};

/** The marker is host scoped and sticky until a real session/source transition, not semantic approval. */
export const isStructureRepairRequired = (store: StoreApi) => repairRequired.has(captureSessionScope(store))
    || store.getState().rawIntakeIr?.diagnostics?.headerShapeDrift === true
    || store.getState().pipelineOutcome?.reasonCode === 'header_shape_drift';

/** Guard the action, not just its button. A candidate cannot take the old canonicalization route. */
export const assertLegacyBoundaryAllowed = async (store: StoreApi): Promise<void> => {
    if (isStructureRepairRequired(store)) throw new Error('repair_requires_semantic_review_and_separate_exact_commit');
    const scope = captureSessionScope(store), intake = store.getState().rawIntakeIr;
    if (!intake) return;
    const inputSignature = signature(intake);
    const result = await solveHeaderAlignment(structuredClone(intake));
    assertSessionResourceActive(store, scope);
    if (!store.getState().rawIntakeIr || signature(store.getState().rawIntakeIr!) !== inputSignature) throw new Error('repair_source_changed');
    if (result.status === 'semantic_review_required') repairRequired.add(scope);
    if (isStructureRepairRequired(store) || result.status === 'unsupported') throw new Error('repair_requires_semantic_review_and_separate_exact_commit');
};

export const prepareStructureRepairReview = async (store: StoreApi): Promise<StructureRepairReview | null> => {
    const scope = captureSessionScope(store);
    const intake = store.getState().rawIntakeIr;
    if (!intake) return null;
    const inputSignature = signature(intake);
    const result = await solveHeaderAlignment(structuredClone(intake));
    assertSessionResourceActive(store, scope);
    if (!store.getState().rawIntakeIr || signature(store.getState().rawIntakeIr!) !== inputSignature) throw new Error('repair_source_changed');
    if (result.status !== 'semantic_review_required') {
        if (isStructureRepairRequired(store)) throw new Error('repair_alignment_unavailable');
        store.setState({ structureRepairReview: null });
        return null;
    }
    repairRequired.add(scope);
    const bound = await evidence(store, scope);
    const prior = reviews.get(scope);
    if (prior && prior.signature === bound.inputSignature && prior.view.sourceSha256 === bound.sha
        && prior.view.candidateSetDigest === bound.candidateSetDigest && !['cancelled', 'stale'].includes(prior.view.status)) return publish(store, prior);
    const entry: Entry = { signature: bound.inputSignature, view: {
        reviewId: crypto.randomUUID(), status: 'awaiting_semantic_confirmation', sessionId: scope.sessionId, sessionEpoch: scope.epoch,
        sourceSha256: bound.sha, sourceVersion: bound.sha, candidateSetDigest: bound.candidateSetDigest,
        choices: bound.choices, selectedCandidateDigest: null, commitAllowed: false,
        message: 'Which header group owns the repeated categories? Confirm only this mapping interpretation; row grain, units and totals still require validation. This is not Dataset Commit approval.',
    } };
    reviews.set(scope, entry);
    registerSessionResource(scope, () => { reviews.delete(scope); repairRequired.delete(scope); });
    return publish(store, entry);
};

const getReview = (store: StoreApi, reviewId: string, status: StructureRepairReview['status']) => {
    const scope = captureSessionScope(store), entry = reviews.get(scope);
    assertSessionResourceActive(store, scope);
    if (!entry || entry.view.reviewId !== reviewId || entry.view.status !== status) throw new Error('repair_review_stale_or_replayed');
    return { scope, entry };
};
const recheck = async (store: StoreApi, scope: SessionScope, entry: Entry) => {
    try {
        const bound = await evidence(store, scope);
        if (reviews.get(scope) !== entry || bound.inputSignature !== entry.signature || bound.sha !== entry.view.sourceSha256
            || bound.candidateSetDigest !== entry.view.candidateSetDigest) throw new Error('repair_review_stale');
        return bound;
    } catch (error) {
        if (ownsSessionScope(store, scope) && reviews.get(scope) === entry) {
            entry.view = { ...entry.view, status: 'stale', draft: undefined, message: 'Source or candidate changed. Re-open review from the current source; the previous choice is invalid.' };
            publish(store, entry);
        }
        throw error;
    }
};

export const confirmStructureRepairMeaning = async (store: StoreApi, reviewId: string, choice: string): Promise<StructureRepairReview> => {
    const { scope, entry } = getReview(store, reviewId, 'awaiting_semantic_confirmation');
    if (choice !== 'neither' && !entry.view.choices.some(c => c.candidateDigest === choice)) throw new Error('repair_choice_invalid');
    // Claim synchronously before any await: double clicks cannot authorize two interpretations.
    entry.view.status = 'resuming';
    const bound = await recheck(store, scope, entry);
    if (entry.view.status !== 'resuming') throw new Error('repair_review_cancelled');
    current(store, scope, bound.inputSignature, bound.sha);
    entry.view.status = choice === 'neither' ? 'neither' : 'confirmed';
    entry.view.selectedCandidateDigest = choice === 'neither' ? null : choice;
    entry.view.message = choice === 'neither'
        ? 'Neither interpretation was confirmed. Repair remains blocked. Upload a corrected source or request a corrected mapping; no dataset was committed.'
        : 'Mapping meaning confirmed. Resume read-only mapping draft processing; independent validation and separate exact Dataset Commit approval are still required.';
    return publish(store, entry);
};

/** Actual bounded continuation: build a positional, read-only mapping draft, never an accepted table.
 * No aggregation, type coercion, grain declaration, converter, provider or query binding is invoked.
 */
export const resumeStructureRepairDraft = async (store: StoreApi, reviewId: string): Promise<StructureRepairReview> => {
    const { scope, entry } = getReview(store, reviewId, 'confirmed');
    entry.view.status = 'resuming';
    const bound = await recheck(store, scope, entry);
    if (entry.view.status !== 'resuming') throw new Error('repair_review_cancelled');
    const candidate = bound.choices.find(c => c.candidateDigest === entry.view.selectedCandidateDigest)?.candidate;
    if (!candidate) throw new Error('repair_choice_invalid');
    const columns = candidate.mappings.map(mapping => ({ ...mapping,
        headerPath: mapping.headerPath.map(ref => ({ ...ref, value: bound.snapshot.rawRows[ref.rowIndex][ref.columnIndex] })),
    }));
    const start = candidate.bodySourceRows.start, end = candidate.bodySourceRows.endExclusive;
    const rows = bound.snapshot.rawRows.slice(start, Math.min(end, start + 3)).map((cells, i) => ({ sourceRow: start + i, cells }));
    current(store, scope, bound.inputSignature, bound.sha);
    entry.view = { ...entry.view, status: 'draft_uncommitted', draft: {
        label: 'Draft / Uncommitted', validation: 'not_validated', columns, rows, totalSourceRows: end - start, truncated: end - start > rows.length,
    }, message: 'Read-only mapping draft prepared. Source row boundaries, business grain, units, summary reconciliation and full candidate validation remain unverified. Formal analysis stays blocked until separate exact commit and binding.' };
    return publish(store, entry);
};

export const cancelStructureRepairReview = (store: StoreApi, reviewId?: string): void => {
    const scope = captureSessionScope(store), entry = reviews.get(scope);
    if (!entry || reviewId && entry.view.reviewId !== reviewId) return;
    entry.view = { ...entry.view, status: 'cancelled', selectedCandidateDigest: null, draft: undefined, message: 'Review cancelled. Dataset unchanged; re-open review to start a fresh confirmation.' };
    publish(store, entry);
};
