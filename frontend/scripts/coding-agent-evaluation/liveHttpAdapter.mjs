import {sha256} from './fixtureKit.mjs';

const validNumber=n=>Number.isSafeInteger(n)&&n>=0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const dimensions=['inputTokens','outputTokens','costMicrousd'];
const validBounds=v=>exact(v,dimensions)&&dimensions.every(k=>validNumber(v[k]));
const fail=()=>{throw new Error('evaluation_http_contract_invalid');};
const awaitTransport=(work,signal)=>new Promise((resolve,reject)=>{
  const abort=()=>reject(new Error('evaluation_cancelled'));
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  Promise.resolve(work).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
});
const cost=(tokens,rate)=>{
  const value=(BigInt(tokens)*BigInt(rate)+999999n)/1000000n;
  if(value>BigInt(Number.MAX_SAFE_INTEGER))fail();
  return Number(value);
};
const finalPayload=body=>{
  if(!body.includes('\ndata:')&&!body.startsWith('data:'))return JSON.parse(body);
  const events=body.split('\n').filter(line=>line.startsWith('data:')&&line.slice(5).trim()!=='[DONE]')
    .map(line=>JSON.parse(line.slice(5).trim()));
  const completed=events.filter(event=>event.type==='response.completed');
  if(completed.length!==1)fail();
  return completed[0].response;
};

/** Final serialized HTTP boundary. Dispatch has no default network implementation or credential lookup.
 * Only a host-supplied local mock transport is enabled until remote identity/bounds/authorization qualify. */
