import {createAssistantMessageEventStream,type AssistantMessage,type JsonObject} from '@earendil-works/pi-ai';
import type {StreamFn} from '@earendil-works/pi-agent-core';
import type {StoreApi} from '../../types';
import type {CodeExecutionReceipt,CodeRunRequest} from '../../execution/codeExecutionContract';
import {createSingleTableDatasetBundle} from '../../../data/datasetBundle';
import {createJavaScriptGuest} from '../../../sandbox/javascriptGuestClient';
import {beginRun,beginSessionTransition,cancelOwnedRun,finishRun} from '../../../session/sessionOwnership';
import {hasSavableSession} from '../../../persistence/persistedAppState';
import {resolveReportStructureArtifacts} from '../../reportStructureState';
import {trySandboxCleaningFallback} from '../../orchestration/sandboxCleaningFallback';
import {runPiInitialAnalysis,cancelPiInitialAnalysis,type PiInitialAnalysisOptions} from './piInitialAnalysisRuntimeService';
import {createInitialAnalysisStageExecutors} from './initialAnalysisStageExecutors';
import {runPiFollowUpTurn} from './piFollowUpRuntimeService';

export interface PreparationCheck {id:string;passed:boolean;elapsedMs:number;details?:Record<string,unknown>}
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const ref=({path,revision,sha256}:{path:string;revision:number;sha256:string})=>({path,revision,sha256});
const scripted=(next:(context:Parameters<StreamFn>[1])=>AssistantMessage['content']):StreamFn=>(model,context)=>{
    const content=next(context),stopReason=content.some(part=>part.type==='toolCall')?'toolUse':'stop';
    const message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason,timestamp:Date.now()};
    const stream=createAssistantMessageEventStream();stream.push({type:'start',partial:message});stream.push({type:'done',reason:stopReason,message});return stream;
};
const tool=(name:string,args:Record<string,unknown>):AssistantMessage['content']=>[{type:'toolCall',id:crypto.randomUUID(),name,arguments:args as JsonObject}];

