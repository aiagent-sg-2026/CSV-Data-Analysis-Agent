import {readFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Papa from 'papaparse';
import {atomicWrite,json,sha256,assertFixtureRuntime} from './fixtureKit.mjs';
import {freezeQualification,captureFrozenAgentInputs} from './qualificationPreflight.mjs';
import {readFixtureArtifact} from './preflight.mjs';
import {createCampaign} from './campaign.mjs';
import {createBrowserEvaluationAdapter} from './browserAdapter.mjs';
import {createLiveHttpAdapter,reconcileHttpAccounting} from './liveHttpAdapter.mjs';
import {frozenFaultPolicy,hasFrozenFaultRecovery} from './faultSchedule.mjs';

// Explicit local protocol diagnostics only. No network transport or credentials are supplied.
assertFixtureRuntime();
if(process.argv.length!==4||process.argv[2]!=='--output')throw new Error('Use --output <new-report.json>.');
const root=fileURLToPath(new URL('../../../',import.meta.url)),target=path.resolve(process.argv[3]);
const suite=root+'/frontend/docs/coding-agent/evidence/fixtures-v1';
if(target===suite||target.startsWith(suite+path.sep))throw new Error('diagnostic_destination_invalid');
try{await lstat(target);throw new Error('diagnostic_target_exists');}catch(error){if(error.code!=='ENOENT')throw error;}
const manifest=await freezeQualification(root,suite),load=await captureFrozenAgentInputs(suite);
const runs=manifest.schedule.filter(run=>manifest.suite.failureRecovery.some(item=>item.caseId===run.caseId));
const sessions=new Map(),model='demo-auto',calls=[];
let currentAgentInput;
const textItem=text=>({type:'message',id:'msg_'+randomUUID().replaceAll('-',''),role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]} ]});
const toolItem=(name,args)=>({type:'function_call',id:'fc_'+randomUUID().replaceAll('-',''),call_id:'call_'+randomUUID().replaceAll('-',''),name,arguments:JSON.stringify(args),status:'completed'});
const classification={intent:'data_query',confidence:'high',taskSignal:'inspect_data',expectedOutput:'data_table',referencedColumns:[],aggregationFunctions:[],groupingColumns:[],
  filterDescription:null,requestedQueryScopes:[],requestedComputationScope:null,requestedDataPreparation:'canonical_fact_table',resultCompleteness:'bounded',subjectRefs:[],
  timeScope:{kind:'none'},comparisonScope:{kind:'none'},unresolvedReferences:[],reason:'Scripted local execution-boundary diagnostic; no analytical completion is claimed.'};
