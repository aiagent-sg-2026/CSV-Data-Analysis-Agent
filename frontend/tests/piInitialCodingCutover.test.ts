// @vitest-environment node
import {describe,it,expect,vi,beforeEach} from 'vitest';
import type {AssistantMessage,JsonObject} from '@earendil-works/pi-ai';
import type {StreamFn} from '@earendil-works/pi-agent-core';
import {createAssistantMessageEventStream,getCurrentTools} from '@earendil-works/pi-ai';
import {createSingleTableDatasetBundle} from '../services/data/datasetBundle';
import {captureCsvSource} from '../services/data/immutableCsvSource';
import {runPiInitialAnalysis} from '../services/agent/runtime/pi/piInitialAnalysisRuntimeService';
import type {StoreApi} from '../services/agent/types';
import {beginSessionTransition} from '../services/session/sessionOwnership';
import {preparePiInitialCodingUiSmoke} from '../services/agent/runtime/pi/piInitialCodingQualification';
import {handleClarificationResponse} from '../services/agent/orchestration/chatOrchestrator';
import type {StorageDatabase} from '../services/storageService';
import type {DatasetCommitMarker} from '../types/datasetCommit';
import {commitHeadKey} from '../types/datasetCommit';
import {readPiInitialCheckpoint} from '../services/agent/runtime/pi/piInitialCheckpoint';
import {cancelOwnedRun,beginRun} from '../services/session/sessionOwnership';
import {writePiInitialCheckpoint,type PiInitialCheckpointV2} from '../services/agent/runtime/pi/piInitialCheckpoint';
import {recoverPiInitialAnalysisIfNeeded} from '../services/agent/runtime/pi/piInitialAnalysisRuntimeService';
import {reattachPiInitialCheckpointSource} from '../services/agent/runtime/pi/piInitialCheckpointRecovery';
import {reconcileInitialCodingCheckpoint,verifyInitialCodingCommit} from '../services/agent/runtime/pi/piInitialCodingCheckpoint';
import {inspectPiCandidateReview} from '../services/agent/runtime/pi/piCandidateReviewState';
import {recoverCandidateReview,commitRecoveredCandidate} from '../services/data/candidateRecovery';
import {scopeRunStore,finishRun} from '../services/session/sessionOwnership';
import {createCleaningRun} from '../services/agent/cleaningRunState';
const io=vi.hoisted(()=>({records:new Map<string,unknown>(),commits:0,queryCalls:0,beforeQuery:undefined as undefined|(()=>Promise<void>)}));
vi.mock('../services/storageService',async original=>({...await original<typeof import('../services/storageService')>(),
    getStorageDatabase:async()=>({get:async(_name:string,key:string)=>io.records.get(key),getAllFromIndex:async()=>[...io.records.values()].filter(r=>(r as DatasetCommitMarker).kind==='commit')}) as unknown as StorageDatabase}));
vi.mock('../services/persistence/datasetCommitStorage',()=>({
    readCommitIntent:async()=>undefined,
    commitDatasetTransaction:async(_db:unknown,marker:DatasetCommitMarker,_baseline:unknown,check:()=>void,admit:()=>void)=>{
        check();admit();io.commits++;io.records.set(marker.recordId,structuredClone(marker));
        io.records.set(commitHeadKey(marker.sessionId),{kind:'head',sessionId:marker.sessionId,commitId:marker.commitId,revision:marker.revision,markerKey:marker.recordId});
        return {marker,replay:false};
    },
}));
vi.mock('../services/duckdb/queryEngine',async original=>({...await original<typeof import('../services/duckdb/queryEngine')>(),
    primeDuckDbDataset:vi.fn(async()=>({engine:'duckdb',tableName:'data',loadVersion:'bound',fallbackReason:null})),
    executeManagedDataQuery:async(data:import('../types').CsvData,plan:import('../types').QueryPlan,allowedColumns:string[])=>{
        io.queryCalls++;await io.beforeQuery?.();
        const {executeDataQuery}=await import('../services/agent/execution/dataOperationRunner');
        return {result:executeDataQuery(data.data,plan,{allowedColumns,maxRows:500,maxColumns:50,maxOrderBy:3}),
            engine:'native',tableName:null,loadVersion:null,sqlPreview:null,fallbackReason:null};
    }}));
