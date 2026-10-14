import {mkdir,open,readFile,unlink,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWrite,json,sha256,assertFixtureRuntime} from './fixtureKit.mjs';

const dimensions=['calls','inputTokens','outputTokens','costMicrousd'];
const zero=()=>Object.fromEntries(dimensions.map(k=>[k,0]));
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const counters=(v,minimum=0)=>exact(v,dimensions)&&dimensions.every(k=>Number.isSafeInteger(v[k])&&v[k]>=minimum);
const bounds=v=>exact(v,dimensions.slice(1))&&dimensions.slice(1).every(k=>Number.isSafeInteger(v[k])&&v[k]>=0);
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_./-]{1,240}$/.test(v)&&!v.split('/').includes('..');
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const copy=v=>structuredClone(v);
const fail=code=>{throw new Error(code);};
const validBinding=v=>exact(v,['qualificationSha256','pairId','mode','runIds'])&&hash(v.qualificationSha256)&&id(v.pairId)
  &&['mock','live'].includes(v.mode)&&Array.isArray(v.runIds)&&v.runIds.length>0&&v.runIds.length<=180
  &&v.runIds.every(id)&&new Set(v.runIds).size===v.runIds.length;

/** Host-owned campaign ledger. JSON cannot grant live transport; current CLI exposes mock mode only. */
const attach=async(directory,state,options={})=>{
  const lock=path.join(directory,'.owner'),owner=randomUUID();
  let handle;
  try{handle=await open(lock,'wx',0o600);await handle.writeFile(owner);await handle.sync();await handle.close();}
  catch{await handle?.close();fail('campaign_already_owned');}
  // Recovery was inspected before lock acquisition. Refuse a stale snapshot if another owner committed in that interval.
  try{
    if(options.expectedStateSha&&sha256(await readFile(path.join(directory,'campaign.json')))!==options.expectedStateSha)
      fail('campaign_changed_before_ownership');
  }catch(error){await unlink(lock);throw error;}
  let closed=false,queue=Promise.resolve(),current=state;
  const persist=options.persist??atomicWrite;
  const exclusive=work=>{
    const result=queue.then(()=>{if(closed)fail('campaign_closed');return work();});
    queue=result.catch(()=>{});return result;
  };
  const commit=async(next,type,data={})=>{
    const previous=current.events.at(-1)?.sha256??'0'.repeat(64);
    const event={sequence:current.events.length+1,type,data,previous,stateDigest:sha256(json({...next,events:[]}))};
    next.events=[...current.events,{...event,sha256:sha256(json(event))}];
    try{await persist(path.join(directory,'campaign.json'),json(next));}
    catch{current={...current,status:'storage_failed'};fail('campaign_persistence_failed');}
    current=next;
  };
  const active=runId=>{
    if(!['ready','running'].includes(current.status))fail(`campaign_${current.status}`);
    const run=current.runs.find(r=>r.id===runId);
    if(!run||run.status!=='running')fail('campaign_run_not_active');
    return run;
  };
  const api={
    directory,
    get snapshot(){return copy(current);},
    async startRun(runId){return exclusive(async()=>{
      if(!['ready','running'].includes(current.status))fail(`campaign_${current.status}`);
      const next=copy(current),run=next.runs.find(r=>r.id===runId);
      if(!run||run.status!=='pending'||next.runs.some(r=>r.status==='running'))fail('campaign_run_unavailable');
      run.status='running';run.attemptId=randomUUID();await commit({...next,status:'running'},'run_started',{runId,attemptId:run.attemptId});return copy(run);
    });},
    async request(runId,kind,reservation,send){
      if(!id(kind)||!bounds(reservation)||typeof send!=='function')fail('request_contract_invalid');
      const reservationId=randomUUID(),started=performance.now();
      await exclusive(async()=>{
        active(runId);const next=copy(current),charge={calls:1,...reservation};
        for(const key of dimensions){
          const total=next.allocated[key]+charge[key];
          if(!Number.isSafeInteger(total)||total>next.limits[key]){
            await commit({...next,status:'paused'},'budget_refused',{runId,kind,dimension:key});fail('campaign_budget_exhausted');
          }
          next.allocated[key]=total;
        }
        next.requests.push({id:reservationId,runId,kind,reservation:charge,state:'reserved'});
        await commit(next,'request_reserved',{reservationId,runId,kind,reservation:charge});
      });
      let reply;
      try{reply=await send();}
      catch{
        await exclusive(async()=>{const next=copy(current),request=next.requests.find(r=>r.id===reservationId);
          request.state='uncertain';request.elapsedMs=Math.round(performance.now()-started);
          await commit({...next,status:'uncertain'},'request_uncertain',{reservationId,runId});});
        fail('request_usage_uncertain');
      }
      await exclusive(async()=>{
        const next=copy(current),request=next.requests.find(r=>r.id===reservationId);
        // A response cannot turn cancellation or a storage failure into permission to proceed.
        if(!['running','paused'].includes(current.status)||!bounds(reply?.usage)
          ||dimensions.slice(1).some(k=>reply.usage[k]>reservation[k])){
          request.state='uncertain';await commit({...next,status:'uncertain'},'usage_rejected',{reservationId,runId});fail('request_usage_uncertain');
        }
        request.state='settled';request.usage={calls:1,...reply.usage};request.elapsedMs=Math.round(performance.now()-started);
        for(const key of dimensions){next.allocated[key]-=request.reservation[key]-request.usage[key];next.used[key]+=request.usage[key];}
        await commit(next,'request_settled',{reservationId,runId,usage:request.usage});
      });
      return reply.value;
    },
    async finishRun(runId,result){return exclusive(async()=>{
      const next=copy(current),run=next.runs.find(r=>r.id===runId);
      if(!run||run.status!=='running'||!result||!['completed','blocked','failed','cancelled'].includes(result.status))fail('campaign_result_invalid');
      if(next.requests.some(r=>r.runId===runId&&r.state==='reserved'))fail('campaign_request_inflight');
      const file=`attempt-${String(next.runs.indexOf(run)+1).padStart(3,'0')}.json`,bytes=json(result);
      if(Buffer.byteLength(bytes)>8*1024*1024)fail('campaign_result_capacity');
      await persist(path.join(directory,file),bytes);
      run.status=result.status;run.result={file,sha256:sha256(bytes)};
      const status=['ready','running'].includes(next.status)?(next.runs.every(r=>!['pending','running'].includes(r.status))?'finished':'ready'):next.status;
      await commit({...next,status},'run_finished',{runId,status:result.status,result:run.result});
    });},
    async stop(){return exclusive(async()=>{
      const next=copy(current);next.status=next.requests.some(r=>r.state==='reserved')?'uncertain':'stopped';
      await commit(next,'campaign_stopped');
    });},
    async close(){await queue;closed=true;if(await readFile(lock,'utf8')===owner)await unlink(lock);else fail('campaign_owner_changed');},
  };
  return api;
};