const wireReply=(body,item)=>{
  const response={id:'resp_'+randomUUID().replaceAll('-',''),object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model,output:[item],
    usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  if(!body.stream)return {status:200,body:JSON.stringify(response),contentType:'application/json'};
  const events=[{type:'response.created',response:{...response,output:[]}},
    {type:'response.output_item.added',output_index:0,item:item.type==='function_call'?{...item,arguments:'',status:'in_progress'}:{...item,content:[],status:'in_progress'}}];
  if(item.type==='function_call')events.push({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:item.arguments},
    {type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:item.arguments});
  else events.push({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text},
    {type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:item.content[0].text},
    {type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
  events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response});
  return {status:200,contentType:'text/event-stream',body:events.map((event,sequence_number)=>`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number})}\n\n`).join('')};
};
const http=createLiveHttpAdapter({model,transport:{mode:'local_mock',async send(request){
  const body=JSON.parse(request.body),session=new URL(request.url).pathname==='/demo/session';
  if(session){const token='dmo_local_'+randomUUID().replaceAll('-','');sessions.set(token,{step:0});return {status:200,body:JSON.stringify({token,model,expires_in:300})};}
  const auth=Object.entries(request.headers).find(([key])=>key.toLowerCase()==='authorization')?.[1]?.replace(/^Bearer /,'');
  const state=sessions.get(auth);if(!state)throw new Error('local_session_missing');
  const names=(body.tools??[]).map(tool=>tool.name),main=names.includes('workspace_write'),serialized=JSON.stringify(body);
  calls.push({kind:main?'pi':serialized.includes('query understanding engine')?'classifier':'helper',keys:Object.keys(body),tools:names,
    bodySha256:sha256(request.body),bodyBytes:Buffer.byteLength(request.body),maxOutputTokensPresent:Object.hasOwn(body,'max_output_tokens'),
    evaluatorMetadataPresent:serialized.includes('scheduleSha256')||serialized.includes('evaluationFault')||serialized.includes('injected_program_or_schema_failure')});
  if(!main)return wireReply(body,textItem(serialized.includes('query understanding engine')?JSON.stringify(classification):'OK'));
  const outputs=(body.input??[]).filter(item=>item.type==='function_call_output').flatMap(item=>{try{return [JSON.parse(item.output)];}catch{return [];}});
  const artifact=outputs.map(value=>value.payload?.workspace?.artifact).filter(Boolean).at(-1);
  const tableId=outputs.map(value=>value.taskPlan?.inputBindings?.[0]?.tableId).filter(Boolean).at(-1);
  const step=state.step++;
  if(step===0){
    // Only the declared raw agent CSV is inspected. This diagnostic declares identity rows and never stages or commits them.
    const rows=Papa.parse(currentAgentInput,{skipEmptyLines:true}).data,headers=rows[0];
    return wireReply(body,toolItem('candidate_infer_meaning',{input:{kind:'source',name:'original'},table:{name:'facts',grain:headers,groupBy:[],
      columns:headers.map((name,sourceColumn)=>({name,sourceColumn,dataType:'string',nullable:false,conversion:'identity'})),detailRanges:[{start:1,end:rows.length-1}]},
      exclusions:[{row:0,role:'header'}],assumptions:['Each raw input record is retained for this local execution-boundary diagnostic; no business repair or completed analysis is claimed.']}));
  }
  if(step===1)return wireReply(body,toolItem('workspace_write',{path:'/workspace/fault-probe.js',expectedRevision:0,content:'return {executionProbe:1,rowCount:input.facts.rows.length};'}));
  if(step===2||step===4){
    if(!artifact||!tableId)throw new Error('local_program_reference_missing');
    return wireReply(body,toolItem('code_run',{program:{path:artifact.path,revision:artifact.revision,sha256:artifact.sha256},inputs:[],mode:'whole_table',tables:[{name:'facts',tableId}],
      output:{path:'/workspace/fault-probe.json',expectedRevision:0,format:'json'}}));
  }
  if(step===3)return wireReply(body,toolItem('workspace_write',{path:'/workspace/fault-probe.js',expectedRevision:1,content:'return {executionProbe:2,rowCount:input.facts.rows.length};'}));
  return wireReply(body,toolItem('conversation_request_clarification',{question:'The local scripted diagnostic stops after testing execution recovery. No repaired dataset or analytical answer is claimed.',
    options:[{label:'Keep the original input',value:'keep'},{label:'Review diagnostic evidence',value:'review'}]}));
}},bounds:{session:{inputTokens:0,outputTokens:0,costMicrousd:0},provider:{inputTokens:200000,outputTokens:32000,costMicrousd:0},requestBytes:600000,responseBytes:1000000},
 pricing:{inputMicrousdPerMillion:0,outputMicrousdPerMillion:0}});
const limits={calls:1000,inputTokens:100000000,outputTokens:100000000,costMicrousd:1};
const campaign=await createCampaign(target+'.ledger',{qualificationSha256:sha256(json(manifest)),pairId:manifest.candidate.pairId,mode:'mock',runIds:runs.map(run=>run.id)},limits);
const results=[];
let failure=null,adapter;
try{
  adapter=await createBrowserEvaluationAdapter({site:root,browserPath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',candidate:manifest.candidate,httpAdapter:http});
  for(const run of runs){
    await campaign.startRun(run.id);
    const oracle=JSON.parse((await readFixtureArtifact(suite,`evaluator/${run.caseId}/oracle.json`)).toString());
    currentAgentInput=Buffer.from(load(run.caseId).find(file=>file.name==='input.csv').bytes).toString();
    const result=await adapter.execute({files:load(run.caseId).map(file=>({name:file.name,bytes:[...file.bytes]})),faultPolicy:frozenFaultPolicy(oracle.faultSchedule),
      request:(kind,bounds,send)=>campaign.request(run.id,kind,bounds,send)});
    const budget=result.task?.budget;
    const passed=hasFrozenFaultRecovery(oracle.faultSchedule,result.faultEvidence)&&result.rawOriginalPreserved===true&&result.approvedCount===0
      &&result.status!=='completed'&&result.browserErrors.page.length===0&&budget?.used?.transformationAttempts===2
      &&Object.entries(manifest.candidate.settings.taskLimits).every(([key,value])=>budget.limits[key]===value&&budget.used[key]<=value);
    const observation={runId:run.id,caseId:run.caseId,seed:run.seed,passed,modelAutonomyAccepted:false,result};
    await campaign.finishRun(run.id,{status:result.status==='completed'?'completed':'blocked',...observation});results.push(observation);
    if(!passed){failure='local_execution_recovery_failed';break;}
  }
}catch{failure='local_protocol_diagnostic_failed';}
finally{try{await adapter?.close();}finally{await campaign.close();}}
const accounting=reconcileHttpAccounting(http.observations,campaign.snapshot);
const passed=!failure&&results.length===9&&results.every(r=>r.passed)&&accounting.status==='matched'
  &&calls.every(call=>!call.maxOutputTokensPresent&&!call.evaluatorMetadataPresent);
const report={schemaVersion:1,mode:'live_protocol_local_mock',status:passed?'passed':'failed',failure,providerCalls:0,paidSpendUsd:0,liveRunAuthorized:false,
 fullFrozenQualification:false,qualityPassed:false,limits,qualificationSha256:sha256(json(manifest)),deployment:manifest.pins.deployment,
 plannedQualificationRuns:180,diagnosticFaultRuns:results.length,results,httpObservations:http.observations,wireCalls:calls,ledger:campaign.snapshot,accounting,
 scriptSha256:sha256(await readFile(fileURLToPath(import.meta.url)))};
await atomicWrite(target,json(report));process.stdout.write(json({status:report.status,diagnosticFaultRuns:results.length,failure,providerCalls:0,paidSpendUsd:0}));process.exitCode=passed?0:2;
