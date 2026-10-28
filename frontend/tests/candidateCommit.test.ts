// @vitest-environment node
import {beforeEach,describe,expect,it,vi} from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import {executeQuickJsGuest} from '../services/sandbox/quickJsGuest';
import {resolveGuestLimits} from '../services/sandbox/javascriptGuestProtocol';
import {preparePiExecutor} from '../services/agent/runtime/pi/piExecutorPreparation';
import {prepareCandidateCommitFixture} from '../services/data/candidateCommitQualificationFixture';
import {stageRecoveryQualificationCandidate} from '../services/data/datasetRecoveryQualificationFixture';
import {getSandboxTableRows} from '../services/data/sandboxTableRegistry';
import {createCandidateCommitService} from '../services/data/candidateCommit';
import {beginRun,beginSessionTransition,finishRun,scopeRunStore,cancelOwnedRun} from '../services/session/sessionOwnership';
import {drainSessionPersistence,queueSessionWrite} from '../services/persistence/currentSessionPersistence';
import {commitHeadKey,commitIntentKey,validCommitKey,type DatasetCommitMarker} from '../types/datasetCommit';
import {getPreferredAnalysisDataset} from '../services/agent/reportStructureState';
import type {StorageDatabase} from '../services/storageService';
import type {createCodeExecutionAdapter} from '../services/agent/execution/codeExecutionAdapter';
const io=vi.hoisted(()=>({records:new Map<string,unknown>(),attempts:0,fault:'' as string,before:undefined as undefined|(()=>Promise<void>)}));
vi.mock('../services/persistence/datasetCommitStorage',()=>({
    readCommitIntent:async(_db:unknown,sid:string,key:string)=>{
        if(io.fault==='unknown-read')throw new Error('offline');return io.records.get(JSON.stringify(['intent',sid,key]));
    },
    commitDatasetTransaction:async(_db:unknown,marker:DatasetCommitMarker,_baseline:unknown,check:()=>void,admit:()=>void)=>{
        check();admit();io.attempts++;await io.before?.();
        if(io.fault==='abort')throw new DOMException('injected','AbortError');
        if(io.fault==='abort-unknown'){io.fault='unknown-read';throw new DOMException('injected','AbortError');}
        io.records.set(marker.recordId,structuredClone(marker));io.records.set(JSON.stringify(['head',marker.sessionId]),{kind:'head',commitId:marker.commitId});
        if(io.fault==='lost-ack')throw new Error('lost_ack');
        if(io.fault==='unknown'){io.fault='unknown-read';throw new Error('lost_ack');}
        return {marker,replay:false};
    },
}));
const wasm=newQuickJSWASMModuleFromVariant(variant);
const guest={run:(code,inputJson,options)=>executeQuickJsGuest({generation:1,code,inputJson,limits:resolveGuestLimits(options.limits)},()=>wasm,options.onStarted),cancel(){},dispose(){}} satisfies NonNullable<Parameters<typeof prepareCandidateCommitFixture>[0]>['guest'];
const db={get:async(_name:string,key:string)=>io.records.get(key)} as unknown as StorageDatabase;
const bind=vi.fn(async()=>({engine:'duckdb' as const,tableName:'data',loadVersion:'bound',fallbackReason:null,fallbackStage:null}));
const setup=async()=>{
    const fixture=await prepareCandidateCommitFixture({guest});
    const service=createCandidateCommitService(fixture.store,{database:async()=>db,bind});
    const review=await service.review(fixture.candidate.candidateId,{idempotencyKey:'intent-12345678',primaryTable:'facts'});
    return {...fixture,service,review,approval:service.approve(review)};
};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
describe('host exact candidate commit boundary',()=>{
    beforeEach(async()=>{await drainSessionPersistence();io.records.clear();io.attempts=0;io.fault='';io.before=undefined;bind.mockClear();bind.mockResolvedValue({engine:'duckdb',tableName:'data',loadVersion:'bound',fallbackReason:null,fallbackStage:null});});
    it('releases the reviewed run and admits exact approval only under a fresh lease',async()=>{
        const f=await setup();try{
            const capsule=f.service.suspend(f.review);
            const pending=f.prep.task.suspend({question:'Review',options:[],interactionKind:'approval'});
            f.prep.task.close('blocked');finishRun(f.root,f.lease);
            expect(f.root.getState().activeExecution).toBeNull();
            const fresh=beginRun(f.root,'follow_up','fresh-approval-run','fresh-approval-turn');
            const scoped=scopeRunStore(f.root,fresh);
            const prep=await preparePiExecutor(scoped,{entryPoint:'follow_up',goal:f.prep.task.snapshot.goal,continuation:pending.resumeContext!.piTaskContinuation,guest});
            f.service.resume(capsule,scoped);
            const result=await f.service.commit(f.service.approve(f.review));
            expect(result).toMatchObject({status:'committed',acknowledgement:'installed'});
            expect(result.marker!.audit.runId).toBe(fresh.runId);
            expect(prep.task.snapshot.taskId).toBe(f.prep.task.snapshot.taskId);
            expect(prep.task.snapshot.budget.used.transformationAttempts).toBe(1);
            f.prep.task.close('cancelled');finishRun(f.root,f.lease);
            expect(f.root.getState().activeExecution?.runId).toBe(fresh.runId);
            prep.task.close('completed');finishRun(f.root,fresh);
        }finally{f.cleanup();}
    });
    it('preserves general multi-table exact review, commit, relationship and recovery metadata',async()=>{
        const f=await prepareCandidateCommitFixture({guest});
        f.prep.task.close('blocked');finishRun(f.root,f.lease);
        const next=await stageRecoveryQualificationCandidate(f.root,'multi',guest);
        try{
            const service=createCandidateCommitService(next.store,{database:async()=>db,bind});
            const review=await service.review(next.candidate.candidateId,{idempotencyKey:'legacy-multi',primaryTable:'facts'});
            expect(review.tables.map(t=>t.name)).toEqual(['facts','names']);
            const checkpoint=await service.recoveryCheckpoint(review);
            expect(checkpoint.proposal.bundle.relationships[0].decision).toBe('trusted');
            expect(typeof next.store.candidateStaging!.captureCommitCheck(next.candidate.candidateId)).toBe('function');
            const result=await service.commit(service.approve(review));
            expect(result).toMatchObject({status:'committed',admitted:true,acknowledgement:'installed'});
            expect(io.attempts).toBe(1);expect(bind).toHaveBeenCalledTimes(1);
            const bundle=f.root.getState().datasetBundle!;
            expect(bundle.tables.map(t=>t.name)).toEqual(['facts','names']);
            expect(bundle.relationships[0].decision).toBe('trusted');
            for(const table of bundle.tables)expect(getSandboxTableRows(bundle.bundleId,table.tableId,bundle.datasetVersion)).toHaveLength(2);
            expect(f.root.getState().csvData!.data).toEqual([{Name:'Total Solutions',Amount:0},{Name:'Detail',Amount:-5}]);
        }finally{next.prep.task.close('cancelled');finishRun(f.root,next.lease);f.cleanup();}
    });
    it('requires host-issued exact review and approval objects and a valid caller key',async()=>{
        const f=await setup();try{
            expect(Object.isFrozen(f.review)).toBe(true);expect(()=>f.service.approve({...f.review})).toThrow('approval_invalid');
            expect(validCommitKey(undefined)).toBe(false);expect(validCommitKey('')).toBe(false);
            expect(await f.service.commit({...f.approval})).toMatchObject({status:'not_committed',admitted:false,reason:'approval_invalid'});
            await expect(f.service.review(f.candidate.candidateId,{idempotencyKey:' ',primaryTable:'facts'})).rejects.toThrow('idempotency_key_invalid');
            expect(io.attempts).toBe(0);
        }finally{f.cleanup();}
    });
    it('installs validated details after durable success and replays the same intent exactly once',async()=>{
        const f=await setup();try{
            const original=JSON.stringify(f.root.getState().rawCsvData);const first=await f.service.commit(f.approval),second=await f.service.commit(f.approval);
            expect(first).toMatchObject({status:'committed',admitted:true,acknowledgement:'installed'});expect(second).toMatchObject({status:'committed',replay:true});
            expect(second.marker?.commitId).toBe(first.marker?.commitId);expect(io.attempts).toBe(1);expect(bind).toHaveBeenCalledTimes(1);
            expect(f.root.getState().csvData!.data).toEqual([{Name:'Total Solutions',Amount:0},{Name:'Detail',Amount:-5}]);
            expect(JSON.stringify(f.root.getState().rawCsvData)).toBe(original);expect(first.marker!.bundle.tables.every(t=>!('rows' in t))).toBe(true);
            expect(first.marker!.program.content).toBe(f.program.content);expect(first.marker!.environment.runtime).toContain('0.32.0');
            expect(first.marker!.approval.approvalId).toBe(f.approval.approvalId);
        }finally{f.cleanup();}
    });
    it.each(['program','input','policy','grant','expiry'] as const)('rejects %s changes after review before admission',async(mode)=>{
        const f=await setup();let clock:ReturnType<typeof vi.spyOn>|undefined;try{
            if(mode==='program')await f.store.codeExecution!.workspace.write(f.program.path,'return 999;',f.program.revision);
            if(mode==='input')f.root.getState().csvData!.data[0].Amount=1;
            if(mode==='policy'){const settings=f.root.getState().settings;f.root.setState({settings:{...settings,runtimeAccessControl:{...settings.runtimeAccessControl,toolOverrides:{'data.mutate':'deny'}}}});}
            if(mode==='grant')(f.store.codeExecution as ReturnType<typeof createCodeExecutionAdapter>).revoke(f.execution.grant!.id);
            if(mode==='expiry')clock=vi.spyOn(Date,'now').mockReturnValue(f.approval.expiresAt);
            expect(await f.service.commit(f.approval)).toMatchObject({status:'not_committed',admitted:false});expect(io.attempts).toBe(0);
        }finally{clock?.mockRestore();f.cleanup();}
    });
    it('does not consume approval on abort and permits an exact revalidated retry',async()=>{
        const f=await setup();try{io.fault='abort';expect(await f.service.commit(f.approval)).toMatchObject({status:'not_committed',admitted:true});expect(io.records.size).toBe(0);
            io.fault='';expect(await f.service.commit(f.approval)).toMatchObject({status:'committed'});expect(io.records.size).toBe(2);
        }finally{f.cleanup();}
    });
    it('reconciles a lost acknowledgement through the marker and never executes a duplicate commit',async()=>{
        const f=await setup();try{io.fault='lost-ack';expect(await f.service.commit(f.approval)).toMatchObject({status:'committed',replay:true,acknowledgement:'installed'});expect(io.attempts).toBe(1);}
        finally{f.cleanup();}
    });
    it('reports an unknown outcome without installing rows and reconciles before any retry',async()=>{
        const f=await setup();try{io.fault='unknown';expect(await f.service.commit(f.approval)).toMatchObject({status:'unknown',admitted:true});expect(f.root.getState().csvData!.data).toHaveLength(3);
            expect(f.root.getState().datasetCommitBindingStatus).toBe('commit_unknown');expect(getPreferredAnalysisDataset(f.root.getState())).toBeNull();
            expect(await f.service.commit(f.approval)).toMatchObject({status:'unknown',admitted:false});expect(io.attempts).toBe(1);
            io.fault='';expect(await f.service.commit(f.approval)).toMatchObject({status:'committed',replay:true});expect(io.attempts).toBe(1);
        }finally{f.cleanup();}
    });
    it('keeps old facts fenced when Stop arrives after durable admission',async()=>{
        const f=await setup(),gate=deferred(),started=deferred();try{
            io.before=()=>{started.resolve();return gate.promise;};
            const running=f.service.commit(f.approval);await started.promise;cancelOwnedRun(f.root);gate.resolve();
            expect(await running).toMatchObject({status:'committed',acknowledgement:'revoked'});
            expect(f.root.getState().datasetCommitBindingStatus).toBe('commit_unknown');expect(getPreferredAnalysisDataset(f.root.getState())).toBeNull();
        }finally{gate.resolve();f.cleanup();}
    });
    it('drops a queued attempt when session replacement occurs before admission',async()=>{
        const f=await setup(),gate=deferred();try{const ahead=queueSessionWrite(()=>gate.promise),result=f.service.commit(f.approval);beginSessionTransition(f.root);gate.resolve();await ahead;
            expect(await result).toMatchObject({status:'not_committed',admitted:false});expect(io.attempts).toBe(0);
        }finally{f.cleanup();}
    });
    it('revalidates an uncertain abort only after an absent marker resolves its outcome',async()=>{
        const f=await setup();try{io.fault='abort-unknown';expect(await f.service.commit(f.approval)).toMatchObject({status:'unknown'});
            expect(await f.service.commit(f.approval)).toMatchObject({status:'unknown',admitted:false});expect(io.records.size).toBe(0);
            io.fault='';expect(await f.service.commit(f.approval)).toMatchObject({status:'committed',acknowledgement:'installed'});expect(io.attempts).toBe(2);
        }finally{f.cleanup();}
    });
    it('allows an admitted transaction to finish without changing the replacement Store or new run',async()=>{
        const f=await setup(),gate=deferred(),entered=deferred();try{io.before=async()=>{entered.resolve();await gate.promise;};const result=f.service.commit(f.approval);await entered.promise;
            beginSessionTransition(f.root);f.root.setState({sessionId:'replacement',isBusy:true});const next=beginRun(f.root,'follow_up','new');const before=JSON.stringify(f.root.getState());gate.resolve();
            expect(await result).toMatchObject({status:'committed',acknowledgement:'revoked'});expect(JSON.stringify(f.root.getState())).toBe(before);finishRun(f.root,next);
        }finally{f.cleanup();}
    });
    it('releases the local persistence barrier before waiting for a rebind',async()=>{
        const f=await setup(),gate=deferred(),entered=deferred();try{bind.mockImplementationOnce(async()=>{entered.resolve();await gate.promise;return {engine:'duckdb',tableName:'data',loadVersion:'bound',fallbackReason:null,fallbackStage:null};});
            const result=f.service.commit(f.approval);await entered.promise;await drainSessionPersistence();beginSessionTransition(f.root);gate.resolve();
            expect(await result).toMatchObject({status:'committed',acknowledgement:'revoked'});
        }finally{f.cleanup();}
    });
    it('preserves committed truth on rebind failure and refuses preferred query data',async()=>{
        const f=await setup();try{bind.mockRejectedValueOnce(new Error('worker unavailable'));const result=await f.service.commit(f.approval);
            expect(result).toMatchObject({status:'committed',acknowledgement:'binding_failed'});expect(f.root.getState().datasetCommitBindingStatus).toBe('binding_failed');
            expect(f.root.getState().csvData!.data).toHaveLength(2);expect(getPreferredAnalysisDataset(f.root.getState())).toBeNull();
            expect(io.records.has(commitHeadKey(f.lease.scope.sessionId))).toBe(true);expect(io.records.has(commitIntentKey(f.lease.scope.sessionId,f.review.idempotencyKey))).toBe(true);
        }finally{f.cleanup();}
    });
    it('blocks old answers if the durable head cannot be read before rebind',async()=>{
        const f=await setup();try{
            const service=createCandidateCommitService(f.store,{database:async()=>({get:async()=>{throw new Error('unavailable');}} as unknown as StorageDatabase),bind});
            const review=await service.review(f.candidate.candidateId,{idempotencyKey:'read-failure-intent',primaryTable:'facts'});
            expect(await service.commit(service.approve(review))).toMatchObject({status:'committed',acknowledgement:'binding_failed'});
            expect(getPreferredAnalysisDataset(f.root.getState())).toBeNull();expect(bind).not.toHaveBeenCalled();
        }finally{f.cleanup();}
    });
});
