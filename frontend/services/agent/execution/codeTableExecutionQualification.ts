import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { CsvRow } from '../../../types';
import type { StoreApi } from '../types';
import type { CodeExecutionReceipt, CodeRunRequest } from './codeExecutionContract';
import { createSingleTableDatasetBundle, inferDatasetTableSchema } from '../../data/datasetBundle';
import { registerSandboxTableRows, clearSandboxTableRows } from '../../data/sandboxTableRegistry';
import { hasSavableSession } from '../../persistence/persistedAppState';
import { beginRun, scopeRunStore, cancelOwnedRun, beginSessionTransition, finishRun } from '../../session/sessionOwnership';
import { preparePiTask } from '../runtime/pi/piCodingTask';
import { runPiFollowUpTurn } from '../runtime/pi/piFollowUpRuntimeService';
import { createJavaScriptGuest } from '../../sandbox/javascriptGuestClient';
import { handleExecutorAction } from './executorAgent';

export interface CodeTableCheck {id:string;passed:boolean;elapsedMs:number;details?:Record<string,unknown>}
type Guest = NonNullable<Parameters<typeof preparePiTask>[3]>;
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const artifactRef=({path,revision,sha256}:{path:string;revision:number;sha256:string})=>({path,revision,sha256});

export const createCodeTableQualificationFixture = async (signal: AbortSignal, rows: CsvRow[], dimensions?: CsvRow[],
    guestFactory: (store: StoreApi) => Guest = createJavaScriptGuest, recoveryBudget?: import('../runtime/pi/piTaskBudget').TaskBudget) => {
        const fileName=`synthetic-complete-${crypto.randomUUID()}.csv`, data={fileName,data:rows};
        const bundle=createSingleTableDatasetBundle({datasetId:crypto.randomUUID(),sourceFingerprint:'synthetic',file:{name:fileName,size:0,lastModified:0},data});
        if(dimensions){bundle.tables.push({...bundle.tables[0],tableId:'dimensions',role:'dimension',name:'dimensions',rowCount:dimensions.length,schema:inferDatasetTableSchema(dimensions)});
            registerSandboxTableRows(bundle.bundleId,{tables:[{tableId:'dimensions',name:'dimensions',role:'dimension',rows:dimensions}],lineage:[],relationships:[]},bundle.datasetVersion);}
        // Empty intake rows prevent this fixture from ever writing CURRENT_SESSION_KEY.
        // The complete canonical table is private to these synthetic Store actions.
        let state={sessionId:`complete-lab-${crypto.randomUUID()}`,settings:{provider:'default',simpleModel:'mock',complexModel:'mock',language:'English',
            runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}},
            csvData:{fileName,data:[]},canonicalCsvData:data,rawCsvData:null,currentDatasetId:null,reportMemoryScope:null,
            datasetBundle:bundle,semanticDatasetVersion:bundle.datasetVersion,analysisCards:[],columnProfiles:[],chatHistory:[],dataQualityIssues:[],activeDataQuery:null,
            agentEvents:[],agentToolLogs:[],runtimeEvents:[],progressMessages:[],telemetryEvents:[],workspaceFiles:{},
            logAgentToolUsage(){},addProgress(){},clearActiveTurnCancellation(){},setStreamingMessage(){},
        } as unknown as ReturnType<StoreApi['getState']>;
        if(hasSavableSession(state))throw new Error('Fixture cannot persist');
        const root:StoreApi={getState:()=>state,setState:patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};}};
        const lease=beginRun(root,'follow_up',crypto.randomUUID(),crypto.randomUUID()),store=scopeRunStore(root,lease);
        const message='Write an inspectable JavaScript program and stage a complete-table artifact.';
        const guest=guestFactory(store);let started:(()=>void)|undefined;
        const task=await preparePiTask(store,message,undefined,{run:(code,json,opts)=>guest.run(code,json,{...opts,onStarted:()=>{opts.onStarted?.();started?.();}}),cancel:()=>guest.cancel(),dispose:()=>guest.dispose()},recoveryBudget);
        const abort=()=>cancelOwnedRun(root);signal.addEventListener('abort',abort,{once:true});
        const dispose=()=>{signal.removeEventListener('abort',abort);task.close('cancelled');beginSessionTransition(root);finishRun(root,lease);clearSandboxTableRows(bundle.bundleId);};
        if(signal.aborted)abort();
        const tables=[{name:'facts',tableId:bundle.primaryTableId},...(dimensions?[{name:'dims',tableId:'dimensions'}]:[])];
        const run=async(code:string,options:Partial<CodeRunRequest>={})=>{
            const workspace=store.codeExecution!.workspace,path='/workspace/program.js';
            const program=await workspace.write(path,code,workspace.revision(path));
            const request:CodeRunRequest={program:artifactRef(program),inputs:[],tables,output:{path:'/workspace/output.json',expectedRevision:workspace.revision('/workspace/output.json'),format:'json'},...options};
            const context={lease,toolCallId:crypto.randomUUID(),stepId:crypto.randomUUID()};store.executionContext=context;
            await task.beforeTool('code.run',request,context.toolCallId);
            const result=await handleExecutorAction({type:'tool_call',toolName:'code.run',args:request},store,{abortSignal:signal});
            const receipt=result.artifacts?.codeExecution as Readonly<CodeExecutionReceipt>;
            if(!lease.signal.aborted)task.afterTool('code.run',result,context);
            return receipt;
        };
        return{root,store,lease,task,run,tables,message,dispose,setStarted:(callback:()=>void)=>{started=callback;},
            output:()=>JSON.parse(store.codeExecution!.workspace.read('/workspace/output.json').content)};
    };