export const createCampaign=async(directory,binding,limits,options={})=>{
  assertFixtureRuntime();if(!validBinding(binding)||!counters(limits,1))fail('campaign_contract_invalid');
  await mkdir(directory,{mode:0o700});
  const state={schemaVersion:1,binding:copy(binding),limits:copy(limits),allocated:zero(),used:zero(),status:'ready',
    runs:binding.runIds.map(id=>({id,status:'pending'})),requests:[],events:[]};
  const api=await attach(directory,state,options);
  try{await (options.persist??atomicWrite)(path.join(directory,'campaign.json'),json(state));return api;}
  catch{await api.close();fail('campaign_persistence_failed');}
};

export const openCampaign=async(directory,expectedBinding,options={})=>{
  assertFixtureRuntime();if(!validBinding(expectedBinding))fail('campaign_contract_invalid');
  const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('campaign_directory_invalid');
  const target=path.join(directory,'campaign.json'),fileStat=await lstat(target);
  if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.size>64*1024*1024)fail('campaign_state_invalid');
  const serialized=await readFile(target,'utf8'),state=JSON.parse(serialized);
  if(state.schemaVersion!==1||JSON.stringify(state.binding)!==JSON.stringify(expectedBinding)||!counters(state.limits,1)
    ||!counters(state.allocated)||!counters(state.used)||!Array.isArray(state.events)||!Array.isArray(state.requests)
    ||!Array.isArray(state.runs)||JSON.stringify(state.runs.map(r=>r.id))!==JSON.stringify(expectedBinding.runIds))fail('campaign_state_invalid');
  let previous='0'.repeat(64);
  for(const [index,event]of state.events.entries()){
    const {sha256:given,...payload}=event;
    if(event.sequence!==index+1||event.previous!==previous||sha256(json(payload))!==given)fail('campaign_journal_invalid');previous=given;
  }
  if(state.events.length&&state.events.at(-1).stateDigest!==sha256(json({...state,events:[]})))fail('campaign_state_digest_mismatch');
  const allocated=zero(),used=zero();
  for(const request of state.requests){
    if(!counters(request.reservation)||!['reserved','settled','uncertain'].includes(request.state)||!expectedBinding.runIds.includes(request.runId))fail('campaign_state_invalid');
    const value=request.state==='settled'?request.usage:request.reservation;
    if(!counters(value)||dimensions.some(k=>value[k]>request.reservation[k]))fail('campaign_state_invalid');
    for(const k of dimensions){allocated[k]+=value[k];if(request.state==='settled')used[k]+=value[k];}
  }
  if(JSON.stringify(allocated)!==JSON.stringify(state.allocated)||JSON.stringify(used)!==JSON.stringify(state.used)
    ||dimensions.some(k=>state.allocated[k]>state.limits[k]))fail('campaign_accounting_invalid');
  for(const run of state.runs){
    if(!['pending','running','completed','blocked','failed','cancelled'].includes(run.status))fail('campaign_state_invalid');
    if(run.result){
      if(!/^attempt-\d{3}\.json$/.test(run.result.file)||!hash(run.result.sha256))fail('campaign_result_invalid');
      const resultPath=path.join(directory,run.result.file),resultStat=await lstat(resultPath);
      if(!resultStat.isFile()||resultStat.isSymbolicLink()||resultStat.size>8*1024*1024)fail('campaign_result_invalid');
      const payload=await readFile(resultPath);if(sha256(payload)!==run.result.sha256)fail('campaign_result_hash_mismatch');
    }
  }
  // Durable admission could have preceded a lost transport/result acknowledgement. Never infer permission to replay.
  if(state.runs.some(r=>r.status==='running')||state.requests.some(r=>r.state!=='settled'))state.status='uncertain';
  if(!['ready','finished','paused','uncertain','stopped','storage_failed'].includes(state.status))fail('campaign_state_invalid');
  return attach(directory,state,{...options,expectedStateSha:sha256(serialized)});
};