vi.mock('../services/persistence/currentSessionPersistence',async original=>({...await original<typeof import('../services/persistence/currentSessionPersistence')>(),persistCurrentAppSessionSnapshot:vi.fn(async()=>true)}));
vi.mock('../services/sandbox/javascriptGuestClient',async()=>{
    const {newQuickJSWASMModuleFromVariant}=await import('quickjs-emscripten-core');
    const {default:variant}=await import('@jitl/quickjs-wasmfile-release-sync');
    const {executeQuickJsGuest}=await import('../services/sandbox/quickJsGuest');
    const {resolveGuestLimits}=await import('../services/sandbox/javascriptGuestProtocol');
    const wasm=newQuickJSWASMModuleFromVariant(variant);
    return {createJavaScriptGuest:()=>({run:(code:string,inputJson:string,options:{limits?:Parameters<typeof resolveGuestLimits>[0];onStarted?:()=>void})=>executeQuickJsGuest({generation:1,code,inputJson,limits:resolveGuestLimits(options?.limits)},()=>wasm,options?.onStarted),cancel(){},dispose(){}})};
});

const memory=new Map<string,string>();
const tool=(name:string,args:unknown):AssistantMessage['content']=>[{type:'toolCall',id:crypto.randomUUID(),name,arguments:args as JsonObject}];
const scripted=(next:(context:Parameters<StreamFn>[1])=>AssistantMessage['content']):StreamFn=>(model,context)=>{
    const content=next(context),message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        stopReason:content.some(p=>p.type==='toolCall')?'toolUse':'stop',timestamp:Date.now()};
    const s=createAssistantMessageEventStream();s.push({type:'start',partial:message});s.push({type:'done',reason:content.some(p=>p.type==='toolCall')?'toolUse':'stop',message});return s;
};
const fixture=async()=>{
    const data={fileName:'synthetic-initial.csv',data:[{Name:'Total Solutions',Amount:0},{Name:'Detail',Amount:-5},{Name:'Subtotal',Amount:-5}]};
    const file=new File(['Name,Amount\nTotal Solutions,0\nDetail,-5\nSubtotal,-5\n'],data.fileName);
    const bundle=createSingleTableDatasetBundle({datasetId:'initial-synthetic',sourceFingerprint:'synthetic',file,data});
    let state={sessionId:'initial-'+crypto.randomUUID(),csvData:data,canonicalCsvData:data,rawCsvData:structuredClone(data),datasetBundle:bundle,
        confirmedAnalysisGoal:'Remove the reconciled subtotal and analyse detail values.',settings:{provider:'default',simpleModel:'mock',complexModel:'mock',language:'English',
            runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}},
        analysisCards:[],columnProfiles:[],chatHistory:[],dataQualityIssues:[],agentEvents:[],agentToolLogs:[],runtimeEvents:[],progressMessages:[],telemetryEvents:[],workspaceFiles:{},
        activeDataQuery:null,logAgentToolUsage(){},addProgress(){},ensureDatasetSemanticSnapshot:async()=>null,
    } as unknown as ReturnType<StoreApi['getState']>;
    const root:StoreApi={getState:()=>state,setState:p=>{state={...state,...(typeof p==='function'?p(state):p)};}};
    const source=await captureCsvSource(root,file);root.setState({datasetBundle:{...bundle,source:{...bundle.source,inspection:source}}});
    return {root,data,file,source,request:{appSessionId:state.sessionId,datasetId:'initial-synthetic',datasetVersion:bundle.datasetVersion,
        researchGoal:state.confirmedAnalysisGoal!,provider:{provider:'default' as const,modelId:'mock'}}};
};
const bareStore=():StoreApi=>{
    let state={sessionId:'unseeded',settings:{},analysisCards:[],columnProfiles:[],chatHistory:[],agentEvents:[],agentToolLogs:[],runtimeEvents:[],
        progressMessages:[],telemetryEvents:[],dataQualityIssues:[],workspaceFiles:{},queryHistory:[],
        logAgentToolUsage(){},addProgress(){},clearActiveTurnCancellation(){},setStreamingMessage(){},ensureDatasetSemanticSnapshot:async()=>null,
    } as unknown as ReturnType<StoreApi['getState']>;
    return {getState:()=>state,setState:p=>{state={...state,...(typeof p==='function'?p(state):p)};}};
};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};