/** Public synthetic boundary checks. No application actions/setters or current-session writes are used. */
export const qualifyCodeTableExecution = async (signal:AbortSignal,onObservation?:(check:CodeTableCheck)=>void,
    guestFactory:(store:StoreApi)=>Guest=createJavaScriptGuest) => {
    const observations:CodeTableCheck[]=[];
    let cleanup=()=>{};
    const check=async(id:string,work:()=>Promise<{passed:boolean;details?:Record<string,unknown>}>)=>{
        const started=performance.now();
        if(signal.aborted)throw new Error('scope_revoked');
        try{const result=await work();const value={id,...result,elapsedMs:Math.round(performance.now()-started)};observations.push(value);if(!signal.aborted)onObservation?.(value);}
        finally{cleanup();cleanup=()=>{};}
    };
    const fixture=async(rows:CsvRow[],dimensions?:CsvRow[])=>{
        const result=await createCodeTableQualificationFixture(signal,rows,dimensions,guestFactory);
        cleanup=result.dispose;
        return result;
    };
    const stream=(partitionBy:string[]=[],batchRows=5000)=>({mode:'stateful_stream' as const,stream:{table:'facts',batchRows,partitionBy,initialState:null}});
    try{
        await check('pi-whole-table-error-repair',async()=>{
            const s=await fixture(Array.from({length:5003},(_,i)=>({id:i===5000?0:i,kind:i===5001?'subtotal':'fact',value:i===5002?-5:1})));
            let step=0,program:ReturnType<typeof artifactRef>,failure:CodeExecutionReceipt|undefined,success:CodeExecutionReceipt|undefined;
            const provider:StreamFn=(model,context)=>{
                const results=context.messages.filter(message=>message.role==='toolResult').map(message=>JSON.parse(message.content.filter(part=>part.type==='text').map(part=>part.text).join('')));
                const tool=(name:string,args:Record<string,unknown>):AssistantMessage['content']=>[{type:'toolCall',id:crypto.randomUUID(),name,arguments:args as JsonObject}];
                let content:AssistantMessage['content'];
                const index=step++;
                if(index===0)content=tool('workspace_write',{path:'/workspace/program.js',content:'throw new TypeError("missing field");',expectedRevision:0});
                else if(index===1||index===3){program=artifactRef(results.at(-1).payload.workspace.artifact);content=tool('code_run',{program,inputs:[],tables:s.tables,output:{path:'/workspace/output.json',expectedRevision:0,format:'json'}});}
                else if(index===2){failure=results.at(-1).receipt;content=tool('workspace_replace',{path:'/workspace/program.js',expectedRevision:1,oldText:'throw new TypeError("missing field");',
                    newText:`const ids=new Set();const rows=input.facts.rows.filter(r=>r.kind==='fact'&&!ids.has(r.id)&&ids.add(r.id));return {rows:rows.length,sum:rows.reduce((s,r)=>s+r.value,0),last:rows.at(-1).id};`});}
                else{success=results.at(-1).receipt;content=[{type:'text',text:'Staged artifact.'}];}
                const stopReason=content.some(part=>part.type==='toolCall')?'toolUse' as const:'stop' as const;
                const message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason,timestamp:Date.now()};
                const events=createAssistantMessageEventStream();events.push({type:'start',partial:message});events.push({type:'done',reason:stopReason,message});return events;
            };
            const result=await runPiFollowUpTurn({message:s.message},s.store,provider);
            const output=s.output();
            return{passed:result.status==='completed'&&failure?.error?.name==='TypeError'&&success?.status==='succeeded'
                &&JSON.stringify(output)==='{"rows":5001,"sum":4995,"last":5002}'&&!s.root.getState().isBusy
                &&s.task.snapshot.budget.used.transformationAttempts===2&&s.root.getState().canonicalCsvData!.data.length===5003,
                details:{status:result.status,output,failure,success,budget:s.task.snapshot.budget}};
        });
        await check('stateful-dedup-boundary',async()=>{
            const s=await fixture(Array.from({length:5003},(_,i)=>({id:i===5000?0:i,value:i===5002?-5:1})));
            const receipt=await s.run(`const state=input.stream.state||{seen:[],sum:0,count:0};for(const r of input.facts.rows)if(!state.seen.includes(r.id)){state.seen.push(r.id);state.sum+=r.value;state.count++;}return {state,rows:input.stream.phase==='finish'?[{count:state.count,sum:state.sum}]:[]};`,stream());
            const output=s.output();return{passed:receipt.status==='succeeded'&&JSON.stringify(output)==='[{"count":5002,"sum":4996}]'&&receipt.checkpoints?.length===3,details:{receipt,output}};
        });
        await check('stateful-partition-fill-subtotals',async()=>{
            const s=await fixture(Array.from({length:10004},(_,i)=>({p:i<5002?'A':'B',kind:i===5001||i===10003?'subtotal':'fact',label:i===0?'alpha':i===5002?'beta':'',v:i===5001?5001:i===10003?10002:i<5002?1:2})));
            const receipt=await s.run(`const state=input.stream.state||{label:'',sum:0,count:0};for(const r of input.facts.rows){if(r.kind==='subtotal'){if(state.sum!==r.v)throw new Error('subtotal mismatch');continue;}if(r.label)state.label=r.label;state.sum+=r.v;state.count++;}return {state,rows:input.stream.phase==='finish'?[state]:[]};`,stream(['p']));
            const output=s.output();return{passed:receipt.status==='succeeded'&&JSON.stringify(output)==='[{"label":"alpha","sum":5001,"count":5001},{"label":"beta","sum":10002,"count":5001}]',details:{receipt,output}};
        });
        await check('whole-table-join-reshape-grain',async()=>{
            const s=await fixture(Array.from({length:5003},(_,i)=>({id:i,k:i%2?'B':'A',a:i===5002?-5:1,b:2})),[{k:'A',name:'Alpha'},{k:'B',name:'Beta'}]);
            const receipt=await s.run(`const names=new Map(input.dims.rows.map(r=>[r.k,r.name]));const sums={Alpha:0,Beta:0};const out=input.facts.rows.flatMap(r=>[{id:r.id,group:names.get(r.k),v:r.a},{id:r.id,group:names.get(r.k),v:r.b}]).sort((a,b)=>b.id-a.id);for(const r of out)sums[r.group]+=r.v;return {count:out.length,tail:out[0].id,sums};`);
            const output=s.output();return{passed:receipt.status==='succeeded'&&JSON.stringify(output)==='{"count":10006,"tail":5002,"sums":{"Alpha":7500,"Beta":7503}}'&&receipt.coverage?.length===2,details:{receipt,output}};
        });
        for(const mode of ['whole_table','stateful_stream'] as const)await check(`capacity-50000-${mode}`,async()=>{
            const s=await fixture(Array.from({length:50000},(_,i)=>({v:i===49999?-3:1})));
            const receipt=await s.run(mode==='whole_table'?`return {rows:input.facts.rows.length,total:input.facts.rows.reduce((s,r)=>s+r.v,0)};`:
                `const state=(input.stream.state||0)+input.facts.rows.reduce((s,r)=>s+r.v,0);return {state,rows:input.stream.phase==='finish'?[{rows:input.stream.endRow,total:state}]:[]};`,mode==='whole_table'?{}:stream());
            const output=s.output();return{passed:receipt.status==='succeeded'&&JSON.stringify(mode==='whole_table'?output:output[0])==='{"rows":50000,"total":49996}'
                &&receipt.coverage?.[0].complete===true,details:{receipt,output}};
        });
        for (const mode of ['whole_table', 'stateful_stream'] as const) await check(`capacity-256-columns-${mode}`, async () => {
            const columns = Array.from({ length: 256 }, (_, index) => `c${index}`);
            const rows = Array.from({ length: 128 }, () => Object.fromEntries(columns.map(column => [column, 'x'.repeat(240)])));
            const s = await fixture(rows);
            const receipt = await s.run(mode === 'whole_table'
                ? 'return {rows:input.facts.rows.length,columns:input.facts.columns.length,characters:input.facts.rows.reduce((sum,row)=>sum+Object.values(row).reduce((n,value)=>n+value.length,0),0)};'
                : 'const state=(input.stream.state||0)+input.facts.rows.reduce((sum,row)=>sum+Object.values(row).reduce((n,value)=>n+value.length,0),0);return {state,rows:input.stream.phase===\'finish\'?[{rows:input.stream.endRow,columns:input.facts.columns.length,characters:state}]:[]};',
                mode === 'whole_table' ? {} : stream([], 64));
            const output = s.output();
            return { passed: receipt.status === 'succeeded'
                && JSON.stringify(mode === 'whole_table' ? output : output[0]) === '{"rows":128,"columns":256,"characters":7864320}',
                details: { receipt, output, serializedRowsBytes: new TextEncoder().encode(JSON.stringify(rows)).length } };
        });
        await check('unsupported-row-map-refused',async()=>{const s=await fixture([{v:1}]);const receipt=await s.run('return 999;',{mode:'row_map'});return{passed:receipt.status==='blocked'&&receipt.reasonCode==='execution_mode_unavailable'&&!receipt.output,details:{receipt}};});
        await check('partition-repeat-refused',async()=>{const s=await fixture([{p:'A'},{p:'B'},{p:'A'}]);const receipt=await s.run('return {state:null,rows:[]};',stream(['p']));return{passed:receipt.status==='blocked'&&receipt.reasonCode==='partition_not_contiguous'&&!receipt.output&&!receipt.workerGeneration,details:{receipt}};});
        await check('state-capacity-refused',async()=>{const s=await fixture([{v:1}]);const receipt=await s.run('return {state:"x".repeat(65537),rows:[]};',stream());return{passed:receipt.status==='blocked'&&receipt.reasonCode==='resource_limit'&&!receipt.output,details:{receipt}};});
        await check('tail-failure-no-partial-output',async()=>{const s=await fixture(Array.from({length:5001},(_,i)=>({id:i})));const receipt=await s.run('if(input.facts.rows.some(r=>r.id===5000))throw new Error("tail fault");return {state:null,rows:input.facts.rows};',stream());return{passed:receipt.status==='failed'&&receipt.checkpoints?.length===1&&!receipt.output&&s.store.codeExecution!.workspace.revision('/workspace/output.json')===0,details:{receipt}};});
        await check('owned-stop',async()=>{const s=await fixture([{v:1}]);let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});s.setStarted(enter);const pending=s.run('while(true){}',stream());
            await Promise.race([entered,pending.then(()=>{throw new Error('Guest did not enter');})]);const started=performance.now();cancelOwnedRun(s.root);const receipt=await pending;
            return{passed:receipt.status==='cancelled'&&!receipt.output&&performance.now()-started<1000,details:{receipt,stopMs:Math.round(performance.now()-started)}};});
        await check('post-stop-recovery',async()=>{const s=await fixture([{v:2},{v:3}]);const receipt=await s.run('return input.facts.rows.reduce((s,r)=>s+r.v,0);');return{passed:receipt.status==='succeeded'&&s.output()===5,details:{receipt}};});
        return{passed:!signal.aborted&&observations.length===14&&observations.every(check=>check.passed),observations};
    }finally{cleanup();}
};
