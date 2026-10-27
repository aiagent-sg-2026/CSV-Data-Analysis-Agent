// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { sha256Bytes } from '../services/data/sourceDigest';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import { prepareStructureRepairReview, confirmStructureRepairMeaning, resumeStructureRepairDraft, cancelStructureRepairReview, assertLegacyBoundaryAllowed } from '../services/agent/structureRepairConfirmation';

const raw = () => [
    ['Entity', 'North', 'South', 'North', 'South'],
    ['Count', 'Rate', 'Count', 'Rate'],
    ['id-a', '0', '', '-3', '0.5', 'left', 'right'],
    ['id-b', '2', 'N/A', '4', '0', 'left', 'right'],
    ['TOTAL', 'unverified'],
];
const fixture = async (text = raw().map(row => row.join(',')).join('\r\n')) => {
    let state = { sessionId: crypto.randomUUID(), rawIntakeIr: null, datasetBundle: null,
        csvData: { fileName: 'fictional.csv', data: [{ original: 'unchanged' }] }, canonicalCsvData: null,
        analysisCards: [], workspaceFiles: {}, refreshDuckDbSession: vi.fn(), handleInitialAnalysis: vi.fn(),
    } as unknown as ReturnType<StoreApi['getState']>;
    const store: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    const attach = async (content: string, name = 'fictional.csv') => {
        const source = await captureCsvSource(store, new File([content], name));
        const parsed = parseCsvTextWithDetection(content);
        store.setState({ rawIntakeIr: buildReportIntakeIr(name, parsed.rawRows, parsed.detection),
            datasetBundle: { source: { inspection: source }, acceptedCommit: undefined } as never });
        return source;
    };
    const source = await attach(text);
    return { store, source, attach, text };
};
const choose = async (store: StoreApi, index = 0) => {
    const review = await prepareStructureRepairReview(store);
    if (!review) throw new Error('review_missing');
    await confirmStructureRepairMeaning(store, review.reviewId, review.choices[index].candidateDigest);
    return review;
};