export const createLiveHttpAdapter=({transport,model,bounds,pricing,nonBillableStatuses=[]})=>{
  if(transport?.mode!=='local_mock'||typeof transport.send!=='function'||typeof model!=='string'||!model.length||model.length>160
    ||!exact(bounds,['session','provider','requestBytes','responseBytes'])||!validBounds(bounds.session)||!validBounds(bounds.provider)
    ||![bounds.requestBytes,bounds.responseBytes].every(n=>Number.isSafeInteger(n)&&n>0)
    ||!exact(pricing,['inputMicrousdPerMillion','outputMicrousdPerMillion'])||!Object.values(pricing).every(validNumber)
    ||!Array.isArray(nonBillableStatuses)||nonBillableStatuses.some(n=>![401,429].includes(n))
    ||new Set(nonBillableStatuses).size!==nonBillableStatuses.length)fail();
  const maximumCost=cost(bounds.provider.inputTokens,pricing.inputMicrousdPerMillion)+cost(bounds.provider.outputTokens,pricing.outputMicrousdPerMillion);
  if(!Number.isSafeInteger(maximumCost)||bounds.provider.costMicrousd<maximumCost)fail();
  const pin=structuredClone({model,bounds,pricing,nonBillableStatuses}),observations=[],send=transport.send.bind(transport);
  return {
    mode:'local_mock',
    get observations(){return structuredClone(observations);},
    async exchange(descriptor,reserve,signal){
      if(signal?.aborted)throw new Error('evaluation_cancelled');
      const url=new URL(descriptor.url);
      if(url.origin!=='https://gpt.yapweijun1996.com'||url.search||url.hash||url.username||url.password
        ||descriptor.method!=='POST'||!['/demo/session','/demo/v1/responses'].includes(url.pathname)
        ||typeof descriptor.body!=='string'||Buffer.byteLength(descriptor.body)>pin.bounds.requestBytes)fail();
      const session=url.pathname==='/demo/session',body=JSON.parse(descriptor.body);
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.hasOwn(body,'max_output_tokens')||(!session&&body.model!==pin.model))fail();
      const captured={url:descriptor.url,method:descriptor.method,headers:{...descriptor.headers},body:descriptor.body},requestSha256=sha256(captured.body);
      return reserve(`${session?'gateway_session':'http_provider'}/${requestSha256}`,pin.bounds[session?'session':'provider'],async()=>{
        if(signal?.aborted)throw new Error('evaluation_cancelled');
        const observation={attempt:observations.length+1,kind:session?'session':'provider',requestSha256,
          promptSha256:session?null:sha256(JSON.stringify({instructions:body.instructions??null,input:body.input??null})),
          toolSchemaSha256:session?null:sha256(JSON.stringify(body.tools??[])),
          requestBytes:Buffer.byteLength(captured.body),maxOutputTokensPresent:false,status:null,usage:null,usageStatus:'not_exposed'};
        observations.push(observation);
        // Raw headers and bodies remain in transient transport custody, never in the journal/observer.
        const deadline=AbortSignal.timeout(45000),ownedSignal=signal?AbortSignal.any([signal,deadline]):deadline;
        const response=await awaitTransport(send({...captured,signal:ownedSignal}),ownedSignal);
        observation.status=response?.status??null;
        if(signal?.aborted)throw new Error('evaluation_cancelled');
        if(!Number.isSafeInteger(response?.status)||response.status<200||response.status>599||typeof response.body!=='string'
          ||Buffer.byteLength(response.body)>pin.bounds.responseBytes)fail();
        let usage;
        if(session){
          const value=JSON.parse(response.body);
          if(![200,201].includes(response.status)||value.model!==pin.model||typeof value.token!=='string'||!value.token.length)fail();
          usage={inputTokens:0,outputTokens:0,costMicrousd:0};
        }else if(pin.nonBillableStatuses.includes(response.status)){
          usage={inputTokens:0,outputTokens:0,costMicrousd:0};
        }else{
          const payload=finalPayload(response.body),native=payload?.usage;
          if(payload?.model!==pin.model||payload.status!=='completed'||!native||!validNumber(native.input_tokens)
            ||!validNumber(native.output_tokens)||!validNumber(native.total_tokens)
            ||native.input_tokens+native.output_tokens!==native.total_tokens)fail();
          usage={inputTokens:native.input_tokens,outputTokens:native.output_tokens,
            costMicrousd:cost(native.input_tokens,pin.pricing.inputMicrousdPerMillion)+cost(native.output_tokens,pin.pricing.outputMicrousdPerMillion)};
        }
        observation.usage=usage;observation.usageStatus='observed';
        return {value:{status:response.status,body:response.body,contentType:response.contentType??'application/json'},usage};
      });
    },
  };
};

/** Transport observations remain independent of ledger counters. Missing/uncertain data cannot reconcile. */
export const reconcileHttpAccounting=(observations,ledger)=>{
  const totals={calls:0,inputTokens:0,outputTokens:0,costMicrousd:0};
  let usageComplete=Array.isArray(observations)&&observations.length>0;
  let matched=usageComplete&&Array.isArray(ledger?.requests)&&observations.length===ledger.requests.length;
  for(const [index,item]of (Array.isArray(observations)?observations:[]).entries()){
    const record=ledger?.requests?.[index],kind=item.kind==='session'?'gateway_session':item.kind==='provider'?'http_provider':null;
    const observed=item.attempt===index+1&&kind&&item.usageStatus==='observed'&&validBounds(item.usage);
    usageComplete=Boolean(usageComplete&&observed);
    const valid=observed&&record?.state==='settled'
      &&record.kind===`${kind}/${item.requestSha256}`&&record.usage?.calls===1&&dimensions.every(key=>record.usage[key]===item.usage[key]);
    matched=Boolean(matched&&valid);
    if(observed){totals.calls++;for(const key of dimensions)totals[key]+=item.usage[key];}
  }
  matched=Boolean(matched&&Object.entries(totals).every(([key,value])=>Number.isSafeInteger(value)&&ledger.used?.[key]===value&&ledger.allocated?.[key]===value));
  return {status:matched?'matched':'unmatched',physicalAttempts:observations?.length??0,usageComplete,knownTotals:totals};
};
