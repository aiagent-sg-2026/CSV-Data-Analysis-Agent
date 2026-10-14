// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { prepareCandidateCommitFixture } from '../services/data/candidateCommitQualificationFixture';
import { createCandidateCommitService } from '../services/data/candidateCommit';
import { reconstructDatasetCommit, validateRecoveryMaterial } from '../services/data/datasetRecovery';
import { captureDatasetReplay } from '../services/data/datasetReplay';
import { codeDigest } from '../services/agent/execution/codeTableInputs';
import { sha256Bytes } from '../services/data/sourceDigest';
import { beginRun, beginSessionTransition, cancelOwnedRun, finishRun, scopeRunStore } from '../services/session/sessionOwnership';
import type { DatasetCommitMarker } from '../types/datasetCommit';

const wasm = newQuickJSWASMModuleFromVariant(variant);
const guest = { run: vi.fn((code, inputJson, options) => executeQuickJsGuest({ generation: 1, code, inputJson,
    limits: resolveGuestLimits(options.limits) }, () => wasm, options.onStarted)), running: false, cancel() {}, dispose() {} };
const original = () => new File(['Name,Amount\nTotal Solutions,0\n Detail ,-5\nSubtotal,-5\n'], 'synthetic-commit.csv');
const reviewed = async () => {
    const f = await prepareCandidateCommitFixture({ guest });
    const s = createCandidateCommitService(f.store);
    const review = await s.review(f.candidate.candidateId, { primaryTable: 'facts', idempotencyKey: 'recovery-12345678' });
    const checkpoint=await s.recoveryCheckpoint(review), recovery=await captureDatasetReplay(f.store,f.candidate,f.root.getState().datasetBundle!);
    return { ...f, review,marker:checkpoint.proposal,checkpoint,material:recovery.material };
};
const reseal=async(marker:DatasetCommitMarker)=>{const {digest:_digest,...body}=marker.replayManifest!;marker.replayManifest!.digest=await codeDigest(body);};
const deferred=()=>{let resolve!:(value:Awaited<ReturnType<typeof guest.run>>)=>void;const promise=new Promise<Awaited<ReturnType<typeof guest.run>>>(r=>resolve=r);return {promise,resolve};};

