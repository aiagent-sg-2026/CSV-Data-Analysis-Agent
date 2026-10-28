// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { preparePiDualGrainSmoke } from '../services/agent/runtime/pi/piDualGrainQualification';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import { handleClarificationResponse } from '../services/agent/orchestration/chatOrchestrator';
import { readTaskCandidateDraft } from '../services/agent/runtime/pi/piTaskInspection';
import type { StoreApi } from '../services/agent/types';
import { repairReservationStorage } from './helpers/repairReservationStorage';
const persistence=vi.hoisted(()=>({db:null as unknown}));
vi.mock('../services/storageService',async original=>({...await original<typeof import('../services/storageService')>(),getStorageDatabase:async()=>persistence.db}));
vi.mock('../services/persistence/currentSessionPersistence',()=>({persistCurrentAppSessionSnapshot:vi.fn(async()=>true)}));
const wasm=newQuickJSWASMModuleFromVariant(variant),roots:StoreApi[]=[];
const guest={run:(code:string,inputJson:string,options:{limits?:Parameters<typeof resolveGuestLimits>[0];onStarted?:()=>void})=>executeQuickJsGuest({generation:1,code,inputJson,limits:resolveGuestLimits(options?.limits)},()=>wasm,options?.onStarted),cancel(){},dispose(){}};
beforeEach(()=>{for(const name of ['localStorage','sessionStorage']){const values=new Map<string,string>();vi.stubGlobal(name,{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});}persistence.db=repairReservationStorage().db;});
afterEach(()=>{roots.splice(0).forEach(beginSessionTransition);vi.unstubAllGlobals();});
const setup=()=>{let state={sessionId:crypto.randomUUID(),settings:{},workspaceFiles:{},analysisCards:[],columnProfiles:[],chatHistory:[],agentEvents:[],agentToolLogs:[],runtimeEvents:[],telemetryEvents:[],progressMessages:[],queryHistory:[],
    logAgentToolUsage(){},addProgress(){},clearActiveTurnCancellation(){},ensureDatasetSemanticSnapshot:async()=>null} as unknown as ReturnType<StoreApi['getState']>;
    const root:StoreApi={getState:()=>state,setState:p=>{state={...state,...(typeof p==='function'?p(state):p)};}};roots.push(root);return root;};
const prepare=(root:StoreApi,options:Parameters<typeof preparePiDualGrainSmoke>[1]={})=>preparePiDualGrainSmoke(root,{streamRecords:80,coding:{enabled:true,qualified:true,guest,spillFactory:async()=>{const chunks=new Map<string,string>();return {async put(n,t){if(chunks.has(n))throw new Error('spill_immutable_conflict');chunks.set(n,t);},async get(n){return chunks.get(n)!;},async remove(){chunks.clear();}};}},...options});
const read=(root:StoreApi,name:string,offset=0)=>{const s=root.getState(),c=s.taskInspection!.candidate!;return readTaskCandidateDraft(root,s.activeAgentTask!.taskId,c.candidateId,name,c.validation!.receiptDigest!,offset);};
describe('normal Pi streamed dual coordinator (scripted proposals, actual QuickJS)',()=>{
    it.each([42,60,90])('connects width %i to both detached drafts and distinct exact approval without accepting',async width=>{
        const root=setup(),f=await prepare(root,{width});expect(f.source.byteSize).toBeGreaterThan(65536);expect(f.reads.fullReads).toBe(0);
        expect(root.getState().pendingClarification?.resumeContext?.piSpillMeaningChoice,JSON.stringify(f.result)+f.trace.join('\n')).toBeTruthy();
        await handleClarificationResponse(root.getState().pendingClarification!.options![0],root);
        const s=root.getState();expect(s.pendingClarification?.resumeContext?.piCandidateApproval,f.trace.join('\n')).toBeTruthy();
        expect(s.taskInspection?.candidate?.validation?.decision).toBe('validated');expect(s.taskInspection?.candidate?.tables.map(t=>t.rows)).toEqual([80,80*f.fixture.measures]);
        expect(s.csvData).toBe(f.data);expect(s.canonicalCsvData).toBeNull();expect(s.datasetBundle?.acceptedCommit).toBeUndefined();
        const entity=await read(root,'entities',79),metric=await read(root,'metrics',79*f.fixture.measures+1);
        expect(entity.rows[0]).toMatchObject({Id:'E00000079','Cost [USD]':1.25,'Net [USD]':-1.25});expect(entity.rows).toHaveLength(1);
        expect(metric.rows.slice(0,2).map(r=>r['Value [USD]'])).toEqual([0,-1.25]);expect(metric.rows[0].Id).toBe('E00000079');
        expect(metric.lineageSamples.some(l=>l.origins[0].row===81)).toBe(true);expect(metric.answerEvidence).toBe(false);
        expect(f.reads.maxBytes).toBeLessThanOrEqual(65536);expect(f.reads.bytes).toBeLessThan(f.source.byteSize*6);
    },30000);
    it('B is a distinct alignment and Neither never executes',async()=>{
        const root=setup(),f=await prepare(root);await handleClarificationResponse(root.getState().pendingClarification!.options![1],root);
        expect((await read(root,'metrics')).rows[0]).toMatchObject({Metric:'Period12:Category5','Value [USD]':null});expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined();
        const other=setup(),g=await prepare(other);await handleClarificationResponse(other.getState().pendingClarification!.options![2],other);
        expect(other.getState().taskInspection?.programs).toHaveLength(0);expect(other.getState().taskInspection?.candidate).toBeUndefined();expect(other.getState().csvData).toBe(g.data);expect(f.reads.fullReads).toBe(0);
    },30000);
    it.each(['value','program_revision'] as const)('real %s tamper cannot stage a validated candidate',async fault=>{
        const root=setup(),f=await prepare(root,{fault});await handleClarificationResponse(root.getState().pendingClarification!.options![0],root);
        expect(root.getState().taskInspection?.candidate?.validation?.decision).not.toBe('validated');expect(root.getState().datasetBundle?.acceptedCommit).toBeUndefined();
        expect(f.trace.join('\n')).toContain(fault==='value'?'source_stream_cell_mismatch':'workspace_conflict');
    },30000);
    it('post-choice meaning mutation never reuses cached compilation',async()=>{
        const root=setup(),f=await prepare(root,{confirmedProposal:p=>({...p,assumptions:['different after choice']})});
        await handleClarificationResponse(root.getState().pendingClarification!.options![0],root);
        expect(root.getState().taskInspection?.candidate).toBeUndefined();expect(f.trace.join('\n')).toContain('meaning_dual_grain_alternatives_required');
    });
});
