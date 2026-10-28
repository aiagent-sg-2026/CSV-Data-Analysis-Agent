// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { preparePiExecutor } from '../services/agent/runtime/pi/piExecutorPreparation';
import { syntheticDocumentGrainSource } from '../services/agent/runtime/pi/piDualGrainQualification';
import { pendingSpillMeaningChoice, sealSpillMeaningChoice, resumeSpillMeaningChoice } from '../services/agent/runtime/pi/piSpillMeaningChoice';
import { beginRun, beginSessionTransition, finishRun, scopeRunStore } from '../services/session/sessionOwnership';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { inferCandidateMeaning } from '../services/data/inferCandidateMeaning';
import { createCandidateStaging } from '../services/data/candidateStaging';
import { createCandidateCommitService } from '../services/data/candidateCommit';
import { readAcceptedDual } from '../services/data/acceptedDualGrain';
import { restoreAcceptedDataset } from '../services/data/datasetRecoveryActions';
import { validateRecoveryMaterial } from '../services/data/datasetRecovery';
import { dualCommitStorage } from './helpers/dualCommitStorage';
import { commitHeadKey } from '../types/datasetCommit';
import { captureDatasetReplay } from '../services/data/datasetReplay';
import type { HostCandidateValidationContract } from '../services/data/candidateValidationBinding';
import type { StoreApi } from '../services/agent/types';

const wasm = newQuickJSWASMModuleFromVariant(variant);
const guest = { run: (code: string, inputJson: string, options: { limits?: Parameters<typeof resolveGuestLimits>[0]; onStarted?: () => void }) =>
    executeQuickJsGuest({ generation: 1, code, inputJson, limits: resolveGuestLimits(options.limits) }, () => wasm, options.onStarted), cancel() {}, dispose() {} };
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(f => f()); vi.restoreAllMocks(); });
const setup = async () => {
    const fixture = syntheticDocumentGrainSource(42), data = { fileName: 'fictional.csv', data: [{ Id: 'original' }] };
    const goal = 'Validate two read-only source grains, never commit them';
    const bundle = createSingleTableDatasetBundle({ datasetId: crypto.randomUUID(), sourceFingerprint: 'pending', file: { name: data.fileName, size: 0, lastModified: 0 }, data });
    let state = { sessionId: crypto.randomUUID(), confirmedAnalysisGoal: goal, csvData: data, rawCsvData: data, canonicalCsvData: null, datasetBundle: bundle, columnProfiles: [], analysisCards: [], workspaceFiles: {},
        settings: { runtimeAccessControl: { permissionMode: 'open', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } } } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: p => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; } };
    const lease = beginRun(root, 'follow_up', 'compat-run', 'compat-turn'), store = scopeRunStore(root, lease);
    const source = await captureCsvSource(store, new File([fixture.text], data.fileName));
    root.setState({ datasetBundle: { ...bundle, source: { ...bundle.source, inspection: source } } });
    const prep = await preparePiExecutor(store, { entryPoint: 'follow_up', goal, guest });
    cleanup.push(() => { prep.task.close('cancelled'); finishRun(root, lease); beginSessionTransition(root); });
    store.executionContext = { lease, toolCallId: 'meaning', stepId: 'meaning' };
    return { fixture, root, store, lease, source, prep, data };
};
const bind = async (f: Awaited<ReturnType<typeof setup>>) => {
    await expect(inferCandidateMeaning(f.store, f.fixture.proposal)).rejects.toThrow('meaning_semantic_confirmation_required');
    const pending = pendingSpillMeaningChoice(f.store)!;
    sealSpillMeaningChoice(f.store, pending, async target => { await inferCandidateMeaning(target, f.fixture.proposal.interpretations[0].meaning); });
    await resumeSpillMeaningChoice(f.store, pending, pending.options![0]);
};
const stage = async (f: Awaited<ReturnType<typeof setup>>) => {
    await bind(f);
    // Parse the actual protected bytes and map physical cells in real QuickJS. No reference rows.
    const p = f.fixture.proposal.interpretations[0].meaning, workspace = f.store.codeExecution!.workspace;
    const program = await workspace.write('/workspace/compat.js', `
const raw=String.fromCharCode(...input.original.bytes).split('\\r\\n').map(r=>r.slice(1,-1).split('\",\"'));
const p=${JSON.stringify(p)};
return {schemaVersion:1,complete:true,tables:p.tables.map(t=>{const rows=[],lineage=[];
for(const range of t.detailRanges)for(let r=range.start;r<=range.end;r++)for(const projection of t.projections){const row={};
for(const c of t.columns){const m=projection.find(m=>m.column===c.name),value=raw[r][m.sourceColumn];row[c.name]=c.dataType==='number'?Number(value):value;
lineage.push({row:rows.length,column:c.name,origins:[{kind:'source',name:'original',row:r,column:m.sourceColumn}]});}rows.push(row);}
return {name:t.name,role:'fact',schema:t.columns.map(({name,dataType,nullable})=>({name,dataType,nullable})),rowCount:rows.length,rows,lineage};}),
relationships:p.relationships,excludedRows:p.exclusions.map(e=>({origin:{kind:'source',name:'original',row:e.row},reason:e.role}))};`, 0);
    const request = { program: { path: program.path, revision: program.revision, sha256: program.sha256 }, inputs: [],
        sources: [{ name: 'original', sourceId: f.source.sourceId, sha256: f.source.sha256, offset: 0, length: f.source.byteSize }], output: { path: '/workspace/compat.json', expectedRevision: 0, format: 'json' as const } };
    const context = { lease: f.lease, toolCallId: 'execute', stepId: 'execute' };
    await f.prep.task.beforeTool('code.run', request, context.toolCallId);
    const execution = await f.store.codeExecution!.run(request, context);
    expect(execution.status).toBe('succeeded');
    f.prep.task.afterTool('code.run', { status: 'success', toolName: 'code.run', message: 'executed', shouldStop: false, artifacts: { codeExecution: execution } }, context);
    const port = f.store.candidateStaging!, candidate = await port.stage(execution.jobId, { ...context, toolCallId: 'stage', stepId: 'stage' });
    const receipt = await port.validate(candidate.candidateId, { ...context, toolCallId: 'validate', stepId: 'validate' });
    expect(receipt.decision, JSON.stringify(receipt)).toBe('validated');
    return { port, candidate, receipt };
};

