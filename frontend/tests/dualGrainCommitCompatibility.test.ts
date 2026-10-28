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
import { executeCandidateAction } from '../services/agent/execution/executorCandidateActions';
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

describe('new dual-grain draft provenance does not disable the old multi-table API', () => {
    it('blocks direct/tool review, commit/recovery captures and copied approval objects while retaining both previews', async () => {
        const f = await setup(), originalPort = f.store.candidateStaging!;
        let issued: HostCandidateValidationContract | undefined;
        f.store.candidateStaging = { ...originalPort, bindInferredMeaning: (binding, context) => { issued = binding; return originalPort.bindInferredMeaning(binding, context); } };
        const { port, candidate, receipt } = await stage(f), database = vi.fn(), before = f.root.getState().datasetBundle;
        // Mutating the caller's issued metadata cannot modify the staging clone/private custody.
        issued!.inference!.proposalDigest = '0'.repeat(64);
        expect(port.commitRestriction(candidate.candidateId)).toBe('candidate_multi_table_atomic_promotion_unavailable');
        const service = createCandidateCommitService(f.store, { database });
        await expect(service.review(candidate.candidateId, { primaryTable: 'entities', idempotencyKey: 'new-draft' })).rejects.toThrow('candidate_multi_table_atomic_promotion_unavailable');
        for (const primaryTable of ['metrics', 'entities']) {
            const result = await executeCandidateAction({ type: 'tool_call', toolName: 'candidate.request_approval', args: { candidateId: candidate.candidateId, primaryTable } } as never, f.store);
            expect(result.status).toBe('blocked'); expect(result.message).toContain('candidate_multi_table_atomic_promotion_unavailable');
        }
        expect(() => port.captureCommitCheck(candidate.candidateId)).toThrow('candidate_multi_table_atomic_promotion_unavailable');
        expect(() => port.captureRecovery(candidate.candidateId)).toThrow('candidate_multi_table_atomic_promotion_unavailable');
        await expect(captureDatasetReplay(f.store, candidate, before!)).rejects.toThrow('candidate_multi_table_atomic_promotion_unavailable');
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
