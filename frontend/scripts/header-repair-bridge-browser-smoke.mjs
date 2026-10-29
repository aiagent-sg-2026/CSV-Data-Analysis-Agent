import {chromium} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const output=path.resolve(process.env.BRIDGE_EVIDENCE_DIR??path.join(os.tmpdir(),'csv-header-bridge-evidence'));
await mkdir(output,{recursive:true});
const evidenceBase=pathToFileURL(output+path.sep);
import {writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const base=process.env.CSV_BASE_URL??'http://127.0.0.1:4199';
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname),'Synthetic qualification requires a local app; never point this harness at production.');const evidence={cases:[],externalBlocked:[],pageErrors:[],providerPatched:0};
let lastPage;
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:existsSync('/snap/chromium/current/usr/lib/chromium-browser/chrome')?{executablePath:'/snap/chromium/current/usr/lib/chromium-browser/chrome'}:{}),headless:true,args:['--no-sandbox']});
try{for(const scenario of (process.env.SCENARIOS??'success,successB,value,neither,cancel,stale').split(',')){
 const context=await browser.newContext({viewport:{width:1365,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==base){evidence.externalBlocked.push(url.origin);return route.abort();}
  if(url.pathname==='/services/agent/runtime/pi/piProvider.ts'){const response=await route.fetch();let body=await response.text();assert.ok(body.includes('const createPiProviderStream ='));body=body.replace('const createPiProviderStream =','const unusedRealProviderStream =');body+='\nexport const createPiProviderStream = () => (...args) => globalThis.__bridgeStream(...args);\n';evidence.providerPatched++;return route.fulfill({response,body});}return route.continue();});
 const page=await context.newPage();lastPage=page;page.on('pageerror',e=>evidence.pageErrors.push({scenario,error:e.message}));await page.goto(base);await page.getByText('Select a file',{exact:true}).first().waitFor();
 await page.evaluate(async scenario=>{const {useAppStore:s}=await import('/store/useAppStore.ts');const {prepareBridgeFixture}=await import('/tests/helpers/headerRepairBridgeFixture.ts');const f=await prepareBridgeFixture(s,scenario==='value'?'value':undefined,scenario==='successB'?'B':'A');window.__bridge=f;window.__bridgeStore=s;window.__bridgeStream=f.stream;window.__originalDataset=s.getState().datasetBundle;window.__originalCsv=s.getState().csvData;
 if(scenario==='cancel'||scenario==='stale'){const stream=f.stream;window.__bridgeStream=async(...args)=>{await new Promise(resolve=>{window.__releaseProvider=resolve});return stream(...args);};}
 s.setState({isReportBoundaryConfirmModalOpen:true,isAsideVisible:true});},scenario);
 const dialog=page.getByRole('dialog',{name:'Review structural interpretations'});await dialog.waitFor();await dialog.getByRole('button',{name:`Choose ${scenario==='successB'?'B':'A'} — confirm meaning`,exact:true}).click();
 await dialog.getByRole('button',{name:'Continue repair and validation',exact:true}).click();
 // Synthetic-only consent interaction: provider is locally stubbed and all external traffic blocked.
 await page.getByRole('button',{name:'Allow and continue',exact:true}).click();
 if(scenario==='cancel'||scenario==='stale'){
  await page.waitForFunction(()=>typeof window.__releaseProvider==='function');
  if(scenario==='cancel'){await page.getByRole('button',{name:'Inspect task',exact:true}).click();await page.getByRole('button',{name:'Stop task',exact:true}).click();}
  else await page.evaluate(async()=>{const{s}= {s:(await import('/store/useAppStore.ts')).useAppStore};s.setState({datasetBundle:structuredClone(s.getState().datasetBundle)});});
  await page.evaluate(()=>window.__releaseProvider());
  await page.waitForFunction(()=>{const s=window.__bridgeStore.getState();return !s.isBusy&&!s.activeExecution;});
 }else{
  await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'A — Confirm exact interpretation',exact:true}).waitFor();
  const before=await page.evaluate(async()=>{const s=(await import('/store/useAppStore.ts')).useAppStore.getState();return {accepted:s.datasetBundle?.acceptedCommit??null,programs:s.taskInspection?.programs?.length}});assert.equal(before.accepted,null);assert.equal(before.programs,0);
  const oldMeaningId=await page.evaluate(async()=>(await import('/store/useAppStore.ts')).useAppStore.getState().pendingClarification?.resumeContext?.piSpillMeaningChoice?.id);
  await page.getByRole('button',{name:scenario==='neither'?'Neither':'A — Confirm exact interpretation',exact:true}).last().click();
  await page.waitForFunction(id=>window.__bridgeStore.getState().pendingClarification?.resumeContext?.piSpillMeaningChoice?.id!==id,oldMeaningId);
  if(scenario.startsWith('success')){
   await page.getByRole('button',{name:'Approve',exact:true}).last().waitFor({timeout:60000});
   const draft=await page.evaluate(async()=>{const db=await (await import('/services/storageService.ts')).getStorageDatabase();const durableCommits=await db.count('dataset_commits');const s=(await import('/store/useAppStore.ts')).useAppStore.getState();return {durableCommits,accepted:s.datasetBundle?.acceptedCommit??null,validation:s.taskInspection?.candidate?.validation,tables:s.taskInspection?.candidate?.tables}});assert.equal(draft.accepted,null);assert.equal(draft.durableCommits,0);assert.equal(draft.validation.decision,'validated');
   await page.screenshot({path:new URL('validated-before-commit.png',evidenceBase).pathname,fullPage:true});
   await page.getByRole('button',{name:'Approve',exact:true}).last().click();
   await page.waitForFunction(()=>Boolean(window.__bridgeStore.getState().datasetBundle?.acceptedCommit),{},{timeout:60000});
   await page.waitForFunction(()=>window.__bridge.trace.includes('post_commit_analysis_requested'),{},{timeout:30000});
  }else await page.waitForFunction(()=>{const s=window.__bridgeStore.getState();return s.structureRepairReview?.status==='repair_failed'&&!s.isBusy&&!s.activeExecution;},{},{timeout:60000});
 }
 const result=await page.evaluate(async()=>{const db=await (await import('/services/storageService.ts')).getStorageDatabase();const durableCommits=await db.count('dataset_commits');const s=(await import('/store/useAppStore.ts')).useAppStore.getState();return {durableCommits,review:s.structureRepairReview?.status??null,accepted:s.datasetBundle?.acceptedCommit??null,tables:s.datasetBundle?.tables?.map(t=>({name:t.name,rows:t.rowCount})),pending:s.pendingClarification?.resumeContext??null,busy:s.isBusy,binding:s.datasetCommitBindingStatus,trace:window.__bridge.trace,progress:s.progressMessages.slice(-5),originalDataUnchanged:s.csvData===window.__originalCsv};});
 if(scenario.startsWith('success')){assert.ok(result.accepted);assert.equal(result.review,null);assert.equal(result.binding,'ready');assert.ok(result.durableCommits>0);}else {assert.equal(result.accepted,null);assert.equal(result.durableCommits,0);assert.equal(result.pending,null);assert.equal(result.review,'repair_failed');if(scenario==='value')assert.ok(result.trace.join('\n').includes('validation_unchanged_region_mismatch'));}
 if(!scenario.startsWith('success')){
  // A stopped task inspector can remain open; close it normally, never force through inert content.
  if(scenario==='cancel')await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Review structural interpretations',exact:true}).first().click();
  const retry=page.getByRole('dialog',{name:'Review structural interpretations'}).getByRole('button',{name:'Continue repair and validation',exact:true});
  await retry.waitFor();assert.equal(await retry.isEnabled(),true);await retry.focus();await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('dialog',{name:'Review structural interpretations'}).evaluate(el=>el.contains(document.activeElement)),true);
  assert.equal(await page.evaluate(()=>window.__bridge.trace.length),result.trace.length);
  result.retryVisible=true;result.focusWithinReview=true;result.reopenDidNotInvokeProvider=true;
 }
 evidence.cases.push({scenario,result});await page.screenshot({path:new URL(`${scenario}.png`,evidenceBase).pathname,fullPage:true});await context.close();await writeFile(new URL('evidence.json',evidenceBase),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({scenario,review:result.review,accepted:Boolean(result.accepted),pending:result.pending,traceCount:result.trace.length}));
}
assert.deepEqual(evidence.externalBlocked,[]);assert.deepEqual(evidence.pageErrors,[]);
}catch(error){if(lastPage){await lastPage.screenshot({path:new URL('failure.png',evidenceBase).pathname,fullPage:true}).catch(()=>{});await writeFile(new URL('failure.json',evidenceBase),JSON.stringify(await lastPage.evaluate(async()=>{const s=(await import('/store/useAppStore.ts')).useAppStore.getState();return {body:document.body.innerText,review:s.structureRepairReview,pending:s.pendingClarification,progress:s.progressMessages,trace:window.__bridge?.trace,errors:s.initialAnalysisFailureKind,active:s.activeExecution,task:s.activeAgentTask,taskInspection:s.taskInspection}}).catch(e=>({error:String(e)})),null,2));}throw error;}finally{await writeFile(new URL('evidence.json',evidenceBase),JSON.stringify(evidence,null,2));await browser.close();}
