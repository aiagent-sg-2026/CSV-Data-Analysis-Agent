// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { preparePiExecutor } from '../services/agent/runtime/pi/piExecutorPreparation';
import { syntheticStreamedDualSource } from '../services/agent/runtime/pi/piDualGrainQualification';
import { pendingSpillMeaningChoice, sealSpillMeaningChoice, resumeSpillMeaningChoice } from '../services/agent/runtime/pi/piSpillMeaningChoice';
import { beginRun, beginSessionTransition, finishRun, scopeRunStore } from '../services/session/sessionOwnership';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { inferCandidateMeaning } from '../services/data/inferCandidateMeaning';
import { createCandidateCommitService } from '../services/data/candidateCommit';
import { readAcceptedStreamedDual } from '../services/data/acceptedStreamedDual';
import { restoreAcceptedDataset } from '../services/data/datasetRecoveryActions';
import { dualCommitStorage } from './helpers/dualCommitStorage';
import { commitHeadKey } from '../types/datasetCommit';
import type { StoreApi } from '../services/agent/types';

const wasm = newQuickJSWASMModuleFromVariant(variant);
const guest = { run: (code: string, inputJson: string, options: { limits?: Parameters<typeof resolveGuestLimits>[0]; onStarted?: () => void }) =>
    executeQuickJsGuest({ generation: 1, code, inputJson, limits: resolveGuestLimits(options.limits) }, () => wasm, options.onStarted), cancel() {}, dispose() {} };
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(f => f()); vi.restoreAllMocks(); });
const setup = async (prior?:{root:StoreApi;source:Awaited<ReturnType<typeof captureCsvSource>>;io:ReturnType<typeof dualCommitStorage>}) => {
    const fixture=syntheticStreamedDualSource(80),data={fileName:'fictional-streamed.csv',data:[]},goal='Validate both streamed source grains and request exact all-table approval';
    const bundle=createSingleTableDatasetBundle({datasetId:crypto.randomUUID(),sourceFingerprint:'pending',file:{name:data.fileName,size:fixture.text.length,lastModified:0},data});
    let state={sessionId:crypto.randomUUID(),confirmedAnalysisGoal:goal,csvData:data,rawCsvData:data,canonicalCsvData:null,datasetBundle:bundle,columnProfiles:[],analysisCards:[],workspaceFiles:{},
        settings:{runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}}} as unknown as ReturnType<StoreApi['getState']>;
    const root:StoreApi=prior?.root??{getState:()=>state,setState:p=>{state={...state,...(typeof p==='function'?p(state):p)};}};
    const lease=beginRun(root,'follow_up','streamed-dual','streamed-dual'),store=scopeRunStore(root,lease);
    const source=prior?.source??await captureCsvSource(store,new File([fixture.text],data.fileName));
    expect(source.byteSize).toBeGreaterThan(65536);
    if(!prior)root.setState({datasetBundle:{...bundle,source:{...bundle.source,inspection:source}}});
    const prep=await preparePiExecutor(store,{entryPoint:'follow_up',goal,guest,spillFactory:async()=>{const map=new Map<string,string>();return {
        async put(n,t){if(map.has(n))throw new Error('spill_immutable_conflict');map.set(n,t);},async get(n){const v=map.get(n);if(v===undefined)throw new Error('missing');return v;},async remove(){map.clear();}};}});
    cleanup.push(()=>{prep.task.close('cancelled');finishRun(root,lease);beginSessionTransition(root);});
    store.executionContext={lease,toolCallId:'meaning',stepId:'meaning'};
    const beforeMeaning=root.getState().datasetBundle;
    await expect(inferCandidateMeaning(store,fixture.proposal)).rejects.toThrow('meaning_semantic_confirmation_required');
    expect(root.getState().datasetBundle).toBe(beforeMeaning);
    const pending=pendingSpillMeaningChoice(store)!;
    sealSpillMeaningChoice(store,pending,async target=>{await inferCandidateMeaning(target,fixture.proposal.interpretations[0].meaning);});
    await resumeSpillMeaningChoice(store,pending,pending.options![0]);
    const program=await store.codeExecution!.workspace.write('/workspace/streamed-dual.js','return {state:{},rows:input.records.map(r=>({sourceRow:r.sourceRow,cells:Array.from({length:90},(_,i)=>r.cells[i]??"" )}))};',0);
    const request={program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],mode:'source_records' as const,sourceRecords:{sourceId:source.sourceId,sha256:source.sha256,width:90,initialState:{}},output:{path:'/workspace/streamed-dual.json',expectedRevision:0,format:'json' as const}};
    const context={lease,toolCallId:'execute',stepId:'execute'};
    await prep.task.beforeTool('code.run',request,context.toolCallId);
    const execution=await store.codeExecution!.run(request,context);
    expect(execution.status,JSON.stringify(execution)).toBe('succeeded');
    prep.task.afterTool('code.run',{status:'success',toolName:'code.run',message:'actual QuickJS',shouldStop:false,artifacts:{codeExecution:execution}},context);
    const port=store.candidateStaging!,candidate=await port.stage(execution.jobId,{...context,toolCallId:'stage',stepId:'stage'});
    const receipt=await port.validate(candidate.candidateId,{...context,toolCallId:'validate',stepId:'validate'});
    expect(receipt.decision,JSON.stringify(receipt)).toBe('validated');
    const io=prior?.io??dualCommitStorage();let fault='',worker='prior';
    const prepare=vi.fn(async (_marker,_output,current,_signal,files)=>{current();expect(files).toHaveLength(2);if(fault==='one-table')throw new Error('second_table_failure');return {
        binding:{engine:'duckdb' as const,tableName:'native',loadVersion:'streamed',fallbackReason:null,fallbackStage:null},bind(){},activate(){current();worker='next';if(fault==='activate')throw new Error('activation_failure');},rollback(){worker='prior';},finish(){},dispose(){}};});
    let allocations=0;
    const storage:typeof io.storage=async(generation,create,current)=>{const dir=await io.storage(generation,create,current);if(create&&++allocations===2&&fault==='second-write')return {...dir,writeCsv:async()=>{throw new DOMException('second table quota','QuotaExceededError');}};return dir;};
    const service=createCandidateCommitService(store,{database:async()=>io.db,acceptedStorage:storage,prepareTablesBinding:prepare});
    return {fixture,source,root,store,lease,prep,port,candidate,receipt,service,prepare,io,...io,fault(v:string){fault=v;io.setFault(v);},get worker(){return worker;}};
};

