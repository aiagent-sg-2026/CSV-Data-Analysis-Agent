// @vitest-environment node
import { describe, expect, it } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { preparePiExecutor } from '../services/agent/runtime/pi/piExecutorPreparation';
import { beginRun, beginSessionTransition, finishRun, scopeRunStore } from '../services/session/sessionOwnership';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import type { StoreApi } from '../services/agent/types';
const guest = {run: (code, inputJson, options) => executeQuickJsGuest({generation: 1, code, inputJson, limits: resolveGuestLimits(options.limits)},
    () => newQuickJSWASMModuleFromVariant(variant), options.onStarted), cancel() {}, dispose() {}} satisfies NonNullable<Parameters<typeof preparePiExecutor>[1]['guest']>;
const fixture = (kind: 'initial_analysis' | 'follow_up') => {
    const data = {fileName: 'synthetic.csv', data: [{Amount: 2}, {Amount: 3}]};
    let state = {sessionId: crypto.randomUUID(), csvData: data, canonicalCsvData: data, columnProfiles: [{name:'Amount',type:'numerical'}],
        datasetBundle: createSingleTableDatasetBundle({datasetId:'synthetic',sourceFingerprint:'synthetic',file:{name:data.fileName,size:20,lastModified:1},data}),
        settings: {provider:'default',language:'English',runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}},
        analysisCards:[],cleaningRun:null,workspaceFiles:{}} as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = {getState:()=>state,setState:patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};}};
    const lease=beginRun(root,kind,crypto.randomUUID(),kind==='follow_up'?crypto.randomUUID():undefined);
    return {root,lease,store:scopeRunStore(root,lease),data};
};
describe('shared Pi executor preparation',()=>{
    it.each(['initial_analysis','follow_up'] as const)('%s stages actual code with host lineage and leaves accepted state unchanged',async kind=>{
        const s=fixture(kind), before=JSON.stringify(s.root.getState().datasetBundle);
        const prep=await preparePiExecutor(s.store,{entryPoint:kind,goal:'Stage a total.',guest});
        try {
            const stage=prep.stage({stageIndex:3,toolName:'dataset.applyTransform',phase:'apply_safe_cleaning',nextStageIndex:3,pendingStageIndex:3},'host-call');
            const program=await stage.codeExecution!.workspace.write('/workspace/program.js','throw new TypeError("real failure");',0);
            const args={program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],tables:[{name:'facts',tableId:s.root.getState().datasetBundle!.primaryTableId}],output:{path:'/workspace/result.json',expectedRevision:0,format:'json' as const}};
            await prep.task.beforeTool('code.run',args,'host-call');
            const failure=await stage.codeExecution!.run(args,stage.executionContext!);
            expect(failure,JSON.stringify(failure)).toMatchObject({status:'failed',error:{name:'TypeError',message:'real failure'},runId:s.lease.runId,toolCallId:'host-call'});
            prep.task.afterTool('code.run',{toolName:'code.run',status:'error',message:'failed',shouldStop:false,artifacts:{codeExecution:failure}},stage.executionContext!);
            const repaired=await stage.codeExecution!.workspace.write(program.path,'return input.facts.rows.reduce((sum,r)=>sum+r.Amount,0);',1);
            args.program={path:repaired.path,revision:repaired.revision,sha256:repaired.sha256};
            await prep.task.beforeTool('code.run',args,'host-call');
            const receipt=await stage.codeExecution!.run(args,stage.executionContext!);
            expect(receipt).toMatchObject({status:'succeeded',sessionId:s.lease.scope.sessionId,sessionEpoch:s.lease.scope.epoch,runId:s.lease.runId,toolCallId:'host-call',stepId:'stage-3-host-call'});
            expect(stage.codeExecution!.workspace.read('/workspace/result.json').content).toBe('5');
            expect(JSON.stringify(s.root.getState().datasetBundle)).toBe(before);expect(s.root.getState().csvData).toBe(s.data);
            expect(prep.reference()).toMatchObject({mode:'staging_only',runId:s.lease.runId,taskId:prep.task.snapshot.taskId});
        }finally{prep.task.close('completed');finishRun(s.root,s.lease);}
    });
    it.each(['initial_analysis','follow_up'] as const)('%s refuses missing required host lineage',async kind=>{
        const s=fixture(kind),prep=await preparePiExecutor(s.store,{entryPoint:kind,goal:'Stage.',guest});
        try {
            const stage=prep.stage({stageIndex:3,toolName:'dataset.applyTransform',phase:'apply_safe_cleaning',nextStageIndex:3,pendingStageIndex:3},'host-call');
            const program=await stage.codeExecution!.workspace.write('/workspace/program.js','return 5;',0);
            const request={program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],output:{path:'/workspace/result.json',expectedRevision:0,format:'json' as const}};
            await prep.task.beforeTool('code.run',request,'host-call');
            if(kind==='follow_up')s.lease.turnId=undefined;
            const context={...stage.executionContext!,stepId:undefined};
            expect(await stage.codeExecution!.run(request,context)).toMatchObject({status:'cancelled',reasonCode:'scope_revoked'});
            expect(stage.codeExecution!.workspace.revision('/workspace/result.json')).toBe(0);
        }finally{prep.task.close('cancelled');finishRun(s.root,s.lease);}
    });
    it('refreshes input versions between stages and invalidates prior receipts/grants',async()=>{
        const s=fixture('initial_analysis'),prep=await preparePiExecutor(s.store,{entryPoint:'initial_analysis',goal:'Stage.',guest});
        try {
            prep.stage({stageIndex:3,toolName:'dataset.applyTransform',phase:'apply_safe_cleaning',nextStageIndex:3,pendingStageIndex:3},'before-cleaning');
            const port=s.store.codeExecution!,program=await port.workspace.write('/workspace/program.js','return 5;',0);
            const request={program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],output:{path:'/workspace/result.json',expectedRevision:0,format:'json' as const}};
            const context={lease:s.lease,stepId:'stage-3-before-cleaning',toolCallId:'before-cleaning'};
            await prep.task.beforeTool('code.run',request,'before-cleaning');const receipt=await port.run(request,context);
            prep.task.afterTool('code.run',{toolName:'code.run',status:'success',message:'staged',shouldStop:false,artifacts:{codeExecution:receipt}},context);
            expect(prep.task.outputReceipt()).toBe(receipt);expect(prep.task.snapshot.capabilityGrants).toHaveLength(1);
            const revision=prep.task.snapshot.revision;
            const data={...s.data,data:[{Amount:20}]};const bundle=createSingleTableDatasetBundle({datasetId:'synthetic',sourceFingerprint:'synthetic',file:{name:data.fileName,size:20,lastModified:1},data});
            s.root.setState({csvData:data,canonicalCsvData:data,datasetBundle:bundle});
            prep.stage({stageIndex:4,toolName:'dataset.validatePreparedData',phase:'verify_prepared_data',nextStageIndex:4,pendingStageIndex:4},'after-cleaning');
            expect(prep.task.snapshot.revision).toBe(revision+1);expect(prep.task.snapshot.inputBindings[0].datasetVersion).toBe(bundle.datasetVersion);
            expect(prep.task.snapshot.capabilityGrants).toEqual([]);expect(prep.task.outputReceipt()).toBeUndefined();
        }finally{prep.task.close('cancelled');finishRun(s.root,s.lease);}
    });
    it('late close cannot revoke grants on a newer continuation of the same task',async()=>{
        const s=fixture('initial_analysis'),old=await preparePiExecutor(s.store,{entryPoint:'initial_analysis',goal:'Stage.',guest});
        const pending=old.task.suspend({interactionKind:'clarification',resumeContext:{}} as never);
        finishRun(s.root,s.lease);const lease=beginRun(s.root,'initial_analysis','resumed-run');
        const current=await preparePiExecutor(scopeRunStore(s.root,lease),{entryPoint:'initial_analysis',goal:'Stage.',guest,continuation:pending.resumeContext!.piTaskContinuation as never});
        try {
            const stage=current.stage({stageIndex:3,toolName:'dataset.applyTransform',phase:'apply_safe_cleaning',nextStageIndex:3,pendingStageIndex:3},'new-call');
            const program=await stage.codeExecution!.workspace.write('/workspace/program.js','return 5;',0);
            await current.task.beforeTool('code.run',{program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],output:{path:'/workspace/result.json',expectedRevision:0,format:'json'}},'new-call');
            const grants=current.task.snapshot.capabilityGrants;expect(grants).toHaveLength(1);
            old.task.close('cancelled');expect(current.task.snapshot.capabilityGrants).toEqual(grants);
            expect(s.root.getState().activeAgentTask?.capabilityGrants).toEqual(grants);expect(s.root.getState().activeExecution?.runId).toBe('resumed-run');
        }finally{current.task.close('cancelled');finishRun(s.root,lease);}
    });
    it('rejects a revoked preparation and does not end a replacement run',async()=>{
        const s=fixture('initial_analysis'),prep=await preparePiExecutor(s.store,{entryPoint:'initial_analysis',goal:'Stage.',guest});
        beginSessionTransition(s.root);const next=beginRun(s.root,'follow_up','new-run','new-turn');
        expect(()=>prep.stage({stageIndex:0,toolName:'dataset.profileStructure',phase:'inspect_structure',nextStageIndex:0,pendingStageIndex:0},'old-call')).toThrow();
        prep.task.close('cancelled');expect(s.root.getState().activeExecution?.runId).toBe('new-run');finishRun(s.root,next);
    });
});
