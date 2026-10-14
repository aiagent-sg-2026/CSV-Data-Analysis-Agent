import type { AssistantMessage, JsonObject } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { CsvRow, QueryPlan } from '../../../types';
import type { StoreApi } from '../types';
import { createSingleTableDatasetBundle } from '../../data/datasetBundle';
import { preparePiTask } from '../runtime/pi/piCodingTask';
import { runPiFollowUpTurn } from '../runtime/pi/piFollowUpRuntimeService';
import { beginRun, beginSessionTransition, cancelOwnedRun, finishRun, scopeRunStore } from '../../session/sessionOwnership';
import { hasSavableSession } from '../../persistence/persistedAppState';
import { createJavaScriptGuest } from '../../sandbox/javascriptGuestClient';
import { handleExecutorAction } from './executorAgent';
import { admitQueryEvidence, createQueryReceipt, resolveAnswerScope } from '../runtime/pi/queryEvidence';
import { admitComputationEvidence, validateComputationExecution, type RequestedComputationScope } from './computationEvidence';
import { retireDuckDbQueryBinding, type DuckDbDatasetBinding } from '../../duckdb/queryEngine';

export interface AdmissionCheck {id:string;passed:boolean;status:string;elapsedMs:number;details?:Record<string,unknown>}
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const ref=(a:{path:string;revision:number;sha256:string})=>({path:a.path,revision:a.revision,sha256:a.sha256});
const observations=(c:Parameters<StreamFn>[1])=>c.messages.filter(m=>m.role==='toolResult').map(m=>JSON.parse(m.content.filter(p=>p.type==='text').map(p=>p.text).join('')));
/** Guest uses online covariance, independently challenged by the host's centered two-pass reference. */
export const PEARSON_QUALIFICATION_PROGRAM = `
const rows=input.facts.rows.filter(r=>!r.Date||(r.Date>='2026-10-01'&&r.Date<'2026-11-01'));
let n=0,mx=0,my=0,xx=0,yy=0,xy=0;
for(const r of rows){if(r.X===null||r.Y===null||r.X===undefined||r.Y===undefined||r.X===''||r.Y==='')continue;
 n++;const dx=r.X-mx,dy=r.Y-my;mx+=dx/n;my+=dy/n;xx+=dx*(r.X-mx);yy+=dy*(r.Y-my);xy+=dx*(r.Y-my);}
return {method:'pearson_correlation',methodVersion:1,seed:'none',scopedRows:rows.length,n,excluded:rows.length-n,coefficient:n<2||xx===0||yy===0?null:xy/Math.sqrt(xx)/Math.sqrt(yy)};`;
const pearsonStreamProgram=`const s=input.stream.state||{n:0,mx:0,my:0,xx:0,yy:0,xy:0,scopedRows:0,excluded:0};
for(const r of input.facts.rows){if(r.Date&&(r.Date<'2026-10-01'||r.Date>='2026-11-01'))continue;s.scopedRows++;
if(r.X===null||r.Y===null||r.X===undefined||r.Y===undefined||r.X===''||r.Y===''){s.excluded++;continue;}
s.n++;const dx=r.X-s.mx,dy=r.Y-s.my;s.mx+=dx/s.n;s.my+=dy/s.n;s.xx+=dx*(r.X-s.mx);s.yy+=dy*(r.Y-s.my);s.xy+=dx*(r.Y-s.my);}
return {state:s,rows:input.stream.phase==='finish'?[{method:'pearson_correlation',methodVersion:1,seed:'none',scopedRows:s.scopedRows,n:s.n,excluded:s.excluded,coefficient:s.n<2||s.xx===0||s.yy===0?null:s.xy/Math.sqrt(s.xx)/Math.sqrt(s.yy)}]:[]};`;