const exactSetup = async () => {
    const f = await setup(), staged = await stage(f), io = dualCommitStorage();
    let worker = 'prior', fault = '';
    const prepare = vi.fn(async (_marker, output, current) => {
        current(); expect(output.tables).toHaveLength(2);
        if (fault === 'one-table') throw new Error('injected_second_table');
        return { binding: { engine: 'duckdb' as const, tableName: 'native', loadVersion: 'exact', fallbackReason: null, fallbackStage: null },
            activate() { current(); worker = 'next'; if (fault === 'activate') throw new Error('injected_activation'); },
            rollback() { worker = 'prior'; }, finish() {}, dispose() {} };
    });
    const service = createCandidateCommitService(f.store, { database: async () => io.db, acceptedStorage: io.storage, prepareTablesBinding: prepare });
    const review = await service.review(staged.candidate.candidateId, { primaryTable: 'entities', idempotencyKey: 'dual-exact-intent' });
    return { ...f, ...staged, ...io, service, review, prepare, get worker() { return worker; }, fault(v: string) { fault = v; io.setFault(v); } };
};

describe('bounded all-table accepted publication', () => {
    it('releases review ownership and commits only with the exact capsule under a fresh task lease', async () => {
        const f = await exactSetup(), capsule = f.service.suspend(f.review);
        const pending = f.prep.task.suspend({ question: 'Exact both-table review', interactionKind: 'approval', options: [] });
        f.prep.task.close('blocked'); finishRun(f.root, f.lease);
        const lease = beginRun(f.root, 'follow_up', 'exact-fresh', 'exact-fresh'), store = scopeRunStore(f.root, lease);
        const prep = await preparePiExecutor(store, { entryPoint: 'follow_up', goal: f.prep.task.snapshot.goal, guest, continuation: pending.resumeContext!.piTaskContinuation });
        cleanup.push(() => { prep.task.close('cancelled'); finishRun(f.root, lease); });
        expect(() => f.service.resume(structuredClone(capsule), store)).toThrow('approval_invalid');
        f.service.resume(capsule, store);
        expect(await f.service.commit(f.service.approve(f.review))).toMatchObject({ status: 'committed', acknowledgement: 'installed' });
    });
    it('persists approved complete material, activates both grains, rejects replay, and authenticates restore', async () => {
        const f = await exactSetup(), before = f.root.getState().datasetBundle;
        expect(f.files.size).toBe(0); expect(f.root.getState().datasetBundle).toBe(before);
        const approval = f.service.approve(f.review);
        expect(await f.service.commit(structuredClone(approval))).toMatchObject({ status: 'not_committed', reason: 'approval_invalid' });
        const result = await f.service.commit(approval);
        expect(result).toMatchObject({ status: 'committed', acknowledgement: 'installed' }); expect(f.worker).toBe('next');
        expect(f.root.getState().datasetBundle!.tables).toHaveLength(2);
        const restored = await readAcceptedDual(result.marker!, () => {}, f.storage);
        expect(restored.output.tables.map(t => t.rowCount)).toEqual([2, 4]);
        expect(await f.service.commit(approval)).toMatchObject({ status: 'not_committed', reason: 'approval_consumed' });
        await restoreAcceptedDataset(f.store, {}, { database: async () => f.db, acceptedStorage: f.storage, prepareTablesBinding: f.prepare });
        expect(f.prepare).toHaveBeenCalledTimes(2);
        const file = f.files.get(f.review.acceptedDualGrain!.generation)!; file.text = file.text.replace('DOC-A', 'DOC-X');
        const accepted = f.root.getState().datasetBundle;
        // Guaranteed corruption even if the fixture key spelling changes.
        file.text += ' ';
        await expect(restoreAcceptedDataset(f.store, {}, { database: async () => f.db, acceptedStorage: f.storage, prepareTablesBinding: f.prepare })).rejects.toThrow();
        expect(f.root.getState().datasetBundle).toBe(accepted); expect(f.root.getState().datasetCommitBindingStatus).toBe('ready');
    });
    it.each(['quota', 'persist', 'one-table', 'activate'])('preserves original state and journal on %s failure', async fault => {
        const f = await exactSetup(), before = f.root.getState().datasetBundle;
        f.fault(fault);
        expect(await f.service.commit(f.service.approve(f.review))).toMatchObject({ status: 'not_committed' });
        expect(f.root.getState().datasetBundle).toBe(before); expect(f.worker).toBe('prior');
        expect(await f.db.get('dataset_commits', commitHeadKey(f.root.getState().sessionId))).toBeUndefined();
        expect(f.files.size).toBe(0);
    });
    it.each(['quota', 'persist', 'one-table', 'activate'])('preserves a real prior accepted two-table version on second %s failure', async fault => {
        const f = await exactSetup(), first = await f.service.commit(f.service.approve(f.review));
        expect(first.acknowledgement).toBe('installed');
        f.prep.task.close('completed'); finishRun(f.root, f.lease);
        const lease = beginRun(f.root, 'follow_up', 'second-dual', 'second-dual'), store = scopeRunStore(f.root, lease);
        const prep = await preparePiExecutor(store, { entryPoint: 'follow_up', goal: f.prep.task.snapshot.goal, guest });
        cleanup.push(() => { prep.task.close('cancelled'); finishRun(f.root, lease); });
        store.executionContext = { lease, toolCallId: 'second-meaning', stepId: 'second-meaning' };
        const next = { ...f, store, prep, lease };
        const { candidate } = await stage(next);
        const service = createCandidateCommitService(store, { database: async () => f.db, acceptedStorage: f.storage, prepareTablesBinding: f.prepare });
        const review = await service.review(candidate.candidateId, { primaryTable: 'entities', idempotencyKey: 'second-dual-intent' });
        const before = f.root.getState().datasetBundle;
        f.fault(fault);
        expect(await service.commit(service.approve(review))).toMatchObject({ status: 'not_committed' });
        expect(f.root.getState().datasetBundle).toBe(before); expect(f.root.getState().datasetCommitBindingStatus).toBe('ready');
        expect((await f.db.get('dataset_commits', commitHeadKey(f.root.getState().sessionId)))?.commitId).toBe(first.marker!.commitId);
        expect((await readAcceptedDual(first.marker!, () => {}, f.storage)).output.tables).toHaveLength(2);
    });
    it.each(['program', 'source', 'receipt', 'expiry', 'cancel'])('rejects %s changes after exact review', async fault => {
        const f = await exactSetup(), approval = f.service.approve(f.review);
        if (fault === 'program') await f.store.codeExecution!.workspace.write(f.candidate.execution.program!.path, 'return {};', 1);
        if (fault === 'source') f.root.setState({ datasetBundle: { ...f.root.getState().datasetBundle!, source: { ...f.root.getState().datasetBundle!.source, inspection: { ...f.source, sha256: 'f'.repeat(64) } } } });
        if (fault === 'receipt') await f.port.validate(f.candidate.candidateId, { lease: f.lease, toolCallId: 'again', stepId: 'again' });
        if (fault === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(f.review.expiresAt);
        if (fault === 'cancel') finishRun(f.root, f.lease);
        expect(await f.service.commit(approval)).toMatchObject({ status: 'not_committed', admitted: false });
        expect(f.files.size).toBe(0); expect(f.prepare).not.toHaveBeenCalled();
    });
    it('retains backing when the journal acknowledgement is uncertain, then restores only durable approved truth', async () => {
        const f = await exactSetup(); f.fault('unknown');
        expect(await f.service.commit(f.service.approve(f.review))).toMatchObject({ status: 'unknown', admitted: true, reason: 'commit_outcome_unknown' });
        expect(f.files.size).toBe(1); expect(f.root.getState().datasetCommitBindingStatus).toBe('commit_unknown');
        expect(f.root.getState().datasetBundle?.acceptedCommit).toBeUndefined();
        f.fault('');
        await restoreAcceptedDataset(f.store, {}, { database: async () => f.db, acceptedStorage: f.storage, prepareTablesBinding: f.prepare });
        expect(f.root.getState().datasetBundle!.tables).toHaveLength(2); expect(f.root.getState().datasetCommitBindingStatus).toBe('ready');
    });
    it('rejects changed relationship and missing table/schema/lineage during recovery', async () => {
        const f = await exactSetup(), result = await f.service.commit(f.service.approve(f.review));
        const material = (await readAcceptedDual(result.marker!, () => {}, f.storage)).material;
        for (const kind of ['relationship', 'table', 'lineage'] as const) {
            const marker = structuredClone(result.marker!);
            if (kind === 'relationship') marker.bundle.relationships[0].toKeys = ['wrong'];
            if (kind === 'table') marker.bundle.tables.pop();
            if (kind === 'lineage') marker.lineage.tables.pop();
            await expect(validateRecoveryMaterial(marker, material)).rejects.toThrow();
        }
    });
});

describe('new dual-grain draft provenance does not disable the old multi-table API', () => {
    it('prepares an exact all-table review for the bounded independently validated inferred candidate', async () => {
        const f = await setup(), { port, candidate } = await stage(f);
        const service = createCandidateCommitService(f.store);
        const review = await service.review(candidate.candidateId, { primaryTable: 'entities', idempotencyKey: 'bounded-dual-review' });
        expect(review.tables.map(t => [t.name, t.rowCount])).toEqual([['entities', 2], ['metrics', 4]]);
        expect(port.read(candidate.candidateId).relationships).toHaveLength(1);
        expect(f.root.getState().datasetBundle?.acceptedCommit).toBeUndefined();
        expect(() => service.approve(structuredClone(review))).toThrow('approval_invalid');
    });
    it('retains private custody, all-table review and both previews without granting authority to copied objects', async () => {
        const f = await setup(), originalPort = f.store.candidateStaging!;
        let issued: HostCandidateValidationContract | undefined;
        f.store.candidateStaging = { ...originalPort, bindInferredMeaning: (binding, context) => { issued = binding; return originalPort.bindInferredMeaning(binding, context); } };
        const { port, candidate, receipt } = await stage(f), database = vi.fn(), before = f.root.getState().datasetBundle;
        // Mutating the caller's issued metadata cannot modify the staging clone/private custody.
        issued!.inference!.proposalDigest = '0'.repeat(64);
        expect(port.commitRestriction(candidate.candidateId)).toBeNull();
        const service = createCandidateCommitService(f.store, { database });
        const reviewed = await service.review(candidate.candidateId, { primaryTable: 'entities', idempotencyKey: 'new-draft' });
        expect(reviewed.acceptedDualGrain).toBeDefined();
        await expect(service.review(candidate.candidateId, { primaryTable: 'metrics', idempotencyKey: 'wrong-primary' })).rejects.toThrow('candidate_primary_grain_required');
        expect(typeof port.captureCommitCheck(candidate.candidateId)).toBe('function');
        expect(port.captureRecovery(candidate.candidateId).binding.inference?.proposalDigest).not.toBe('0'.repeat(64));
        expect((await captureDatasetReplay(f.store, candidate, before!)).manifest.validationBinding.contract.tables).toHaveLength(2);
        const copied = structuredClone(candidate);
        Object.assign(copied, { draftOnly: false, commitAllowed: true }); copied.tables.pop(); copied.relationships = [];
        expect(() => Object.assign(candidate, { draftOnly: false })).toThrow();
        expect(() => service.approve(copied as never)).toThrow('approval_invalid');
        expect(await service.commit(copied as never)).toMatchObject({ status: 'not_committed', admitted: false, reason: 'approval_invalid' });
        await expect(service.recoveryCheckpoint(copied as never)).rejects.toThrow('approval_invalid');
        expect(() => service.suspend(copied as never)).toThrow('approval_invalid');
        expect(port.read(candidate.candidateId)).toBe(candidate); expect(port.read(candidate.candidateId).tables).toHaveLength(2);
        for (const table of ['entities', 'metrics']) expect(port.preview(candidate.candidateId, table, receipt.receiptDigest).rows.length).toBeGreaterThan(0);
        expect(database).not.toHaveBeenCalled(); expect(f.root.getState().datasetBundle).toBe(before); expect(f.root.getState().csvData).toBe(f.data);
    });
    it.each(['copy', 'tamper', 'other-namespace'] as const)('rejects %s inferred binding metadata rather than shedding draft provenance', async fault => {
        const f = await setup(), port = f.store.candidateStaging!, original = port.bindInferredMeaning;
        let captured: HostCandidateValidationContract | undefined;
        f.store.candidateStaging = { ...port, bindInferredMeaning: (binding, context) => { captured = binding; return original(binding, context); } };
        await bind(f); expect(captured).toBeDefined();
        const fresh = createCandidateStaging(f.store, f.store.codeExecution!.workspace, () => f.prep.task.snapshot, f.store.codeExecution!);
        cleanup.push(fresh.dispose);
        const binding = fault === 'other-namespace' ? captured! : structuredClone(captured!);
        if (fault === 'tamper') { binding.inference!.proposalDigest = '0'.repeat(64); binding.contract.tables.pop(); binding.contract.relationships = []; }
        expect(() => fresh.bindInferredMeaning(binding, f.store.executionContext!)).toThrow('meaning_binding_unavailable');
        expect(fresh.validationRequirements().configured).toBe(false);
        f.root.candidateValidationContract = structuredClone(captured!);
        expect(() => createCandidateStaging(f.store, f.store.codeExecution!.workspace, () => f.prep.task.snapshot, f.store.codeExecution!)).toThrow('meaning_binding_unavailable');
        delete f.root.candidateValidationContract;
    });
    it.each(['copy', 'mutate-original', 'remove-inference'] as const)('rejects %s at the issuing namespace before binding', async fault => {
        const f = await setup(), port = f.store.candidateStaging!;
        f.store.candidateStaging = { ...port, bindInferredMeaning: (binding, context) => {
            const forged = fault === 'mutate-original' ? binding : structuredClone(binding);
            if (fault === 'mutate-original') forged.inference!.proposalDigest = '0'.repeat(64);
            if (fault === 'remove-inference') { delete forged.inference; forged.contract = { ...forged.contract, tables: forged.contract.tables.slice(0, 1), relationships: [] }; }
            return port.bindInferredMeaning(forged, context);
        } };
        await expect(bind(f)).rejects.toThrow('meaning_binding_unavailable');
        expect(port.validationRequirements().configured).toBe(false);
    });
});
