import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readManifest} from '../../../scripts/site-manifest.mjs';
import {sha256} from './fixtureKit.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright-core');
const contentTypes={'.js':'text/javascript','.html':'text/html','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.svg':'image/svg+xml'};
const usage=(input,output)=>({input,output,cacheRead:0,cacheWrite:0,totalTokens:input+output,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});

/** Every browser context is private and all external requests are fulfilled/denied locally. */
export const createBrowserEvaluationAdapter=async({site,browserPath,entryPoint='follow_up'})=>{
  const allowlist=await readManifest(site),assets=await readdir(path.join(site,'assets'));
  const snapshot=new Map();
  for(const [file,digest]of allowlist){const bytes=await readFile(path.join(site,file));if(sha256(bytes)!==digest)throw new Error('evaluation_site_drift');snapshot.set(file,bytes);}
  const index=assets.find(n=>/^csv_data_analysis_index-.*\.js$/.test(n));
  const agent=assets.find(n=>/^csv_data_analysis_app-agent-.*\.js$/.test(n));
  if(!index||!agent)throw new Error('evaluation_bundle_missing');
  const code=snapshot.get('assets/'+agent)?.toString('utf8');
  if(!code)throw new Error('evaluation_bundle_missing');
  const alias=/piCandidateApprovalQualification as (\w+)/.exec(code)?.[1];
  if(!alias)throw new Error('evaluation_export_missing');
  const server=createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname,relative=pathname==='/'?'index.html':decodeURIComponent(pathname.slice(1));
      if(!allowlist.has(relative))return res.writeHead(404).end();
      const bytes=snapshot.get(relative);res.setHeader('Content-Type',contentTypes[path.extname(relative)]??'application/octet-stream');res.end(bytes);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try{browser=await chromium.launch({executablePath:browserPath,headless:true,args:['--disable-background-networking']});}
  catch{await new Promise(resolve=>server.close(resolve));throw new Error('evaluation_browser_unavailable');}
  const execute=async({files,signal,request,probe=false})=>{
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
    let deniedRequests=0,simulatedHttpRequests=0;
    const reserve=async(kind,body,produce)=>{
      if(signal?.aborted)throw new Error('evaluation_cancelled');
      const inputTokens=Buffer.byteLength(JSON.stringify(body));
      if(inputTokens>200000)throw new Error('evaluation_request_capacity');
      return request(kind,{inputTokens,outputTokens:32000,costMicrousd:0},async()=>{
        if(signal?.aborted)throw new Error('evaluation_cancelled');
        const value=await produce();return {value,usage:{inputTokens,outputTokens:Buffer.byteLength(JSON.stringify(value)),costMicrousd:0}};
      });
    };
    await context.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.origin===origin)return route.continue();
      if(url.origin==='https://gpt.yapweijun1996.com'&&['/demo/session','/demo/v1/responses'].includes(url.pathname)){
        try{
          simulatedHttpRequests++;
          const response=await reserve(url.pathname==='/demo/session'?'gateway_session':'http_provider',req.postData()??'',()=>({
            status:url.pathname==='/demo/session'?200:503,body:url.pathname==='/demo/session'
              ?{token:'dmo_synthetic_evaluation_only',model:'mock',expiresAt:new Date(Date.now()+3600000).toISOString()}
              :{error:{code:'EVALUATION_MOCK_ONLY',message:'Local mock does not resolve this helper.'}}}));
          return route.fulfill({status:response.status,contentType:'application/json',body:JSON.stringify(response.body)});
        }catch{return route.abort();}
      }
      deniedRequests++;return route.abort();
    });
    await page.exposeFunction('evaluationExchange',async body=>{
      const content=body.proposedContent??[{type:'toolCall',id:crypto.randomUUID(),name:'conversation_request_clarification',
        arguments:{question:'Local mock intentionally does not select a repair. Live model qualification remains pending.',options:[
          {label:'Keep the original input',value:'keep'},{label:'Use a separately authorized live model',value:'live'}]}}];
      const value=await reserve(probe?'initial_probe_pi':'pi_stream',body,()=>({content}));
      return {content:value.content,usage:usage(Buffer.byteLength(JSON.stringify(body)),Buffer.byteLength(JSON.stringify(value)))};
    });
    const abort=()=>{void page.evaluate(()=>globalThis.evaluationAbort?.abort()).catch(()=>{});};
    signal?.addEventListener('abort',abort,{once:true});
    try{
      await page.goto(origin);await page.waitForFunction(()=>document.body.innerText.includes('Select a file'));
      const result=await page.evaluate(async({index,agent,alias,files,entryPoint,probe,initiallyAborted})=>{
        const store=(await import('/assets/'+index)).u,module=(await import('/assets/'+agent))[alias];
        const controller=new AbortController();globalThis.evaluationAbort=controller;
        if(initiallyAborted)controller.abort();
        return probe?module.executeEvaluationInitialProbe(store,globalThis.evaluationExchange)
          :module.executeEvaluationCase(store,{files,entryPoint,exchange:globalThis.evaluationExchange,autoApproveSynthetic:true,signal:controller.signal});
      },{index,agent,alias,files,entryPoint,probe,initiallyAborted:signal?.aborted??false});
      return {...result,...(signal?.aborted?{status:'cancelled'}:{}),network:{deniedRequests,simulatedHttpRequests,externalProviderCalls:0},browserVersion:browser.version()};
    }finally{signal?.removeEventListener('abort',abort);await context.close();}
  };
  return {mode:'mock',deploymentPins:[...allowlist].map(([path,sha256])=>({path,sha256})),execute,probe:args=>execute({...args,probe:true}),async close(){await browser.close();await new Promise(resolve=>server.close(resolve));}};
};