describe('host-bound structural semantic confirmation and read-only resume', () => {
    it.each([0, 1])('selects exact interpretation %i and resumes only a read-only mapping draft', async index => {
        const { store, source, text } = await fixture();
        const before = store.getState();
        const review = await choose(store, index);
        expect(review.sourceSha256).toBe(await sha256Bytes(new TextEncoder().encode(text)));
        expect(review.sourceVersion).toBe(source.sha256);
        expect(review.choices).toHaveLength(2);
        const draft = await resumeStructureRepairDraft(store, review.reviewId);
        expect(draft.status).toBe('draft_uncommitted');
        expect(draft.selectedCandidateDigest).toBe(review.choices[index].candidateDigest);
        expect(draft.draft?.columns).toHaveLength(7);
        expect(draft.draft?.rows[0]).toEqual({ sourceRow: 2, cells: raw()[2] });
        expect(draft.draft?.columns.find(c => c.targetColumn === (index === 0 ? 1 : 3))?.headerPath).toHaveLength(2);
        expect(draft.commitAllowed).toBe(false);
        expect(draft.draft?.validation).toBe('not_validated');
        expect(store.getState().csvData).toBe(before.csvData);
        expect(store.getState().canonicalCsvData).toBe(before.canonicalCsvData);
        expect(store.getState().datasetBundle).toBe(before.datasetBundle);
        expect(store.getState().datasetBundle?.acceptedCommit).toBeUndefined();
        expect(store.getState().refreshDuckDbSession).not.toHaveBeenCalled();
        expect(store.getState().handleInitialAnalysis).not.toHaveBeenCalled();
    });
    it('preserves an already accepted commit, cards and workspace throughout semantic confirmation and draft processing', async () => {
        const { store } = await fixture();
        store.setState({ datasetBundle: { ...store.getState().datasetBundle!, acceptedCommit: { commitId: 'prior-approved' } } as never,
            analysisCards: [{ id: 'prior-card' }] as never, workspaceFiles: { '/existing': 'untouched' } });
        const before = store.getState();
        const review = await choose(store);
        await resumeStructureRepairDraft(store, review.reviewId);
        expect(store.getState().datasetBundle).toBe(before.datasetBundle);
        expect(store.getState().datasetBundle?.acceptedCommit?.commitId).toBe('prior-approved');
        expect(store.getState().analysisCards).toBe(before.analysisCards);
        expect(store.getState().workspaceFiles).toBe(before.workspaceFiles);
    });
    it.each(['bytes', 'session', 'candidate'] as const)('rejects %s drift before the semantic choice is recorded', async change => {
        const { store, attach, text } = await fixture();
        const review = (await prepareStructureRepairReview(store))!;
        if (change === 'bytes') await attach(text.replace('id-a', 'id-c'));
        if (change === 'session') beginSessionTransition(store);
        if (change === 'candidate') store.getState().rawIntakeIr!.rawRows[0][3] = 'Other';
        await expect(confirmStructureRepairMeaning(store, review.reviewId, review.choices[0].candidateDigest)).rejects.toThrow();
        expect(store.getState().structureRepairReview?.status).not.toBe('confirmed');
    });
    it('binds BOM, quotes, embedded newlines and line endings to exact bytes, not canonical rows', async () => {
        const rows = raw(); rows[2][0] = '"id,a\nsecond line"';
        const text = '\uFEFF' + rows.map(row => row.join(',')).join('\r\n');
        const { store, attach } = await fixture(text);
        const review = await choose(store);
        expect(review.sourceSha256).toBe(await sha256Bytes(new TextEncoder().encode(text)));
        expect((await resumeStructureRepairDraft(store, review.reviewId)).draft?.rows[0].cells[0]).toBe('id,a\nsecond line');
        cancelStructureRepairReview(store, review.reviewId);
        const next = await choose(store);
        await attach(text.replace(/^\uFEFF/, '')); // Exactly the same parsed rawRows, different byte identity.
        await expect(resumeStructureRepairDraft(store, next.reviewId)).rejects.toThrow();
    });
    it('revokes an in-flight resume when cancelled and rejects a persisted UI projection as authority', async () => {
        const { store } = await fixture();
        const review = await choose(store);
        const pending = resumeStructureRepairDraft(store, review.reviewId);
        cancelStructureRepairReview(store, review.reviewId);
        await expect(pending).rejects.toThrow('repair_review_cancelled');
        const projection = store.getState().structureRepairReview;
        beginSessionTransition(store);
        store.setState({ structureRepairReview: { ...projection!, status: 'confirmed' } });
        await expect(resumeStructureRepairDraft(store, review.reviewId)).rejects.toThrow();
    });
    it('keeps the host repair marker pending after semantic confirmation, draft resume and forged UI approval', async () => {
        const { store } = await fixture();
        const review = await choose(store);
        await resumeStructureRepairDraft(store, review.reviewId);
        store.getState().rawIntakeIr!.diagnostics.headerShapeDrift = false;
        store.setState({ structureRepairReview: null, pipelineOutcome: { status: 'ready' } as never });
        await expect(assertLegacyBoundaryAllowed(store)).rejects.toThrow('repair_requires_semantic_review_and_separate_exact_commit');
        expect(store.getState().datasetBundle?.acceptedCommit).toBeUndefined();
    });
    it('keeps Neither blocked with a corrective next action', async () => {
        const { store } = await fixture();
        const review = (await prepareStructureRepairReview(store))!;
        await confirmStructureRepairMeaning(store, review.reviewId, 'neither');
        expect(store.getState().structureRepairReview).toMatchObject({ status: 'neither', commitAllowed: false });
        expect(store.getState().structureRepairReview?.message).toContain('corrected source');
        await expect(resumeStructureRepairDraft(store, review.reviewId)).rejects.toThrow();
    });
    it.each(['bytes', 'rows', 'width', 'session', 'epoch', 'candidate'] as const)('rejects stale %s after confirmation', async change => {
        const { store, attach, text } = await fixture();
        const review = await choose(store);
        if (change === 'bytes') await attach(text + '\r\n'); // Same parsed meaning, different raw bytes.
        if (change === 'rows') store.getState().rawIntakeIr!.rawRows[2][1] = '999';
        if (change === 'width') store.getState().rawIntakeIr!.columnCount++;
        if (change === 'session') store.setState({ sessionId: 'replacement' });
        if (change === 'epoch') beginSessionTransition(store);
        if (change === 'candidate') {
            const rows = raw(); rows[0][3] = 'Other';
            await attach(rows.map(row => row.join(',')).join('\r\n'));
        }
        await expect(resumeStructureRepairDraft(store, review.reviewId)).rejects.toThrow();
        expect(store.getState().datasetBundle?.acceptedCommit).toBeUndefined();
        expect(store.getState().refreshDuckDbSession).not.toHaveBeenCalled();
    });
    it('allows a harmless renamed source with identical bytes in the same epoch', async () => {
        const { store, attach, text } = await fixture();
        const review = await choose(store);
        await attach(text, 'renamed.csv');
        expect((await resumeStructureRepairDraft(store, review.reviewId)).status).toBe('draft_uncommitted');
    });
    it('rejects a fabricated inspection SHA and mismatched raw rows', async () => {
        const { store } = await fixture();
        store.setState({ datasetBundle: { source: { inspection: { ...store.getState().datasetBundle!.source.inspection!, sha256: 'a'.repeat(64) } } } as never });
        await expect(prepareStructureRepairReview(store)).rejects.toThrow();
        const second = await fixture();
        second.store.getState().rawIntakeIr!.rawRows[2][1] = '999';
        await expect(prepareStructureRepairReview(second.store)).rejects.toThrow();
    });
    it('rejects forged choices, repeated clicks and replay without creating another draft', async () => {
        const { store } = await fixture();
        const review = (await prepareStructureRepairReview(store))!;
        await expect(confirmStructureRepairMeaning(store, review.reviewId, 'a'.repeat(64))).rejects.toThrow();
        const fresh = (await prepareStructureRepairReview(store))!;
        const results = await Promise.allSettled([0, 1].map(() => confirmStructureRepairMeaning(store, fresh.reviewId, fresh.choices[0].candidateDigest)));
        expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        const resumes = await Promise.allSettled([0, 1].map(() => resumeStructureRepairDraft(store, fresh.reviewId)));
        expect(resumes.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        await expect(confirmStructureRepairMeaning(store, fresh.reviewId, fresh.choices[1].candidateDigest)).rejects.toThrow();
        await expect(resumeStructureRepairDraft(store, fresh.reviewId)).rejects.toThrow();
    });
    it('cancels authority and refuses an old choice after re-opening or new-file transition', async () => {
        const { store, attach, text } = await fixture();
        const review = await choose(store);
        cancelStructureRepairReview(store, review.reviewId);
        await expect(resumeStructureRepairDraft(store, review.reviewId)).rejects.toThrow();
        const fresh = (await prepareStructureRepairReview(store))!;
        expect(fresh.reviewId).not.toBe(review.reviewId);
        beginSessionTransition(store);
        await attach(text);
        await expect(confirmStructureRepairMeaning(store, fresh.reviewId, fresh.choices[0].candidateDigest)).rejects.toThrow();
    });
});
