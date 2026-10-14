// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import {executeQuickJsGuest} from '../services/sandbox/quickJsGuest';
import {resolveGuestLimits} from '../services/sandbox/javascriptGuestProtocol';
import {preparePiExecutor} from '../services/agent/runtime/pi/piExecutorPreparation';
import {beginRun,beginSessionTransition,finishRun,scopeRunStore} from '../services/session/sessionOwnership';
import {createSingleTableDatasetBundle} from '../services/data/datasetBundle';
import {createCandidateStaging} from '../services/data/candidateStaging';
import type {StoreApi} from '../services/agent/types';
import {captureCsvSource} from '../services/data/immutableCsvSource';
import type {CandidateValidationContract} from '../services/data/candidateValidation';
import {bindCandidateValidationContract} from '../services/data/candidateValidationBinding';
import {executeCandidateAction} from '../services/agent/execution/executorCandidateActions';
const wasm=newQuickJSWASMModuleFromVariant(variant);
const guest={run:(code,inputJson,options)=>executeQuickJsGuest({generation:1,code,inputJson,limits:resolveGuestLimits(options.limits)},()=>wasm,options.onStarted),cancel(){},dispose(){}} satisfies NonNullable<Parameters<typeof preparePiExecutor>[1]['guest']>;
const output=()=>({schemaVersion:1,complete:true,tables:[{name:'facts',role:'fact',schema:[{name:'Name',dataType:'string',nullable:false},{name:'Amount',dataType:'number',nullable:false}],rowCount:2,
    rows:[{Name:'Total Solutions',Amount:0},{Name:'Detail',Amount:-5}],lineage:[0,1].flatMap(row=>['Name','Amount'].map(column=>({row,column,origins:[{kind:'table',name:'input',row,column}]})))}],relationships:[],
    excludedRows:[{origin:{kind:'table',name:'input',row:2},reason:'declared subtotal'}]});