describe('initial shared coding phase',()=>{
    beforeEach(()=>{memory.clear();io.records.clear();io.commits=0;io.queryCalls=0;io.beforeQuery=undefined;vi.stubGlobal('localStorage',{getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)});});
    it('exposes automatic meaning in the same Pi initial Agent after inspection',async()=>{
        const f=await fixture();let calls=0,offered=false;
        try{
            await runPiInitialAnalysis(f.request,f.root,scripted(context=>{
                if(calls++===0){offered=getCurrentTools(context.messages)?.some(t=>t.name==='candidate_infer_meaning')===true;return tool('run_next_analysis_stage',{});}
                return [{type:'text',text:'No unsupported factual answer.'}];
            }),{codingPreparation:{enabled:true,qualified:true},stageServices:{resolveStructure:async()=>({canonicalCsvData:f.data,canonicalBuildMeta:null,
                canonicalizationStatus:'ready',reportStructureResolution:{requiresHumanReview:false,source:'synthetic',decision:{targetShape:'row_table'}},pipelineOutcome:{canAutoAnalyze:true}}) as never}} as never);
            expect(offered).toBe(true);
        }finally{beginSessionTransition(f.root);}
    });
    it('pins the catalog and loads guidance/support through the actual initial Pi loop before any stage',async()=>{
        const f=await fixture();let calls=0,catalog=false;const observations:string[]=[];
        try{
            const result=await runPiInitialAnalysis(f.request,f.root,scripted(context=>{
                catalog ||= JSON.stringify(context.messages).includes('host_pinned_skill_catalog');
                const last=context.messages.filter(m=>m.role==='toolResult').at(-1);
                if(last)observations.push(last.content.filter(p=>p.type==='text').map(p=>p.text).join(''));
                if(calls++===0)return tool('read_skill',{name:'investigate-report-structure'});
                if(calls===2)return tool('read_skill',{name:'investigate-report-structure',file:'scripts/describe-shape.js'});
                throw new Error('Synthetic provider stopped after skill loading.');
            }),{codingPreparation:{enabled:true,qualified:true}});
            expect(catalog).toBe(true);expect(observations[0]).toContain('untrusted_skill_guidance');expect(observations[1]).toContain('/workspace/skill-support/');
            expect(result.status).toBe('failed');expect(f.root.getState().activeAgentTask?.budget.used.skillReads).toBe(2);
            expect(f.root.getState().activeAgentTask?.budget.used.transformationAttempts).toBe(0);expect(f.root.getState().activeAgentTask?.capabilityGrants).toEqual([]);
            expect(readPiInitialCheckpoint(f.root.getState().sessionId)?.pendingStageIndex).toBeNull();
            expect(io.commits).toBe(0);expect(io.queryCalls).toBe(0);
        }finally{beginSessionTransition(f.root);}
    });
    it('repairs through actual shared tools, releases review and resumes under a fresh initial lease',async()=>{
        const root=bareStore(),visible:Array<string|null|undefined>=[],set=root.setState;
        root.setState=p=>{set(p);if(root.getState().pendingClarification)visible.push(root.getState().activeExecution?.runId);};
        try{
            const trace:string[]=[];
            const f=await preparePiInitialCodingUiSmoke(root,{observe:context=>{const last=context.messages.filter(m=>m.role==='toolResult').at(-1);if(last)trace.push(last.content.filter(p=>p.type==='text').map(p=>p.text).join(''));}});
            expect(f.result.status,trace.slice(0,10).join('\n')).toBe('blocked');
            expect(root.getState().pendingClarification?.resumeContext?.piCandidateApproval).toBeDefined();
            expect(root.getState().chatHistory.at(-1)?.type).toBe('ai_clarification');
            expect(inspectPiCandidateReview(root).available).toBe(true);
            expect(root.getState().activeAgentTask?.status).toBe('awaiting_approval');
            expect(root.getState().activeAgentTask?.budget.pausedForUser).toBe(true);
            expect(root.getState().activeAgentTask?.requiredOutputs.filter(o=>o.id==='staged-output')).toHaveLength(1);
            expect(visible.length).toBeGreaterThan(0);expect(visible.every(id=>id==null)).toBe(true);
            expect(root.getState().csvData?.data).toHaveLength(3);expect(io.commits).toBe(0);
            expect(readPiInitialCheckpoint(f.sessionId)).toMatchObject({schemaVersion:2,nextStageIndex:2,pendingStageIndex:2,coding:{version:1}});
            await handleClarificationResponse({label:'Approve',value:'approve'},root);
            expect(io.commits).toBe(1);expect(io.queryCalls).toBe(1);expect(root.getState().csvData?.data).toHaveLength(2);
            expect(root.getState().rawCsvData?.data).toHaveLength(3);expect(root.getState().initialAnalysisStatus).toBe('degraded');
            expect(root.getState().activeAgentTask?.status).toBe('completed');expect(root.getState().activeAgentTask?.taskId).toBe(f.taskId);
            expect(root.getState().activeAgentTask?.budget.used.transformationAttempts).toBe(1);
            expect(root.getState().activeAgentTask?.budget.used.toolCalls).toBeGreaterThan(f.oldBudget!.used.toolCalls);
            expect(root.getState().analysisCards[0].aggregatedData).toEqual([{Name:'Total Solutions',Total:0},{Name:'Detail',Total:-5}]);
            expect(root.getState().analysisCards[0].provenance?.datasetVersion).toBe(root.getState().finalSummaryProvenance?.datasetVersion);
            expect(root.getState().pendingClarification).toBeNull();expect(root.getState().activeExecution).toBeNull();
            expect(readPiInitialCheckpoint(f.sessionId)).toBeNull();
        }finally{beginSessionTransition(root);}
    });
    it.each(['deny','wrong-output','missing-report'] as const)('does not complete %s',async mode=>{
        const root=bareStore();root.setState({cleaningRun:{...createCleaningRun(),status:'running'}});try{
            await preparePiInitialCodingUiSmoke(root,{mode:mode==='deny'?'repair':mode});
            expect(root.getState().cleaningRun?.status).toBe('paused');
            if(root.getState().pendingClarification)await handleClarificationResponse({label:mode==='deny'?'Deny':'Approve',value:mode==='deny'?'deny':'approve'},root);
            expect(root.getState().activeAgentTask?.status).toBe('blocked');expect(root.getState().initialAnalysisStatus).not.toBe('ready');
            expect(io.commits).toBe(mode==='missing-report'?1:0);expect(io.queryCalls).toBe(mode==='missing-report'?1:0);
            expect(root.getState().cleaningRun?.status).toBe(mode==='missing-report'?'completed':'paused');
            expect(root.getState().chatHistory.map(m=>m.text).join(' ')).not.toContain('Unverified 999 completed.');
        }finally{beginSessionTransition(root);}
    });
    it('skips cleaning before coding while retaining required query/report stages',async()=>{
        const root=bareStore();try{
            const f=await preparePiInitialCodingUiSmoke(root,{mode:'no-cleaning'});
            expect(f.result.status,f.result.error?.message).toBe('completed');expect(io.commits).toBe(0);expect(io.queryCalls).toBe(1);
            expect(root.getState().pendingClarification).toBeNull();expect(root.getState().csvData?.data).toHaveLength(2);
        }finally{beginSessionTransition(root);}
    });
    it('names the skip call when qualified cleaning planned 0 operations, and the skip then succeeds',async()=>{
        const root=bareStore();root.setState({dataPreparationPlan:{explanation:'',operations:[],outputColumns:[],planStatus:'operations',consistencyIssues:[]}});
        let step=0,gate='',skipped='',listing:{files?:{path:string}[];totalFiles?:number;truncated?:boolean}|undefined,taskPlan:unknown;const stages:string[]=[];
        try{
            const f=await preparePiInitialCodingUiSmoke(root,{mode:'no-cleaning',wrapStream:()=>scripted(context=>{
                const last=context.messages.filter(m=>m.role==='toolResult').at(-1),text=last?.content.filter(p=>p.type==='text').map(p=>p.text).join('')??'';
                if(last?.toolName==='run_next_analysis_stage'&&!last.isError)stages.push((JSON.parse(text) as {stage:string}).stage);
                const index=step++;
                if(index<3)return tool('run_next_analysis_stage',{});
                if(index===3)return tool('run_next_analysis_stage',{stage:'dataset.applyTransform',reason:'a data quality note is present'});
                // A read-only listing inside the cleaning window must show entries and must not forfeit the skip.
                if(index===4){gate=text;return tool('workspace_list',{path:'/dataset'});}
                if(index===5){const parsed=JSON.parse(text);listing=parsed.payload?.workspace?.result;taskPlan=parsed.taskPlan;
                    return tool('run_next_analysis_stage',{stage:'dataset.validatePreparedData',reason:'The cleaning plan produced no operations'});}
                if(index===6)skipped=text;
                return tool('run_next_analysis_stage',{});
            })});
            expect(gate).toMatch(/^initial_cleaning_requires_exact_candidate_approval: /);
            expect(gate).toContain('planned 0 governed cleaning operation(s)');
            expect(gate).toContain('call run_next_analysis_stage with {"stage":"dataset.validatePreparedData"}');
            expect(gate).toContain('candidate_request_approval');
            expect(listing?.files?.map(file=>file.path)).toEqual(expect.arrayContaining(['/dataset/cleaned.csv']));
            expect(listing).toMatchObject({truncated:false});expect(listing?.totalFiles).toBeGreaterThan(0);expect(taskPlan).toBeDefined();
            expect(JSON.parse(skipped)).toMatchObject({stage:'dataset.validatePreparedData',decision:'pass'});
            expect(stages.slice(0,4)).toEqual(['dataset.profileStructure','dataset.detectNoiseRows','dataset.suggestCleaningPlan','dataset.validatePreparedData']);
            expect(f.result.status,f.result.error?.message).toBe('completed');expect(io.commits).toBe(0);expect(io.queryCalls).toBe(1);
        }finally{beginSessionTransition(root);}
    });
    const rejectedProposal=(root:StoreApi)=>({input:{kind:'table',name:'original',tableId:root.getState().datasetBundle!.primaryTableId},
        table:{name:'facts',grain:['Name'],groupBy:[],columns:[{name:'Name',sourceColumn:'Name',dataType:'string',nullable:false,conversion:'identity'},
            {name:'Amount',sourceColumn:'Amount',dataType:'number',nullable:false,conversion:'identity',scale:2}],detailRanges:[{start:0,end:1}]},
        // Row 2 does not exist in the two-row no-cleaning fixture, so the host rejects the proposal.
        exclusions:[{row:2,role:'subtotal'}],assumptions:['Synthetic rejected proposal.']});
    it('says skipping is no longer permitted after a coding tool ran in the cleaning window',async()=>{
        const root=bareStore();let step=0,gate='',skip='';
        try{
            const f=await preparePiInitialCodingUiSmoke(root,{mode:'no-cleaning',wrapStream:()=>scripted(context=>{
                const last=context.messages.filter(m=>m.role==='toolResult').at(-1),text=last?.content.filter(p=>p.type==='text').map(p=>p.text).join('')??'';
                const index=step++;
                if(index<3)return tool('run_next_analysis_stage',{});
                if(index===3)return tool('candidate_infer_meaning',rejectedProposal(root));
                if(index===4){expect(JSON.parse(text).status).toBe('blocked');return tool('run_next_analysis_stage',{stage:'dataset.applyTransform'});}
                if(index===5){gate=text;return tool('run_next_analysis_stage',{stage:'dataset.validatePreparedData'});}
                if(index===6)skip=text;
                return tool('run_next_analysis_stage',{stage:'dataset.validatePreparedData'});
            })});
            expect(gate).toMatch(/^initial_cleaning_requires_exact_candidate_approval: /);
            expect(gate).toContain('Skipping cleaning is no longer permitted');expect(gate).not.toContain('{"stage":"dataset.validatePreparedData"}');
            expect(skip).toMatch(/^initial_cleaning_requires_exact_candidate_approval: .*no longer permitted/);
            expect(f.result.status).toBe('blocked');expect(root.getState().analysisCards).toHaveLength(0);expect(io.commits).toBe(0);
        }finally{beginSessionTransition(root);}
    });
    it('stops the cleaning window after repeated rejected meaning proposals instead of spending the time budget',async()=>{
        const root=bareStore();let calls=0;
        try{
            const f=await preparePiInitialCodingUiSmoke(root,{mode:'no-cleaning',wrapStream:()=>scripted(()=>{
                const index=calls++;
                if(index<3)return tool('run_next_analysis_stage',{});
                // Vary the proposal so identical-failure detection cannot be what stops the loop.
                return tool('candidate_infer_meaning',{...rejectedProposal(root),assumptions:[`Synthetic rejected proposal ${index}.`]});
            })});
            expect(f.result.status).toBe('blocked');
            expect(f.result.error?.message).toMatch(/^initial_cleaning_meaning_no_progress: 4 candidate_infer_meaning proposal\(s\) were rejected \(4 in a row\)/);
            expect(calls).toBe(7);expect(root.getState().activeAgentTask?.status).toBe('blocked');
            expect(root.getState().analysisCards).toHaveLength(0);expect(io.commits).toBe(0);expect(io.queryCalls).toBe(0);
        }finally{beginSessionTransition(root);}
    });
    it.each(['switch','stop'] as const)('fences a deferred post-approval query after %s',async mode=>{
        const root=bareStore(),gate=deferred(),started=deferred();try{
            await preparePiInitialCodingUiSmoke(root);io.beforeQuery=()=>{started.resolve();return gate.promise;};
            const running=handleClarificationResponse({label:'Approve',value:'approve'},root);
            await started.promise;
            if(mode==='switch'){beginSessionTransition(root);root.setState({sessionId:'replacement',analysisCards:[],finalSummary:null,csvData:{fileName:'new.csv',data:[{Amount:77}]},isBusy:true});beginRun(root,'follow_up','new-run','new-turn');}
            else cancelOwnedRun(root);
            await running;gate.resolve();await Promise.resolve();
            expect(root.getState().analysisCards).toHaveLength(0);expect(root.getState().finalSummary).toBeNull();
            if(mode==='switch'){expect(root.getState().activeExecution?.runId).toBe('new-run');expect(root.getState().isBusy).toBe(true);}
            else{expect(root.getState().initialAnalysisStatus).toBe('paused');expect(root.getState().csvData?.data).toHaveLength(2);}
        }finally{gate.resolve();beginSessionTransition(root);}
    });
    it('reconciles a lost cleaning acknowledgement from the exact journal, reattaches source and preserves consumed budget',async()=>{
        const root=bareStore(),restored=bareStore();try{
            const f=await preparePiInitialCodingUiSmoke(root),captured=readPiInitialCheckpoint(f.sessionId) as PiInitialCheckpointV2;
            await handleClarificationResponse({label:'Approve',value:'approve'},root);
            const marker=[...io.records.values()].find((r):r is DatasetCommitMarker=>(r as DatasetCommitMarker).kind==='commit')!;
            beginSessionTransition(root);
            restored.setState({...root.getState(),csvData:null,canonicalCsvData:null,rawCsvData:null,activeAgentTask:null,taskInspection:null,activeExecution:null,
                pendingClarification:null,datasetCommitBindingStatus:undefined,analysisCards:[],queryHistory:[],finalSummary:null,finalSummaryProvenance:null});
            writePiInitialCheckpoint(captured);
            await recoverPiInitialAnalysisIfNeeded(restored,f.stream,f.runtimeOptions);
            expect(restored.getState().initialAnalysisRecovery?.status).toBe('awaiting_source');expect(io.commits).toBe(1);
            const result=await reattachPiInitialCheckpointSource(f.file,restored,f.stream,f.runtimeOptions);
            expect(result?.status,restored.getState().initialAnalysisRecovery?.reason ?? '').toBe('degraded');
            expect(io.commits).toBe(1);expect(io.queryCalls).toBe(2);expect(restored.getState().csvData?.data).toHaveLength(2);
            expect(restored.getState().activeAgentTask?.taskId).not.toBe(f.taskId);
            expect(restored.getState().activeAgentTask?.budget.used.transformationAttempts).toBe(marker.taskBudget!.used.transformationAttempts);
            expect(restored.getState().activeAgentTask?.budget.used.providerTurns).toBeGreaterThanOrEqual(marker.taskBudget!.used.providerTurns);
            expect(restored.getState().activeAgentTask?.capabilityGrants).toEqual([]);expect(readPiInitialCheckpoint(f.sessionId)).toBeNull();
        }finally{beginSessionTransition(root);beginSessionTransition(restored);}
    });
    it('blocks uncommitted or unrelated pending stages without replay or restoring approval',async()=>{
        const root=bareStore();try{
            const f=await preparePiInitialCodingUiSmoke(root),captured=readPiInitialCheckpoint(f.sessionId) as PiInitialCheckpointV2;
            beginSessionTransition(root);root.setState({pendingClarification:null,isBusy:false});
            await recoverPiInitialAnalysisIfNeeded(root,f.stream,f.runtimeOptions);
            expect(root.getState().initialAnalysisRecovery?.status).toBe('blocked');expect(io.commits).toBe(0);expect(io.queryCalls).toBe(0);
            writePiInitialCheckpoint(captured);await handleClarificationResponse({label:'Approve',value:'approve'},root);
            expect(io.commits).toBe(0);expect(root.getState().pendingClarification).toBeNull();
        }finally{beginSessionTransition(root);}
    });
    it('rejects the wrong journal, modified budget and uncertain non-cleaning stage',async()=>{
        const root=bareStore();try{
            const f=await preparePiInitialCodingUiSmoke(root),cp=readPiInitialCheckpoint(f.sessionId) as PiInitialCheckpointV2;
            await handleClarificationResponse({label:'Approve',value:'approve'},root);
            const marker=[...io.records.values()].find((r):r is DatasetCommitMarker=>(r as DatasetCommitMarker).kind==='commit')!;
            await expect(verifyInitialCodingCommit(cp,{...marker,sessionId:'other'})).rejects.toThrow('initial_commit_mismatch');
            await expect(verifyInitialCodingCommit({...cp,pendingStageIndex:7},marker)).rejects.toThrow('stage_side_effects_uncertain');
            const increased=structuredClone(cp);increased.coding!.budget.limits.transformationAttempts=999;
            await expect(verifyInitialCodingCommit(increased,marker)).rejects.toThrow('task_budget_invalid');
            const reconciled=await reconcileInitialCodingCheckpoint(cp,root.getState(),marker);
            expect(reconciled.nextStageIndex).toBe(4);expect(reconciled.pendingStageIndex).toBeNull();
            expect(reconciled.coding!.budget.used.toolCalls).toBeGreaterThanOrEqual(marker.taskBudget!.used.toolCalls);
        }finally{beginSessionTransition(root);}
    });
    it('cannot finish the report by retaining an old headline when summary generation returns without writing',async()=>{
        const root=bareStore();try{
            const f=await preparePiInitialCodingUiSmoke(root),runEvidence=f.runtimeOptions.stageServices!.runEvidence!;
            f.runtimeOptions.stageServices!.runEvidence=async args=>{
                const result=await runEvidence(args),card=args.store.getState().analysisCards.at(-1)!;
                args.store.setState({finalSummary:{language:'English',text:'Old headline 999.'},finalSummaryProvenance:card.provenance});return result;
            };
            f.runtimeOptions.stageServices!.generateSummaries=async()=>undefined;
            await handleClarificationResponse({label:'Approve',value:'approve'},root);
            expect(io.commits).toBe(1);expect(io.queryCalls).toBe(1);expect(root.getState().activeAgentTask?.status).toBe('blocked');
            expect(root.getState().initialAnalysisStatus).toBe('paused');expect(root.getState().analysisCards).toHaveLength(1);
        }finally{beginSessionTransition(root);}
    });
    it('preserves provider failure as failed and does not execute legacy cleaning',async()=>{
        const root=bareStore(),runCleaning=vi.fn();let turns=0;try{
            const f=await preparePiInitialCodingUiSmoke(root,{observe:()=>{if(++turns===3)throw new Error('Synthetic provider failure');},stageServices:{runCleaning}});
            expect(f.result.status).toBe('failed');expect(root.getState().activeAgentTask?.status).toBe('failed');
            expect(readPiInitialCheckpoint(f.sessionId)?.coding?.budget.used.providerTurns).toBe(3);
            expect(io.commits).toBe(0);expect(io.queryCalls).toBe(0);expect(runCleaning).not.toHaveBeenCalled();
        }finally{beginSessionTransition(root);}
    });
    it('continues a separately revalidated interrupted candidate only after new exact approval, with its charged budget',async()=>{
        const root=bareStore();try{
            const f=await preparePiInitialCodingUiSmoke(root);
            beginSessionTransition(root);root.setState({pendingClarification:null,isBusy:false});
            const first=beginRun(root,'follow_up','revalidate'),firstStore=scopeRunStore(root,first);
            const recovered=await recoverCandidateReview(firstStore,{file:f.file});
            expect(recovered.status).toBe('review');expect(io.commits).toBe(0);finishRun(root,first);
            if(recovered.status!=='review')throw new Error('Expected fresh review');
            const approval=beginRun(root,'follow_up','recovery-approve'),approved=scopeRunStore(root,approval);
            const marker=await commitRecoveredCandidate(approved,recovered.review);finishRun(root,approval);
            expect(marker.taskBudget?.used.transformationAttempts).toBe(2);
            expect(marker.taskBudget?.used.toolCalls).toBeGreaterThan(f.oldBudget!.used.toolCalls);
            const result=await recoverPiInitialAnalysisIfNeeded(root,scripted(()=>tool('run_next_analysis_stage',{})),f.runtimeOptions);
            expect(result?.status,result?.error?.message).toBe('degraded');expect(io.commits).toBe(1);expect(io.queryCalls).toBe(1);
            expect(root.getState().activeAgentTask?.budget.used.transformationAttempts).toBe(2);
            expect(root.getState().activeAgentTask?.status).toBe('completed');
        }finally{beginSessionTransition(root);}
    });
});
