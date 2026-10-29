import {chromium} from '@playwright/test';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.CSV_BASE_URL||'http://127.0.0.1:4205';assert.equal(new URL(base).hostname,'127.0.0.1');
const out=process.env.EVIDENCE_DIR||'/tmp/csv-initial-no-progress';await mkdir(out,{recursive:true});
const assets=await readdir(new URL('../dist/assets/',import.meta.url));const agent=assets.find(n=>/^csv_data_analysis_app-agent-.*\.js$/.test(n)),index=assets.find(n=>/^csv_data_analysis_index-.*\.js$/.test(n));
const alias=/piCandidateApprovalQualification as (\w+)/.exec(await readFile(new URL(`../dist/assets/${agent}`,import.meta.url),'utf8'))?.[1];assert.ok(alias&&index);
const evidence={errors:[],external:[],cases:[]};const browser=await chromium.launch({executablePath:'/snap/chromium/current/usr/lib/chromium-browser/chrome',headless:true,args:['--no-sandbox']});
try{for(const mode of ['repeat_missing_confirmation','source_ranges']){
 const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',r=>{if(new URL(r.request().url()).origin!==base){evidence.external.push(r.request().url());return r.abort();}return r.continue();});
 const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push(e.message));await page.goto(base);await page.getByText('Select a file',{exact:true}).first().waitFor();await page.locator('#app-loading-screen').waitFor({state:'hidden'});
 const result=await page.evaluate(async({index,agent,alias,mode})=>{
  const root=(await import(`/assets/${index}`)).u,qa=(await import(`/assets/${agent}`))[alias];root.setState({ensureDatasetSemanticSnapshot:async()=>null});let calls=0;
  const f=await qa.preparePiDualGrainSmoke(root,{inspectionQualification:mode,beforeProvider:async()=>{calls++;}});const finishedCalls=calls;await new Promise(r=>setTimeout(r,100));
  const s=root.getState();const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('csv-ai-assistant-db');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const get=(name,method)=>new Promise((resolve,reject)=>{const r=db.transaction(name).objectStore(name)[method]();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const durableCommits=await get('dataset_commits','count'),settings=await get('settings','getAll');db.close();
  const budget=settings.find(x=>x.coordinatorBudget)?.coordinatorBudget;
  return{mode,calls,finishedCalls,status:f.result.status,error:f.result.error,repair:f.result.structureRepair,accepted:s.datasetBundle?.acceptedCommit??null,pendingMeaning:Boolean(s.pendingClarification?.resumeContext?.piSpillMeaningChoice),durableCommits,budget:budget?.accounts.map(a=>({pending:a.pending,used:a.floor.task.used,taskFailure:a.floor.taskFailure})),trace:f.trace.map(t=>t.slice(0,100))};
 },{index,agent,alias,mode});evidence.cases.push(result);assert.equal(result.calls,result.finishedCalls);assert.equal(result.accepted,null);assert.equal(result.durableCommits,0);assert.ok(result.budget?.length);assert.equal(result.budget[0].pending,null);
 if(mode==='repeat_missing_confirmation'){assert.equal(result.calls,2);assert.equal(result.status,'blocked');assert.equal(result.error?.retryable,false);assert.equal(result.error?.message,'tool_no_progress');assert.equal(result.repair?.reason,'tool_no_progress');assert.equal(result.pendingMeaning,false);assert.equal(result.budget[0].used.providerTurns,2);}else{assert.ok(result.calls>3);assert.equal(result.pendingMeaning,true);}
 await page.screenshot({path:`${out}/${mode}.png`,fullPage:true});await context.close();
}assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.external,[]);
}finally{await writeFile(`${out}/evidence.json`,JSON.stringify(evidence,null,2));await browser.close();}