/** Keyless synthetic plumbing qualification. Initial stops at the real missing-structure gate after preparation. */
export const qualifyPiExecutorPreparation=async(signal:AbortSignal,onObservation?:(check:PreparationCheck)=>void)=>{
    const observations:PreparationCheck[]=[];
    const fixture=()=>{
        const data={fileName:'synthetic-preparation.csv',data:Array.from({length:5001},(_,i)=>({Amount:i===5000?-5:1}))};
        const bundle=createSingleTableDatasetBundle({datasetId:crypto.randomUUID(),sourceFingerprint:'synthetic',file:{name:data.fileName,size:0,lastModified:0},data});
        let state={sessionId:`preparation-lab-${crypto.randomUUID()}`,settings:{provider:'default',simpleModel:'mock',complexModel:'mock',language:'English',
            runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}},
            csvData:{fileName:data.fileName,data:[]},canonicalCsvData:data,rawCsvData:null,datasetBundle:bundle,currentDatasetId:null,
            analysisCards:[],columnProfiles:[],chatHistory:[],dataQualityIssues:[],activeDataQuery:null,reportMemoryScope:null,
            agentEvents:[],agentToolLogs:[],runtimeEvents:[],progressMessages:[],telemetryEvents:[],workspaceFiles:{},
            logAgentToolUsage(){},addProgress(){},clearActiveTurnCancellation(){},setStreamingMessage(){},
        } as unknown as ReturnType<StoreApi['getState']>;
        if(hasSavableSession(state))throw new Error('Fixture cannot persist');
        const root:StoreApi={getState:()=>state,setState:patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};}};
        const originalBundle=JSON.stringify(bundle);
        const abort=()=>cancelOwnedRun(root);signal.addEventListener('abort',abort,{once:true});
        return {root,data,bundle,unchanged:()=>JSON.stringify(root.getState().datasetBundle)===originalBundle&&root.getState().csvData?.data.length===0&&root.getState().activeDataQuery===null,
            cleanup:()=>{signal.removeEventListener('abort',abort);beginSessionTransition(root);}};
    };
    const check=async(id:string,work:()=>Promise<{passed:boolean;details?:Record<string,unknown>}>)=>{
        if(signal.aborted)return;const started=performance.now();const result=await work();
        const observation={id,...result,elapsedMs:Math.round(performance.now()-started)};observations.push(observation);if(!signal.aborted)onObservation?.(observation);
    };
    const initial=async(mode:'default'|'repair'|'stream'|'stop'|'switch'|'legacy'|'legacy-cleaning')=>{
        const s=fixture();let receipt:Readonly<CodeExecutionReceipt>|undefined,failed:Readonly<CodeExecutionReceipt>|undefined;
        let staged=false,prepared=false,legacyCleaningCalls=0,stoppedAt:number|undefined,nextLease:ReturnType<typeof beginRun>|undefined;
        const options:PiInitialAnalysisOptions={stageServices:{resolveStructure:async()=>({...resolveReportStructureArtifacts({rawCsvData:null,csvData:null,rawIntakeIr:null,cleaningRun:null,dataPreparationPlan:null}),canonicalCsvData:s.data})}};
        if(mode!=='default')options.codingPreparation={enabled:true,prepareStage:async owned=>{
            prepared=true;
            if(mode==='legacy-cleaning'){
                const executors=createInitialAnalysisStageExecutors({runCleaning:async()=>{legacyCleaningCalls++;}});
                const result=await executors['dataset.applyTransform']({store:owned,signal:owned.executionContext!.lease.signal,
                    request:{appSessionId:s.root.getState().sessionId,datasetId:'synthetic',datasetVersion:s.bundle.datasetVersion,
                        researchGoal:'Stage a synthetic total.',provider:{provider:'default',modelId:'mock'}}},{});
                staged=result.decision==='fail'&&result.warningCodes.includes('shared_initial_cleaning_not_qualified')&&legacyCleaningCalls===0;
                return;
            }
            if(mode==='legacy'){
                const result=await trySandboxCleaningFallback({store:owned,rawData:s.data,workingData:s.data,workingProfiles:[],round:2,previousFailure:new Error('synthetic failure')});
                staged=result.status==='retry'&&result.error?.message==='shared_executor_requires_candidate_validation';return;
            }
            const workspace=owned.codeExecution!.workspace;
            const execute=async(code:string,stream=false)=>{
                const program=await workspace.write('/workspace/program.js',code,workspace.revision('/workspace/program.js'));
                const request:CodeRunRequest={program:ref(program),inputs:[],tables:[{name:'facts',tableId:s.bundle.primaryTableId}],
                    output:{path:'/workspace/output.json',expectedRevision:0,format:'json'},...(stream?{mode:'stateful_stream',stream:{table:'facts',batchRows:5000,partitionBy:[],initialState:null}}:{})};
                await owned.piTask!.beforeTool('code.run',request,owned.executionContext!.toolCallId);
                const result=await owned.codeExecution!.run(request,owned.executionContext!);
                if(!owned.executionContext!.lease.signal.aborted)owned.piTask!.afterTool('code.run',{toolName:'code.run',status:result.status==='succeeded'?'success':'error',message:result.reasonCode,shouldStop:false,artifacts:{codeExecution:result}},owned.executionContext!);
                return result;
            };
            if(mode==='repair')failed=await execute('throw new TypeError("synthetic missing column");');
            receipt=await execute(mode==='stop'||mode==='switch'?'while(true){}':mode==='stream'
                ? `const state=(input.stream.state||0)+input.facts.rows.reduce((sum,r)=>sum+r.Amount,0);return {state,rows:input.stream.phase==='finish'?[{total:state}]:[]};`
                : 'return input.facts.rows.reduce((sum,r)=>sum+r.Amount,0);',mode==='stream');
            if(receipt.status==='succeeded')staged=workspace.read('/workspace/output.json').content===(mode==='stream'?'[{"total":4995}]':'4995');
        },guest:{run:(code,json,opts)=>{
            const guest=createJavaScriptGuest(s.root);
            return guest.run(code,json,{...opts,onStarted:()=>{
                opts.onStarted?.();
                if(mode==='stop'){stoppedAt=performance.now();cancelPiInitialAnalysis(s.root.getState().sessionId);}
                if(mode==='switch'){stoppedAt=performance.now();beginSessionTransition(s.root);nextLease=beginRun(s.root,'follow_up','replacement-run','replacement-turn');s.root.setState({isBusy:true,finalSummary:{language:'English',text:'replacement'}});}
            }}).finally(()=>guest.dispose());
        },cancel(){},dispose(){}}};
        try{
            const result=await runPiInitialAnalysis({appSessionId:s.root.getState().sessionId,datasetId:'synthetic',datasetVersion:s.bundle.datasetVersion,researchGoal:'Stage a synthetic total.',provider:{provider:'default',modelId:'mock'}},
                s.root,scripted(()=>tool('run_next_analysis_stage',{})),options);
            const cancelled=mode==='stop'||mode==='switch';
            const passed=cancelled?result.status==='cancelled'&&stoppedAt!==undefined&&performance.now()-stoppedAt<2000
                &&(mode==='switch'?s.root.getState().activeExecution?.runId==='replacement-run'&&s.root.getState().isBusy&&s.root.getState().finalSummary?.text==='replacement':!s.root.getState().isBusy)
                :mode==='default'?!prepared&&!s.root.getState().activeAgentTask
                :mode==='legacy'||mode==='legacy-cleaning'?staged:staged&&receipt?.status==='succeeded'&&receipt.turnId===undefined&&receipt.toolCallId!==undefined
                    &&(mode!=='repair'||failed?.status==='failed'&&failed.error?.name==='TypeError');
            const terminalTruth=cancelled||mode==='default'||result.status==='failed'&&s.root.getState().activeAgentTask?.status==='blocked';
            return {passed:Boolean(passed)&&terminalTruth&&s.unchanged()&&result.trustedCardIds.length===0,details:{status:result.status,prepared,staged,receipt,failed,legacyCleaningCalls,taskStatus:s.root.getState().activeAgentTask?.status,
                ...(stoppedAt!==undefined?{stopMs:Math.round(performance.now()-stoppedAt)}:{})}};
        }finally{if(nextLease)finishRun(s.root,nextLease);s.cleanup();}
    };
    for(const [id,mode] of [['initial-default-off','default'],['initial-real-error-repair','repair'],['initial-stateful-tail','stream'],
        ['initial-stop','stop'],['initial-switch-new-run','switch'],['initial-legacy-commit-refused','legacy'],['initial-legacy-cleaning-refused','legacy-cleaning']] as const){if(signal.aborted)break;await check(id,()=>initial(mode));}
    await check('follow-up-shared-real-executor',async()=>{
        const s=fixture();let step=0;
        try{const result=await runPiFollowUpTurn({message:'Write a JavaScript program and stage its output.'},s.root,scripted(context=>{
            if(step++===0)return tool('workspace_write',{path:'/workspace/program.js',content:'return input.facts.rows.reduce((sum,r)=>sum+r.Amount,0);',expectedRevision:0});
            if(step===2){const last=context.messages.filter(message=>message.role==='toolResult').at(-1)!;
                const parsed=JSON.parse(last.content.filter(part=>part.type==='text').map(part=>part.text).join(''));
                return tool('code_run',{program:ref(parsed.payload.workspace.artifact),inputs:[],tables:[{name:'facts',tableId:s.bundle.primaryTableId}],output:{path:'/workspace/output.json',expectedRevision:0,format:'json'}});}
            return [{type:'text',text:'Fabricated 999 completed.'}];
        }));return {passed:result.status==='completed'&&!result.text?.includes('999')&&s.unchanged(),details:{status:result.status,budget:s.root.getState().activeAgentTask?.budget}};
        }finally{s.cleanup();}
    });
    return {passed:!signal.aborted&&observations.length===8&&observations.every(check=>check.passed),observations,
        qualification:'CA-123 preparation and CA-144 safety fences only; scripted provider, real Pi initial/follow-up runtime and worker. Missing-structure host gate deliberately blocks initial completion/publication. Production initial cutover is not qualified.'};
};