describe('large streamed dual exact publication (real QuickJS, modelled journal/workers)',()=>{
    it('suspends exact read custody and resumes only the original capsule under a fresh task lease',async()=>{
        const f=await setup(),review=await f.service.review(f.candidate.candidateId,{primaryTable:'entities',idempotencyKey:'stream-dual-resume'}),capsule=f.service.suspend(review);
        const pending=f.prep.task.suspend({question:'Exact streamed ALL-table review',interactionKind:'approval',options:[]});
        f.prep.task.close('blocked');finishRun(f.root,f.lease);
        const lease=beginRun(f.root,'follow_up','stream-fresh','stream-fresh'),store=scopeRunStore(f.root,lease);
        const prep=await preparePiExecutor(store,{entryPoint:'follow_up',goal:f.prep.task.snapshot.goal,guest,continuation:pending.resumeContext!.piTaskContinuation});
        cleanup.push(()=>{prep.task.close('cancelled');finishRun(f.root,lease);});
        expect(()=>f.service.resume(structuredClone(capsule),store)).toThrow('approval_invalid');f.service.resume(capsule,store);
        expect(await f.service.commit(f.service.approve(review))).toMatchObject({status:'committed',acknowledgement:'installed'});
    });
    it('validates metadata-only tables, pages independent grains and persists/recovers all immutable files',async()=>{
        const f=await setup();expect(f.candidate.tables.map(t=>[t.rowCount,t.rows.length,t.lineage.length])).toEqual([[80,0,0],[4800,0,0]]);
        const page=await f.port.previewAsync(f.candidate.candidateId,'metrics',f.receipt.receiptDigest,61,3);
        expect(page.rows.map(r=>r.Id)).toEqual(['E00000001','E00000001','E00000001']);
        expect(page.rows[0]['Value [USD]']).toBe(0);expect(page.lineageSamples.some(l=>l.origins[0].row===3)).toBe(true);
        const before=f.root.getState().datasetBundle;
        const review=await f.service.review(f.candidate.candidateId,{primaryTable:'entities',idempotencyKey:'stream-dual-exact'});
        expect(review.acceptedStreamedDual?.tables.map(t=>t.rowCount)).toEqual([80,4800]);expect(f.root.getState().datasetBundle).toBe(before);expect(f.files.size).toBe(0);
        const approval=f.service.approve(review);expect(await f.service.commit(structuredClone(approval))).toMatchObject({status:'not_committed',reason:'approval_invalid'});
        const out=await f.service.commit(approval);expect(out).toMatchObject({status:'committed',acknowledgement:'installed'});
        expect(f.files.size).toBe(2);expect(f.worker).toBe('next');
        const files=await readAcceptedStreamedDual(out.marker!,()=>{},f.storage);expect(files.map(file=>file.size)).toEqual(review.acceptedStreamedDual!.tables.map(t=>t.bytes));
        await restoreAcceptedDataset(f.store,{}, {database:async()=>f.db,acceptedStorage:f.storage,prepareTablesBinding:f.prepare});
        expect(f.prepare).toHaveBeenCalledTimes(2);expect(f.root.getState().datasetBundle?.acceptedCommit?.commitId).toBe(out.marker!.commitId);
        expect(await f.service.commit(approval)).toMatchObject({status:'not_committed',reason:'approval_consumed'});
        f.files.get(review.acceptedStreamedDual!.tables[1].generation)!.text+='x';
        const accepted=f.root.getState().datasetBundle;
        await expect(restoreAcceptedDataset(f.store,{}, {database:async()=>f.db,acceptedStorage:f.storage,prepareTablesBinding:f.prepare})).rejects.toThrow('accepted_dual_content_corrupt');
        expect(f.root.getState().datasetBundle).toBe(accepted);expect(f.root.getState().datasetCommitBindingStatus).toBe('ready');
    });
    it.each(['quota','persist','one-table','activate','second-write'])('preserves original publication on %s',async fault=>{
        const f=await setup(),before=f.root.getState().datasetBundle;
        const review=await f.service.review(f.candidate.candidateId,{primaryTable:'entities',idempotencyKey:'stream-dual-failure'});f.fault(fault);
        expect(await f.service.commit(f.service.approve(review))).toMatchObject({status:'not_committed'});
        expect(f.root.getState().datasetBundle).toBe(before);expect(f.worker).toBe('prior');expect(f.files.size).toBe(0);
        expect(await f.db.get('dataset_commits',commitHeadKey(f.root.getState().sessionId))).toBeUndefined();
    });
    it.each(['quota','persist','one-table','activate','second-write'])('preserves a REAL prior accepted streamed generation on second %s failure',async fault=>{
        const first=await setup(),review=await first.service.review(first.candidate.candidateId,{primaryTable:'entities',idempotencyKey:'stream-first-real'});
        const accepted=await first.service.commit(first.service.approve(review));expect(accepted.acknowledgement).toBe('installed');
        first.prep.task.close('completed');finishRun(first.root,first.lease);
        const next=await setup(first),before=next.root.getState().datasetBundle;
        const second=await next.service.review(next.candidate.candidateId,{primaryTable:'entities',idempotencyKey:'stream-second-real'});next.fault(fault);
        expect(await next.service.commit(next.service.approve(second))).toMatchObject({status:'not_committed'});
        expect(next.root.getState().datasetBundle).toBe(before);expect(next.root.getState().datasetCommitBindingStatus).toBe('ready');expect(next.files.size).toBe(2);
        expect((await next.db.get('dataset_commits',commitHeadKey(next.root.getState().sessionId)))?.commitId).toBe(accepted.marker!.commitId);
        expect((await readAcceptedStreamedDual(accepted.marker!,()=>{},next.storage))).toHaveLength(2);
    });
    it.each(['program','source','receipt','expiry','cancel'])('rejects %s changes after exact review',async fault=>{
        const f=await setup(),review=await f.service.review(f.candidate.candidateId,{primaryTable:'entities',idempotencyKey:'stream-dual-stale'}),approval=f.service.approve(review);
        if(fault==='program')await f.store.codeExecution!.workspace.write(f.candidate.execution.program!.path,'return {};',1);
        if(fault==='source')f.root.setState({datasetBundle:{...f.root.getState().datasetBundle!,source:{...f.root.getState().datasetBundle!.source,inspection:{...f.source,sha256:'f'.repeat(64)}}}});
        if(fault==='receipt')await f.port.validate(f.candidate.candidateId,{lease:f.lease,toolCallId:'revalidate',stepId:'revalidate'});
        if(fault==='expiry')vi.spyOn(Date,'now').mockReturnValue(review.expiresAt);
        if(fault==='cancel')finishRun(f.root,f.lease);
        expect(await f.service.commit(approval)).toMatchObject({status:'not_committed',admitted:false});expect(f.files.size).toBe(0);expect(f.prepare).not.toHaveBeenCalled();
    });
    it.each(['relationship','schema','meaning','program','receipt','source','head-generation'])('rejects durable %s tampering without replacing accepted publication',async fault=>{
        const f=await setup(),review=await f.service.review(f.candidate.candidateId,{primaryTable:'entities',idempotencyKey:'stream-dual-tamper'});
        const out=await f.service.commit(f.service.approve(review));expect(out.acknowledgement).toBe('installed');const marker=structuredClone(out.marker!);
        if(fault==='relationship')marker.bundle.relationships[0].foreignKeyCoverage=0;
        if(fault==='schema')marker.bundle.tables[1].schema[2].nullable=false;
        if(fault==='meaning')marker.acceptedStreamedDual!.binding.streamedDual!.meaning.proposal.assumptions=['tampered'];
        if(fault==='program')marker.program.content+=' ';
        if(fault==='receipt')marker.validation={...marker.validation,checks:[]};
        if(fault==='source')marker.bundle.source.inspection!.sha256='a'.repeat(64);
        if(fault==='head-generation')marker.bundle.acceptedCommit!.revision++;
        await expect(readAcceptedStreamedDual(marker,()=>{},f.storage)).rejects.toThrow();expect(f.root.getState().datasetCommitBindingStatus).toBe('ready');
    });
    it('retains BOTH backing files on unknown durable acknowledgement, then recovers only approved truth',async()=>{
        const f=await setup(),review=await f.service.review(f.candidate.candidateId,{primaryTable:'entities',idempotencyKey:'stream-dual-unknown'});f.fault('unknown');
        expect(await f.service.commit(f.service.approve(review))).toMatchObject({status:'unknown',reason:'commit_outcome_unknown'});expect(f.files.size).toBe(2);
        expect(f.root.getState().datasetCommitBindingStatus).toBe('commit_unknown');f.fault('');
        await restoreAcceptedDataset(f.store,{}, {database:async()=>f.db,acceptedStorage:f.storage,prepareTablesBinding:f.prepare});
        expect(f.root.getState().datasetBundle?.tables.map(t=>t.rowCount)).toEqual([80,4800]);expect(f.root.getState().datasetCommitBindingStatus).toBe('ready');
    });
});