export const qualifyEvidenceAdmission = async (signal:AbortSignal, onObservation?:(c:AdmissionCheck)=>void,
    guestFactory:(store:StoreApi)=>NonNullable<Parameters<typeof preparePiTask>[3]>=(store)=>createJavaScriptGuest(store)) => {
    const checks:AdmissionCheck[]=[];let cleanup=()=>{};let ownedBinding:DuckDbDatasetBinding|undefined;
    const record=async(id:string,work:()=>Promise<{passed:boolean;status:string;details?:Record<string,unknown>}>)=>{
        if(signal.aborted)throw signal.reason;
        const started=performance.now();
        try{const result=await work(),check={id,...result,elapsedMs:Math.round(performance.now()-started)};checks.push(check);onObservation?.(check);}
        finally{cleanup();cleanup=()=>{};if(ownedBinding){await retireDuckDbQueryBinding(ownedBinding);ownedBinding=undefined;}}
    };
    const fixture=async(rows:CsvRow[],goal:string)=>{
        const data={fileName:`synthetic-admission-${crypto.randomUUID()}.csv`,data:rows};
        const bundle=createSingleTableDatasetBundle({datasetId:crypto.randomUUID(),sourceFingerprint:'synthetic',file:{name:data.fileName,size:0,lastModified:0},data});
        let state={sessionId:`admission-lab-${crypto.randomUUID()}`,settings:{provider:'default',language:'English',simpleModel:'mock',complexModel:'mock',
            runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}},
            csvData:{...data,data:[]},canonicalCsvData:data,rawCsvData:null,currentDatasetId:null,reportMemoryScope:null,
            datasetBundle:bundle,semanticDatasetVersion:bundle.datasetVersion,analysisCards:[],columnProfiles:bundle.tables[0].schema.map(c=>({name:c.name,type:c.name==='Date'?'date':c.dataType})),
            chatHistory:[],queryHistory:[],dataQualityIssues:[],activeDataQuery:null,agentEvents:[],agentToolLogs:[],runtimeEvents:[],progressMessages:[],telemetryEvents:[],workspaceFiles:{},
            addProgress(){},logAgentToolUsage(){},clearActiveTurnCancellation(){},setStreamingMessage(){},
        } as unknown as ReturnType<StoreApi['getState']>;
        if(hasSavableSession(state))throw new Error('Fixture cannot persist');
        const root:StoreApi={getState:()=>state,setState:patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};}};
        const lease=beginRun(root,'follow_up',crypto.randomUUID(),crypto.randomUUID()),store=scopeRunStore(root,lease);
        const task=await preparePiTask(store,goal,undefined,guestFactory(store));
        const abort=()=>cancelOwnedRun(root);
        cleanup=()=>{signal.removeEventListener('abort',abort);task.close('cancelled');beginSessionTransition(root);finishRun(root,lease);};
        if(signal.aborted){abort();throw signal.reason;}
        signal.addEventListener('abort',abort,{once:true});
        const context=()=>{store.executionContext={lease,toolCallId:crypto.randomUUID(),stepId:crypto.randomUUID()};};context();
        const run=async(program:string)=>{
            const ws=store.codeExecution!.workspace,artifact=await ws.write('/workspace/program.js',program,ws.revision('/workspace/program.js'));
            const args={program:ref(artifact),inputs:[],tables:[{name:'facts',tableId:bundle.primaryTableId}],mode:'whole_table',output:{path:'/workspace/output.json',expectedRevision:ws.revision('/workspace/output.json'),format:'json'}};
            context();await task.beforeTool('code.run',args,store.executionContext!.toolCallId);
            const result=await handleExecutorAction({type:'tool_call',toolName:'code.run',args},store,{abortSignal:signal});task.afterTool('code.run',result,store.executionContext!);
            return (result.artifacts!.codeExecution as import('./codeExecutionContract').CodeExecutionReceipt).jobId;
        };
        return {root,store,lease,task,bundle,context,run};
    };
    const filter:QueryPlan['where']={predicates:[{column:'Date',operator:'gte',value:'2026-10-01'},{column:'Date',operator:'lt',value:'2026-11-01'}]};
    const comp:RequestedComputationScope={method:'pearson_correlation',x:'X',y:'Y',where:filter,missingPolicy:'pairwise_complete',seed:'none'};
    const artifact=(method=comp)=>({intent:'data_query',confidence:'high',taskSignal:'statistical',expectedOutput:'scalar_answer',referencedColumns:['X','Y'],groupingColumns:[],aggregationFunctions:[],
        filterDescription:'October 2026',timeScope:{kind:'explicit',value:'October 2026'},comparisonScope:{kind:'none'},subjectRefs:[],unresolvedReferences:[],requestedComputationScope:method} as const);
    const rows:CsvRow[]=[{X:1,Y:2,Date:'2026-10-01'},{X:2,Y:4,Date:'2026-10-02'},{X:3,Y:6,Date:'2026-10-03'},{X:4,Y:null,Date:'2026-10-04'},{X:5,Y:-99,Date:'2026-09-30'}];
    for(const mode of ['fresh','wrong-output','unvalidated','zero','constant','negative','boundary','stateful','unsupported'] as const)await record(`computation-${mode}`,async()=>{
        const input=mode==='zero'?rows.map(r=>({...r,Date:'2026-09-01'})):mode==='constant'?rows.map(r=>({...r,X:1})):mode==='negative'?rows.map(r=>({...r,Y:r.Y===null?null:-Number(r.Y)}))
            :mode==='boundary'||mode==='stateful'?Array.from({length:5001},(_,i)=>({X:i,Y:i%3===0?-i:i,Date:'2026-10-01'})):rows;
        const goal='Calculate Pearson correlation for X and Y, October 2026 only.',s=await fixture(input,goal);let call=0;let validated:import('./computationEvidence').ComputationEvidenceReceipt|undefined;
        const stream:StreamFn=(model,c)=>{
            let content:AssistantMessage['content'];
            const tool=(name:string,args:Record<string,unknown>):AssistantMessage['content']=>[{type:'toolCall',id:crypto.randomUUID(),name,arguments:args as JsonObject}];
            if(call++===0)content=tool('workspace_write',{path:'/workspace/program.js',expectedRevision:0,content:mode==='stateful'?pearsonStreamProgram:mode==='wrong-output'?PEARSON_QUALIFICATION_PROGRAM.replace('xy/Math.sqrt(xx)/Math.sqrt(yy)','0'):PEARSON_QUALIFICATION_PROGRAM});
            else if(call===2)content=tool('code_run',{program:ref(observations(c).at(-1).payload.workspace.artifact),inputs:[],mode:mode==='stateful'?'stateful_stream':'whole_table',
                ...(mode==='stateful'?{stream:{table:'facts',batchRows:5000,partitionBy:[],initialState:null}}:{}),tables:[{name:'facts',tableId:s.bundle.primaryTableId}],output:{path:'/workspace/output.json',expectedRevision:0,format:'json'}});
            else if(call===3&&mode!=='unvalidated')content=tool('computation_validate',{jobId:observations(c).at(-1).receipt.jobId});
            else {if(call===4&&mode!=='unvalidated')validated=observations(c).at(-1)?.artifacts?.computationEvidence;content=[{type:'text',text:'Unverified provider value 999.'}];}
            const message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:content[0].type==='toolCall'?'toolUse':'stop',timestamp:Date.now()};
            const out=createAssistantMessageEventStream();out.push({type:'start',partial:message});out.push({type:'done',reason:message.stopReason as 'toolUse'|'stop',message});return out;
        };
        const a=mode==='unsupported'?artifact({...comp,method:'custom_regression'} as never):artifact();
        const result=await runPiFollowUpTurn({message:goal,queryUnderstandingArtifact:a as never},s.store,stream);
        const blocked=['wrong-output','unvalidated','unsupported'].includes(mode);
        // UUIDs and valid decimals can contain 999. Reject the actual scripted provider claim.
        return {passed:result.status===(blocked?'blocked':'completed')&&!result.text.includes('Unverified provider value 999.')&&(mode!=='fresh'||result.text.includes('1.000000')),
            status:result.status,details:{text:result.text.slice(0,500),transformationAttempts:s.task.snapshot.budget.used.transformationAttempts,
                ...(validated?{referenceResult:validated.result,inputSha256:validated.inputSha256,programSha256:validated.execution.program!.sha256,outputSha256:validated.execution.output!.sha256,environmentDigest:validated.execution.environmentDigest}: {})}};
    });
    for(const mode of ['clone','output-edit','input-edit','version','task-revision','session'] as const)await record(`computation-refuse-${mode}`,async()=>{
        const s=await fixture(rows,'Calculate October 2026 Pearson correlation.');const scope=resolveAnswerScope(s.task.snapshot.goal,artifact() as never,undefined,s.store);
        if(scope.unresolved.length)throw new Error(scope.unresolved.join('; '));
        await s.task.resolveScope(scope);const job=await s.run(PEARSON_QUALIFICATION_PROGRAM);s.context();
        const receipt=await validateComputationExecution(s.store,job);
        if(mode==='output-edit'){const ws=s.store.codeExecution!.workspace;await ws.write('/workspace/output.json','{}',ws.revision('/workspace/output.json'));}
        if(mode==='input-edit')s.root.getState().canonicalCsvData!.data[0].X=99;
        if(mode==='version')s.root.setState({datasetBundle:{...s.bundle,relationshipSetId:'changed-relationship'}});
        if(mode==='task-revision')await s.task.resolveScope({...scope,computation:{...scope.computation!,where:undefined}});
        if(mode==='session')beginSessionTransition(s.root);
        const admitted=admitComputationEvidence(s.store,s.lease,[mode==='clone'?structuredClone(receipt):receipt]);
        return {passed:!admitted.receipt,status:admitted.receipt?'accepted':'blocked'};
    });
    await record('query-complete-derived-actual-dispatcher',async()=>{
        const data=Array.from({length:160},(_,i)=>({Town:`Town ${i}`,Amount:100,Profit:i,Date:'2026-10-03'}));
        const goal='Profit margin by Town',s=await fixture(data,goal);
        const plan:QueryPlan={groupBy:['Town'],aggregates:[{function:'sum',column:'Amount',as:'Sales'},{function:'sum',column:'Profit',as:'Profit'}],limit:100};
        const scope=resolveAnswerScope(goal,{taskSignal:'derive_metric',requestedQueryScopes:[{role:'result',plan}],timeScope:{kind:'none'}} as never,undefined,s.store);await s.task.resolveScope(scope);
        s.root.setState({activeTurn:{userMessage:goal,steps:[],runId:s.lease.runId,turnId:s.lease.turnId} as never});s.context();
        const result=await handleExecutorAction({type:'tool_call',toolName:'data.query',args:{explanation:'Complete margin inputs',plan}},s.store,{abortSignal:signal});
        const query=result.artifacts?.activeDataQuery as import('../../../types').ActiveDataQuery|undefined;
        if(query)ownedBinding={engine:query.engine,tableName:query.tableName,loadVersion:query.loadVersion,fallbackReason:null,fallbackStage:null};
        const receipt=query?createQueryReceipt(s.store,query):null;
        const admitted=admitQueryEvidence(s.store,s.lease,scope,receipt?[receipt]:[]);
        return {passed:admitted.verdict.status==='accepted'&&query?.plan.limit===500&&query.result.returnedRows===160,status:admitted.verdict.status,
            details:{engine:query?.engine,requestedLimit:100,effectiveLimit:query?.plan.limit,rows:query?.result.returnedRows,reasons:admitted.verdict.reasons,executionMessage:result.message}};
    });
    for(const mode of ['fresh','filter','or','metric','group','post-filter','order','limit','version','zero','truncated'] as const)await record(`query-scope-${mode}`,async()=>{
        const data=Array.from({length:mode==='truncated'?501:4},(_,i)=>({Town:`Town ${i}`,Amount:i+10,Date:mode==='zero'?'2026-09-01':'2026-10-03'}));
        const goal='List all totals by Town, October 2026 only.',s=await fixture(data,goal);
        const plan:QueryPlan={groupBy:['Town'],aggregates:[{function:'sum',column:'Amount',as:'Total'}],where:filter,limit:500};
        const scope=resolveAnswerScope(goal,{...artifact(),requestedComputationScope:undefined,taskSignal:'inspect_data',requestedQueryScopes:[{role:'result',plan}]} as never,undefined,s.store);
        await s.task.resolveScope(scope);s.root.setState({activeTurn:{userMessage:goal,steps:[],runId:s.lease.runId,turnId:s.lease.turnId} as never});s.context();
        const actual=structuredClone(plan);
        if(mode==='filter')actual.where=undefined;
        if(mode==='or')actual.where={groups:filter!.predicates!.map(p=>({predicates:[p]}))};
        if(mode==='metric')actual.aggregates![0].function='avg';
        if(mode==='group')actual.groupBy=['Date'];
        if(mode==='post-filter')actual.postAggregateFilter={predicates:[{column:'Total',operator:'gt',value:10}]};
        if(mode==='order')actual.orderBy=[{column:'Total',direction:'desc'}];
        if(mode==='limit')actual.limit=100;
        const result=await handleExecutorAction({type:'tool_call',toolName:'data.query',args:{explanation:'Typed scope challenge',plan:actual}},s.store,{abortSignal:signal});
        const q=result.artifacts?.activeDataQuery as import('../../../types').ActiveDataQuery|undefined,receipt=q?createQueryReceipt(s.store,q):null;
        if(q)ownedBinding={engine:q.engine,tableName:q.tableName,loadVersion:q.loadVersion,fallbackReason:null,fallbackStage:null};
        if(mode==='version')s.root.setState({currentDatasetId:'replacement'});
        const admitted=admitQueryEvidence(s.store,s.lease,scope,receipt?[receipt]:[]);
        const accepted=mode==='fresh'||mode==='zero';
        return {passed:admitted.verdict.status===(accepted?'accepted':'blocked')&&(mode!=='fresh'||q?.result.returnedRows===4)&&(mode!=='zero'||q?.result.returnedRows===0),
            status:admitted.verdict.status,details:{engine:q?.engine,rows:q?.result.returnedRows,truncated:q?.result.truncated,reasons:admitted.verdict.reasons,executionMessage:result.message}};
    });
    return {status:checks.every(c=>c.passed)?'passed':'failed',observations:checks};
};