describe('dataset recovery does not replay uncertainty', () => {
    it('refuses missing replay metadata before executing any guest', async () => {
        const f = await reviewed();
        try {
            const calls = guest.run.mock.calls.length;
            await expect(reconstructDatasetCommit(f.store, { replayManifest: undefined } as DatasetCommitMarker,
                { file: original(), guest })).rejects.toThrow('recovery_metadata_unavailable');
            expect(guest.run.mock.calls).toHaveLength(calls);
        } finally { f.cleanup(); }
    });
    it('saves replay metadata and dependency references without source/output rows or approval authority',async()=>{
        const f=await reviewed();try{
            expect(f.marker.replayManifest!.roots.input).toEqual({kind:'csv_header',dynamicTyping:true});
            expect(JSON.stringify(f.marker)).not.toContain('"Amount":-5');
            expect(f.marker.approval.approvalId).toBe('');expect(f.marker.approval.consumedAt).toBe(0);
            expect(f.checkpoint.task.capabilityGrants).toEqual([]);expect(f.checkpoint.task.budget.used.transformationAttempts).toBe(1);
        }finally{f.cleanup();}
    });
    it('reconstructs from verified bytes in a new epoch and independently revalidates exact output',async()=>{
        const f=await reviewed();try{
            f.prep.task.close('cancelled');finishRun(f.root,f.lease);beginSessionTransition(f.root);
            const fresh=beginRun(f.root,'follow_up','recovery-fresh'),store=scopeRunStore(f.root,fresh);
            const result=await reconstructDatasetCommit(store,f.marker,{file:original(),guest});
            expect(result.output.tables[0].rows).toEqual([{Name:'Total Solutions',Amount:0},{Name:'Detail',Amount:-5}]);
            expect(f.root.getState().csvData!.data).toHaveLength(3);expect(f.root.getState().activeDataQuery).toBeNull();
            finishRun(f.root,fresh);
        }finally{f.cleanup();}
    });
    it.each(['bytes','structure','environment','effect','recipe','metadata','dependency'] as const)('blocks %s before guest execution',async(mode)=>{
        const f=await reviewed();try{
            const m=structuredClone(f.marker),calls=guest.run.mock.calls.length;
            let file=original(),reason='';
            if(mode==='bytes'){file=new File(['Name,Amount\nWrong,999\n'],'wrong.csv');reason='recovery_source_mismatch';}
            if(mode==='structure'){m.replayManifest!.source!.recordCount++;m.replayManifest!.inputBundle.source.inspection=m.replayManifest!.source!;await reseal(m);reason='recovery_source_structure_mismatch';}
            if(mode==='environment'){m.environment.runtime='uninstalled-engine';m.validation={...m.validation,environmentDigest:await codeDigest(m.environment)};reason='recovery_environment_unavailable';}
            if(mode==='effect'){(m.replayManifest as unknown as {effectSafety:string}).effectSafety='unknown_external_outcome';await reseal(m);reason='recovery_uncertain_effect';}
            if(mode==='recipe'){m.replayManifest!.roots.input=null;await reseal(m);reason='recovery_source_structure_unavailable';}
            if(mode==='metadata'){m.replayManifest!.request.output.path='/workspace/forged.json';reason='recovery_metadata_mismatch';}
            if(mode==='dependency'){m.replayManifest!.request.inputs.push({name:'needed',path:'/workspace/needed.json',revision:1,sha256:'a'.repeat(64)});await reseal(m);reason='recovery_dependency_unavailable';}
            await expect(reconstructDatasetCommit(f.store,m,{file,guest})).rejects.toThrow(reason);
            expect(guest.run.mock.calls).toHaveLength(calls);
        }finally{f.cleanup();}
    });
    it('blocks missing source without fallback to current rows or an old 999 query',async()=>{
        const f=await reviewed();try{
            f.root.setState({activeDataQuery:{result:{rows:[{Amount:999}]}}} as unknown as Partial<ReturnType<typeof f.root.getState>>);
            const calls=guest.run.mock.calls.length;
            await expect(reconstructDatasetCommit(f.store,f.marker,{guest})).rejects.toThrow('recovery_source_unavailable');
            expect(guest.run.mock.calls).toHaveLength(calls);
        }finally{f.cleanup();}
    });
    it('verifies retained rows without executing their program and rejects tampered validation input',async()=>{
        const f=await reviewed();try{
            const calls=guest.run.mock.calls.length;
            expect((await reconstructDatasetCommit(f.store,f.marker,{material:f.material,guest})).output.tables[0].rowCount).toBe(2);
            expect(guest.run.mock.calls).toHaveLength(calls);
            const bad=structuredClone(f.material);bad.validationInputs.tables.input[0].Amount=999;
            await expect(validateRecoveryMaterial(f.marker,bad)).rejects.toThrow('recovery_input_mismatch');
        }finally{f.cleanup();}
    });
    it('rejects an explicitly wrong source even when verified retained material is available',async()=>{
        const f=await reviewed();try{
            const calls=guest.run.mock.calls.length;
            await expect(reconstructDatasetCommit(f.store,f.marker,{file:new File(['Name,Amount\nWrong,999\n'],'wrong.csv'),material:f.material,guest}))
                .rejects.toThrow('recovery_source_mismatch');
            expect(guest.run.mock.calls).toHaveLength(calls);
        }finally{f.cleanup();}
    });
    it('rejects changed output rather than certifying nondeterminism or restoring an old receipt',async()=>{
        const f=await reviewed();try{
            const m=structuredClone(f.marker);m.program.content='return 999;';m.program.sha256=await sha256Bytes(new TextEncoder().encode(m.program.content));
            m.replayManifest!.request.program.sha256=m.program.sha256;m.validation={...m.validation,programDigest:m.program.sha256};await reseal(m);
            await expect(reconstructDatasetCommit(f.store,m,{file:original(),guest})).rejects.toThrow('recovery_output_mismatch');
        }finally{f.cleanup();}
    });
    it('requires the exact parent version and refuses a missing replay chain before execution',async()=>{
        const f=await reviewed();try{
            const m=structuredClone(f.marker),ref={sessionId:'missing-parent',commitId:'commit-missing',revision:1};
            m.replayManifest!.parent=ref;m.replayManifest!.inputBundle.acceptedCommit=ref;await reseal(m);
            const calls=guest.run.mock.calls.length;
            await expect(reconstructDatasetCommit(f.store,m,{file:original(),guest})).rejects.toThrow('recovery_parent_unavailable');
            await expect(reconstructDatasetCommit(f.store,m,{file:original(),guest,readParent:async()=>f.marker})).rejects.toThrow('recovery_parent_mismatch');
            expect(guest.run.mock.calls).toHaveLength(calls);
        }finally{f.cleanup();}
    });
    it.each(['stop','switch'] as const)('fences late replay result after %s and preserves a newer run',async(mode)=>{
        const f=await reviewed(),gate=deferred();try{
            const waiting={...guest,run:()=>gate.promise};
            const result=reconstructDatasetCommit(f.store,f.marker,{file:original(),guest:waiting});
            // The program-start signal is deterministic, with no sleep-based scheduling.
            let started!:()=>void;const start=new Promise<void>(r=>started=r);
            waiting.run=()=>{started();return gate.promise;};await start;
            if(mode==='stop')cancelOwnedRun(f.root);else{beginSessionTransition(f.root);f.root.setState({sessionId:'replacement',isBusy:true});}
            if(mode==='stop')finishRun(f.root,f.lease);
            const next=beginRun(f.root,'follow_up','newer-run'),before=JSON.stringify(f.root.getState());
            gate.resolve({generation:1,status:'completed',code:'completed',outputJson:f.material.outputText});
            await expect(result).rejects.toThrow();expect(JSON.stringify(f.root.getState())).toBe(before);expect(f.root.getState().activeExecution?.runId).toBe(next.runId);finishRun(f.root,next);
        }finally{gate.resolve({generation:1,status:'cancelled',code:'cancelled'});f.cleanup();}
    });
    it('allows an explicit exact file to rebuild a missing retained artifact',async()=>{
        const f=await reviewed();try{
            const result=await reconstructDatasetCommit(f.store,f.marker,{file:original(),guest,readMaterial:async()=>{throw new Error('retention_rows_unavailable');}});
            expect(result.output.tables[0].rowCount).toBe(2);
        }finally{f.cleanup();}
    });
});