const setup=async(value:unknown=output(),raw?:{text:string;length?:number},stream=false,contract?:CandidateValidationContract,initial=false)=>{
    const data={fileName:'synthetic.csv',data:[{Name:'Total Solutions',Amount:0},{Name:'Detail',Amount:-5},{Name:'Subtotal',Amount:-5}]};
    const bundle=createSingleTableDatasetBundle({datasetId:'synthetic',sourceFingerprint:'synthetic',file:{name:data.fileName,size:0,lastModified:0},data});
    let state={sessionId:'synthetic',csvData:data,canonicalCsvData:data,datasetBundle:bundle,columnProfiles:[],analysisCards:[],activeDataQuery:null,workspaceFiles:{},settings:{runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}}} as unknown as ReturnType<StoreApi['getState']>;
    const root:StoreApi={getState:()=>state,setState:p=>{state={...state,...(typeof p==='function'?p(state):p)};}};
    const lease=beginRun(root,initial?'initial_analysis':'follow_up','run',initial?undefined:'turn'),store=scopeRunStore(root,lease);
    const source=raw?await captureCsvSource(store,new File([raw.text],'synthetic.csv')):undefined;
    if(source)root.setState({datasetBundle:{...bundle,source:{...bundle.source,inspection:source}}});
    if(contract)root.candidateValidationContract=await bindCandidateValidationContract(root,'Stage a detail candidate, retaining legitimate names, zeros and negatives.',contract);
    const prep=await preparePiExecutor(store,{entryPoint:initial?'initial_analysis':'follow_up',goal:'Stage a detail candidate, retaining legitimate names, zeros and negatives.',guest});
    const workspace=store.codeExecution!.workspace;
    const program=await workspace.write('/workspace/program.js',stream?`return {state:null,rows:input.stream.phase==='finish'?[${JSON.stringify(value)}]:[]};`:`return ${JSON.stringify(value)};`,0);
    const request={program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],
        ...(source?{sources:[{name:'raw',sourceId:source.sourceId,sha256:source.sha256,offset:0,length:raw!.length??source.byteSize}]}:{tables:[{name:'input',tableId:bundle.primaryTableId}]}),
        output:{path:'/workspace/output.json',expectedRevision:0,format:'json' as const},...(stream?{mode:'stateful_stream' as const,stream:{table:'input',batchRows:2,partitionBy:[],initialState:null}}:{})};
    const context={lease,toolCallId:'actual-code-call',stepId:'code-step'};
    await prep.task.beforeTool('code.run',request,'actual-code-call');
    const receipt=await store.codeExecution!.run(request,context);
    prep.task.afterTool('code.run',{status:'success',toolName:'code.run',message:receipt.reasonCode,shouldStop:false,artifacts:{codeExecution:receipt}},context);
    const port=createCandidateStaging(store,workspace,()=>prep.task.snapshot,store.codeExecution!);
    const stage=()=>port.stage(receipt.jobId,{lease,toolCallId:'actual-stage-call',stepId:'stage-step'});
    return {root,store,lease,prep,workspace,port,program,receipt,source,stage,cleanup:()=>{port.dispose();prep.task.close('cancelled');finishRun(root,lease);}};
};
describe('immutable candidate staging',()=>{
    const meaning=():CandidateValidationContract=>({version:1,ambiguities:[],tables:[{name:'facts',role:'fact',schema:output().tables[0].schema as never,grain:['Name'],groupBy:[],metrics:[{column:'Amount',scale:2,toleranceMinor:0,unit:'SGD'}],mutableColumns:[],rows:[0,1].map(row=>({cells:['Name','Amount'].map(column=>({column,origin:{kind:'table',name:'input',row,column},conversion:'identity'}))}))}],relationships:[],exclusions:[{origin:{kind:'table',name:'input',row:2},role:'subtotal',checks:[{column:'Amount',table:'facts',detailRows:[0,1],metric:'Amount'}]}]});
    it('issues an independently bound immutable validation receipt with no accepted-state writer',async()=>{
        const contract=meaning(),s=await setup(output(),undefined,false,contract),before=JSON.stringify(s.root.getState());
        try{contract.tables[0].rows=[];const c=await s.stage();const v=await s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'actual-validation',stepId:'validation-step'});
            expect(v.decision).toBe('validated');expect(v.toolCallId).toBe('actual-validation');expect(v.outputDigest).toBe(c.execution.output!.sha256);
            for(const value of [v.receiptDigest,v.contractDigest,v.inputDigest,v.outputDigest,v.programDigest,v.environmentDigest])expect(value).toMatch(/^[a-f0-9]{64}$/);
            expect(Object.isFrozen(v.reasonCodes)).toBe(true);expect(s.port.validationReceipt(c.candidateId)).toBe(v);expect(c.validation).toBe('pending');expect(v.answerEvidence).toBe(false);
            expect(JSON.stringify(s.root.getState())).toBe(before);s.port.abandon(c.candidateId);expect(()=>s.port.validationReceipt(c.candidateId)).toThrow();
        }finally{s.cleanup();}
    });
    it('returns host clarification for an unregistered contract rather than certifying model assertions',async()=>{
        const s=await setup();try{const c=await s.stage();expect(await s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'v',stepId:'v'})).toMatchObject({decision:'clarification',reasonCodes:['validation_host_contract_required']});}finally{s.cleanup();}
    });
    it.each(['initial','stateful'])('validates %s shared preparation using complete native execution',async mode=>{
        const s=await setup(output(),undefined,mode==='stateful',meaning(),mode==='initial');try{const c=await s.stage();const v=await s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'v',stepId:'v'});expect(v.decision).toBe('validated');expect(v.turnId).toBe(mode==='initial'?undefined:'turn');
        }finally{s.cleanup();}
    });
    it('rejects fabricated transformed values without accepted mutation',async()=>{
        const value=output();value.tables[0].rows[0].Amount=999;const s=await setup(value,undefined,false,meaning()),before=JSON.stringify(s.root.getState());
        try{const c=await s.stage();expect((await s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'v',stepId:'v'})).decision).toBe('blocked');expect(JSON.stringify(s.root.getState())).toBe(before);}finally{s.cleanup();}
    });
    it('requires the host receipt object and cannot reuse success after a later SDK validation failure',async()=>{
        const s=await setup(output(),undefined,false,meaning());try{
            const port=s.store.candidateStaging!,stageContext={lease:s.lease,toolCallId:'stage',stepId:'stage'};
            await s.prep.task.beforeTool('candidate.stage',{jobId:s.receipt.jobId},'stage');const c=await port.stage(s.receipt.jobId,stageContext);
            s.prep.task.afterTool('candidate.stage',{status:'success',toolName:'candidate.stage',message:'staged',shouldStop:false,artifacts:{candidate:{candidateId:c.candidateId}}},stageContext);
            const context={lease:s.lease,toolCallId:'validate',stepId:'validate'};await s.prep.task.beforeTool('candidate.validate',{candidateId:c.candidateId},'validate');const v=await port.validate(c.candidateId,context);
            s.prep.task.afterTool('candidate.validate',{status:'success',toolName:'candidate.validate',message:'copied',shouldStop:false,artifacts:{candidateValidation:{...v}}},context);expect(s.prep.task.outputReceipt()).toBeUndefined();
            s.prep.task.afterTool('candidate.validate',{status:'success',toolName:'candidate.validate',message:'actual',shouldStop:false,artifacts:{candidateValidation:v}},context);expect(s.prep.task.outputReceipt()).toBe(s.receipt);
            await s.prep.task.toolFailure('candidate_validate',{candidateId:c.candidateId,contractDigest:'forged'},'Invalid tool parameters','forged');expect(s.prep.task.outputReceipt()).toBeUndefined();
        }finally{s.cleanup();}
    });
    it('fences deferred validation after replacement and identity-safe old cleanup',async()=>{
        const s=await setup(output(),undefined,false,meaning());let release!:()=>void,entered!:()=>void;
        const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});const c=await s.stage();
        const original=crypto.subtle.digest.bind(crypto.subtle),spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{entered();await wait;return original(...args);});
        try{const pending=s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'v',stepId:'v'});await ready;beginSessionTransition(s.root);const next=beginRun(s.root,'follow_up','new-run','new-turn');s.root.setState({isBusy:true});release();await expect(pending).rejects.toThrow();
            s.port.dispose();expect(s.root.getState().activeExecution?.runId).toBe('new-run');expect(s.root.getState().isBusy).toBe(true);finishRun(s.root,next);
        }finally{spy.mockRestore();s.cleanup();}
    });
    it('prevents an earlier validation hash from replacing a newer receipt in the same run',async()=>{
        const s=await setup(output(),undefined,false,meaning()),c=await s.stage();let release!:()=>void,entered!:()=>void,first=true;
        const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});const original=crypto.subtle.digest.bind(crypto.subtle),spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{if(first){first=false;entered();await wait;}return original(...args);});
        try{const old=s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'old',stepId:'old'});await ready;const latest=await s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'new',stepId:'new'});release();await expect(old).rejects.toThrow('candidate_validation_superseded');expect(s.port.validationReceipt(c.candidateId)).toBe(latest);
        }finally{spy.mockRestore();s.cleanup();}
    });
    it('rechecks validation permission after async hashing and rejects forged validation arguments',async()=>{
        const s=await setup(output(),undefined,false,meaning());let release!:()=>void,entered!:()=>void;const c=await s.stage();
        const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});const original=crypto.subtle.digest.bind(crypto.subtle),spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{entered();await wait;return original(...args);});
        try{const pending=s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'v',stepId:'v'});await ready;const settings=s.root.getState().settings;s.root.setState({settings:{...settings,runtimeAccessControl:{...settings.runtimeAccessControl,toolOverrides:{'candidate.validate':'deny'}}} as never});release();await expect(pending).rejects.toThrow('capability_unavailable');expect(s.port.validationReceipt(c.candidateId)).toBeUndefined();
            s.store.candidateStaging=s.port;s.store.executionContext={lease:s.lease,toolCallId:'v',stepId:'v'};
            expect((await executeCandidateAction({type:'tool_call',toolName:'candidate.validate',args:{candidateId:c.candidateId,contractDigest:'forged'}} as never,s.store)).status).toBe('blocked');
        }finally{spy.mockRestore();s.cleanup();}
    });
    it('invalidates validation on current program, scope, protected-source and same-version row drift',async()=>{
        const s=await setup(output(),undefined,false,meaning());try{const c=await s.stage();await s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'v',stepId:'v'});
            await s.workspace.write(s.program.path,'return 999;',1);expect(()=>s.port.validationReceipt(c.candidateId)).toThrow('workspace_conflict');
        }finally{s.cleanup();}
        const t=await setup(output(),undefined,false,meaning());try{const c=await t.stage();t.root.getState().csvData!.data[0].Amount=1;await expect(t.port.validate(c.candidateId,{lease:t.lease,toolCallId:'v',stepId:'v'})).rejects.toThrow('input_version_changed');}finally{t.cleanup();}
    });
    it('invalidates an issued receipt on same-version row mutation and rejects a stale host contract fingerprint',async()=>{
        const s=await setup(output(),undefined,false,meaning());try{const c=await s.stage();await s.port.validate(c.candidateId,{lease:s.lease,toolCallId:'v',stepId:'v'});
            s.root.getState().csvData!.data[0].Amount=1;expect(()=>s.port.validationReceipt(c.candidateId)).toThrow('input_version_changed');
        }finally{s.cleanup();}
        const t=await setup(output(),undefined,false,meaning());try{
            t.root.candidateValidationContract={...t.root.candidateValidationContract!,sessionEpoch:999};
            const port=createCandidateStaging(t.store,t.workspace,()=>t.prep.task.snapshot,t.store.codeExecution!);const c=await port.stage(t.receipt.jobId,{lease:t.lease,toolCallId:'s',stepId:'s'});
            expect(await port.validate(c.candidateId,{lease:t.lease,toolCallId:'v',stepId:'v'})).toMatchObject({decision:'clarification',reasonCodes:['validation_contract_binding_mismatch']});port.dispose();
        }finally{t.cleanup();}
    });
    it('stages a complete named table with explicit cell and excluded-row lineage, without accepted mutation',async()=>{
        const s=await setup(),before=JSON.stringify(s.root.getState());
        try{const candidate=await s.stage();expect(candidate.status).toBe('staged');expect(candidate.validation).toBe('pending');
            expect(candidate.execution.toolCallId).toBe('actual-code-call');expect(candidate.staging.toolCallId).toBe('actual-stage-call');
            expect(candidate.changeDigest).toMatch(/^[a-f0-9]{64}$/);expect(candidate.tables[0].rows).toEqual(output().tables[0].rows);
            expect(Object.isFrozen(candidate.tables[0].rows[0])).toBe(true);expect(JSON.stringify(s.root.getState())).toBe(before);
            expect(s.port.read(candidate.candidateId)).toBe(candidate);expect(s.port.diff(candidate.candidateId).tables[0]).toMatchObject({name:'facts',rowCount:2});
            expect(await s.stage()).toBe(candidate);s.port.abandon(candidate.candidateId);expect(()=>s.port.read(candidate.candidateId)).toThrow('candidate_unavailable');
            expect(s.workspace.read('/workspace/output.json').revision).toBe(1);expect(JSON.stringify(s.root.getState())).toBe(before);
        }finally{s.cleanup();}
    });
    it.each([
        ['partial', (v:ReturnType<typeof output>)=>{v.complete=false;}],
        ['row count', (v:ReturnType<typeof output>)=>{v.tables[0].rowCount=3;}],
        ['missing cell lineage',(v:ReturnType<typeof output>)=>{v.tables[0].lineage.pop();}],
        ['unaccounted input',(v:ReturnType<typeof output>)=>{v.excludedRows=[];}],
        ['invalid origin',(v:ReturnType<typeof output>)=>{v.tables[0].lineage[0].origins[0].row=999;}],
        ['duplicate lineage',(v:ReturnType<typeof output>)=>{v.tables[0].lineage.push(v.tables[0].lineage[0]);}],
        ['forged identity',(v:ReturnType<typeof output>)=>{Object.assign(v,{sessionId:'forged',changeDigest:'a'.repeat(64)});}],
    ])('rejects %s output',async(_name,change)=>{
        const value=output();change(value);const s=await setup(value),before=JSON.stringify(s.root.getState());
        try{await expect(s.stage()).rejects.toThrow();expect(s.port.list()).toEqual([]);expect(JSON.stringify(s.root.getState())).toBe(before);}finally{s.cleanup();}
    });
    it('rejects a revised output even though the old immutable revision is readable',async()=>{
        const s=await setup();try{await s.workspace.write('/workspace/output.json',JSON.stringify(output()),1);await expect(s.stage()).rejects.toThrow('workspace_conflict');}finally{s.cleanup();}
    });
    it('rejects version drift without changing accepted data',async()=>{
        const s=await setup();try{s.root.setState({datasetBundle:{...s.root.getState().datasetBundle!,relationshipSetId:'changed'}});await expect(s.stage()).rejects.toThrow('input_version_changed');}finally{s.cleanup();}
    });
    it('stages source-cell mapping for quoted multiline and shifted positional rows with explicit header/subtotal exclusions',async()=>{
        const value=output();value.tables[0].rows[0].Name='Total,\nSolutions';
        value.tables[0].lineage=value.tables[0].lineage.map(l=>({...l,origins:[{kind:'source',name:'raw',row:l.row+1,column:l.column==='Name'?1:2}]})) as never;
        value.excludedRows=[{origin:{kind:'source',name:'raw',row:0},reason:'header'},{origin:{kind:'source',name:'raw',row:3},reason:'declared subtotal'}] as never;
        const s=await setup(value,{text:'id,Name,Amount\n1,"Total,\nSolutions",0\n,Detail,-5\nSubtotal,,-5\n'});
        try{const c=await s.stage();expect(c.protectedSource?.sha256).toBe(s.source?.sha256);expect(c.tables[0].rows).toEqual(value.tables[0].rows);
            expect(s.port.diff(c.candidateId).valueDiff).toMatchObject({changedCells:2});expect(c.validation).toBe('pending');
        }finally{s.cleanup();}
    });
    it('refuses partial source-byte input even when the output claims complete',async()=>{
        const s=await setup(output(),{text:'Name,Amount\nA,1\nB,2\n',length:5});try{await expect(s.stage()).rejects.toThrow('candidate_partial_input');}finally{s.cleanup();}
    });
    it('preserves nested/repeated headers, group and subtotal exclusions as inspectable source lineage',async()=>{
        const value=output();value.tables[0].lineage=value.tables[0].lineage.map(l=>({...l,origins:[{kind:'source',name:'raw',row:l.row+4,column:l.column==='Name'?1:2}]})) as never;
        value.excludedRows=[0,1,2,3,6,7,8].map(row=>({origin:{kind:'source',name:'raw',row},reason:'declared header/group/summary'})) as never;
        const s=await setup(value,{text:'Sales report\nRegion,Values\n,Name,Amount\nEast,,\nEast,Total Solutions,0\nEast,Detail,-5\nEast,Subtotal,-5\n,Grand total,-5\n,Name,Amount\n'});
        try{const c=await s.stage();expect(c.excludedRows.map(e=>e.origin.row)).toEqual([0,1,2,3,6,7,8]);expect(c.tables[0].rows).toEqual(value.tables[0].rows);
            expect(c.validation).toBe('pending');expect(s.root.getState().datasetBundle?.source.inspection?.sha256).toBe(s.source?.sha256);
        }finally{s.cleanup();}
    });
    it('stages an exact complete envelope emitted by stateful finish without treating checkpoints as authority',async()=>{
        const s=await setup(output(),undefined,true);try{const c=await s.stage();expect(c.execution.mode).toBe('stateful_stream');expect(c.execution.checkpoints).toHaveLength(3);
            expect(c.tables[0].rows).toEqual(output().tables[0].rows);expect(c.execution.coverage?.[0]).toMatchObject({complete:true,deliveredRows:3});
        }finally{s.cleanup();}
    });
    it('rejects source-cell references outside the actual original record',async()=>{
        const value=output();value.tables[0].lineage=value.tables[0].lineage.map(l=>({...l,origins:[{kind:'source',name:'raw',row:l.row+1,column:999}]})) as never;
        const s=await setup(value,{text:'Name,Amount\nA,1\nB,2\n'});try{await expect(s.stage()).rejects.toThrow('candidate_origin_invalid');}finally{s.cleanup();}
    });
    it('allows empty output with complete exclusions, without treating it as an answer',async()=>{
        const value=output();value.tables[0].rows=[];value.tables[0].rowCount=0;value.tables[0].lineage=[];
        value.excludedRows=[0,1,2].map(row=>({origin:{kind:'table' as const,name:'input',row},reason:'declared exclusion'}));
        const s=await setup(value);try{const c=await s.stage();expect(c.tables[0].rows).toEqual([]);expect(c.answerEvidence).toBe(false);}finally{s.cleanup();}
    });
    it('materializes named tables/relationships but leaves cardinality and fabricated values unvalidated',async()=>{
        const value=output();value.tables[0].rows[0].Amount=999;
        value.tables.push({...value.tables[0],name:'dimension',role:'dimension',rows:[{Name:'Total Solutions',Amount:0}],rowCount:1,lineage:value.tables[0].lineage.filter(l=>l.row===0)} as never);
        value.relationships=[{fromTable:'facts',toTable:'dimension',fromKeys:['Name'],toKeys:['Name'],cardinality:'many_to_one'}] as never;
        const s=await setup(value);try{const c=await s.stage();expect(c.tables).toHaveLength(2);expect(c.relationships).toHaveLength(1);expect(c.validation).toBe('pending');expect(c.answerEvidence).toBe(false);
            expect(s.port.diff(c.candidateId).valueDiff).toMatchObject({changedCells:1});expect(s.root.getState().csvData!.data[0].Amount).toBe(0);
        }finally{s.cleanup();}
    });
    it('rejects forged locator identity through the action executor',async()=>{
        const s=await setup();s.store.candidateStaging=s.port;s.store.executionContext={lease:s.lease,toolCallId:'stage',stepId:'stage'};
        try{const result=await executeCandidateAction({type:'tool_call',toolName:'candidate.stage',args:{jobId:s.receipt.jobId,sessionId:'forged'}} as never,s.store);expect(result.status).toBe('blocked');expect(s.port.list()).toEqual([]);}finally{s.cleanup();}
    });
    it('rejects a program revision and same-version row mutation after execution',async()=>{
        const s=await setup();try{await s.workspace.write(s.program.path,'return 999;',1);await expect(s.stage()).rejects.toThrow('workspace_conflict');}finally{s.cleanup();}
        const t=await setup();try{t.root.getState().csvData!.data[0].Amount=123;await expect(t.stage()).rejects.toThrow('input_version_changed');}finally{t.cleanup();}
    });
    it('invalidates the candidate on scope change and refuses cross-namespace lookup/cleanup',async()=>{
        const s=await setup(),other=await setup();try{const c=await s.stage(),next=await other.stage();expect(c.changeDigest).not.toBe(next.changeDigest);
            expect(()=>s.port.read(next.candidateId)).toThrow('candidate_unavailable');s.port.dispose();expect(other.port.read(next.candidateId)).toBe(next);
            await other.prep.task.resolveScope({requiresEvidence:true,queries:[],unresolved:['metric'],complete:false});expect(()=>other.port.read(next.candidateId)).toThrow();
        }finally{s.cleanup();other.cleanup();}
    });
    it('fences a deferred candidate hash after session replacement and leaves the next run intact',async()=>{
        const s=await setup();let release!:()=>void,entered!:()=>void;
        const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
        const original=crypto.subtle.digest.bind(crypto.subtle);const spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{entered();await wait;return original(...args);});
        try{const pending=s.stage();await ready;beginSessionTransition(s.root);const next=beginRun(s.root,'follow_up','new-run','new-turn');s.root.setState({isBusy:true});release();await expect(pending).rejects.toThrow();
            expect(()=>s.port.list()).toThrow();expect(s.root.getState().activeExecution?.runId).toBe('new-run');expect(s.root.getState().isBusy).toBe(true);finishRun(s.root,next);
        }finally{spy.mockRestore();s.cleanup();}
    });
    it('rechecks candidate tool permission before publishing after a deferred hash',async()=>{
        const s=await setup();let release!:()=>void,entered!:()=>void;
        const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
        const original=crypto.subtle.digest.bind(crypto.subtle);const spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{entered();await wait;return original(...args);});
        try{const pending=s.stage();await ready;const settings=s.root.getState().settings;
            s.root.setState({settings:{...settings,runtimeAccessControl:{...settings.runtimeAccessControl,toolOverrides:{'candidate.stage':'deny'}}} as never});
            release();await expect(pending).rejects.toThrow('capability_unavailable');expect(s.port.list()).toEqual([]);
        }finally{spy.mockRestore();s.cleanup();}
    });
});
