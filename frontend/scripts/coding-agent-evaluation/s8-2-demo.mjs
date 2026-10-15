import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readManifest} from '../../../scripts/site-manifest.mjs';
import {atomicWrite,json,sha256,assertFixtureRuntime} from './fixtureKit.mjs';
import {scoreAttempt} from './scoring.mjs';
import {createScopeRepairMock} from './scopeRepairMock.mjs';
import {frozenFaultPolicy} from './faultSchedule.mjs';

// Explicit live operator smoke only. The full frozen campaign CLI remains mock-only.
assertFixtureRuntime();
const args=process.argv.slice(2),mode=args[0],options=new Map();
if(!['--live-demo','--local-scope-mock'].includes(mode)||args.length%2!==1)throw new Error('Use --live-demo|--local-scope-mock --output <new-report.json> [--case S8-2|S8-4] [--expect-site-manifest <sha256>].');
for(let i=1;i<args.length;i+=2){if(!['--output','--case','--expect-site-manifest'].includes(args[i])||options.has(args[i]))throw new Error('smoke_options_invalid');options.set(args[i],args[i+1]);}
const localMock=mode==='--local-scope-mock',caseId=options.get('--case')??(localMock?'S8-4':'S8-2');
if(!options.get('--output')||!['S8-2','S8-4'].includes(caseId)||localMock&&caseId!=='S8-4')throw new Error('smoke_options_invalid');
const output=path.resolve(options.get('--output'));
if(await access(output).then(()=>true,()=>false))throw new Error('live_report_already_exists');
const repository=fileURLToPath(new URL('../../../',import.meta.url)),require=createRequire(import.meta.url),{chromium}=require('playwright-core');
const fixtureRoot=path.join(repository,'frontend/docs/coding-agent/evidence/fixtures-v1');
const fixtureManifest=JSON.parse(await readFile(path.join(fixtureRoot,'manifest.json'),'utf8'));
const item=fixtureManifest.cases.find(item=>item.id===caseId);
if(!item||fixtureManifest.syntheticOnly!==true)throw new Error('synthetic_fixture_missing');
for(const entry of [...item.agentFiles,...item.evaluatorFiles]){
    if(sha256(await readFile(path.join(fixtureRoot,entry.path)))!==entry.sha256)throw new Error('fixture_checksum_mismatch');
}
const files=await Promise.all(['task.json','input.csv'].map(async name=>({name,bytes:[...await readFile(path.join(fixtureRoot,`agent/${caseId}`,name))]})));
const oracle=JSON.parse(await readFile(path.join(fixtureRoot,`evaluator/${caseId}/oracle.json`),'utf8'));
const faultPolicy=frozenFaultPolicy(oracle.faultSchedule??[]);
const siteManifestSha256=sha256(await readFile(path.join(repository,'SHA256SUMS.txt')));
if(options.has('--expect-site-manifest')&&options.get('--expect-site-manifest')!==siteManifestSha256)throw new Error('expected_deployment_mismatch');
const mock=localMock?createScopeRepairMock(files):undefined;
const pins=await readManifest(repository),snapshot=new Map();
for(const [file,digest]of pins){const bytes=await readFile(path.join(repository,file));if(sha256(bytes)!==digest)throw new Error('site_checksum_mismatch');snapshot.set(file,bytes);}
const index=[...pins.keys()].find(p=>/^assets\/csv_data_analysis_index-.*\.js$/.test(p)),agent=[...pins.keys()].find(p=>/^assets\/csv_data_analysis_app-agent-.*\.js$/.test(p));
const alias=/piCandidateApprovalQualification as (\w+)/.exec(snapshot.get(agent)?.toString())?.[1];if(!alias||!index)throw new Error('qualification_export_missing');
const appOrigin='https://yapweijun1996.github.io',prefix='/CSV-Data-Analysis-Agent/',gateway='https://gpt.yapweijun1996.com';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),requests=[],responses=[],denied=[],consoleErrors=[],pageErrors=[],diagnostics=[];
let providerCalls=0,sessionCalls=0,result,executionError=null,consentAccepted=false;
const pending=[];const started=performance.now();
const contentTypes={'.js':'text/javascript','.html':'text/html','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.svg':'image/svg+xml'};
await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===appOrigin&&url.pathname.startsWith(prefix)){
        const file=decodeURIComponent(url.pathname.slice(prefix.length))||'index.html',bytes=snapshot.get(file);
        return bytes?route.fulfill({status:200,contentType:contentTypes[path.extname(file)]??'application/octet-stream',body:bytes}):route.fulfill({status:404,body:''});
    }
    if(url.origin===gateway&&['/demo/session','/demo/v1/responses'].includes(url.pathname)&&request.method()==='POST'){
        const body=request.postData()??'',session=url.pathname==='/demo/session';
        if((session?sessionCalls>=3:providerCalls>=40)||Buffer.byteLength(body)>600000){denied.push('live_smoke_budget');return route.abort();}
        let parsed;try{parsed=JSON.parse(body);}catch{denied.push('invalid_wire_json');return route.abort();}
        if(Object.hasOwn(parsed,'max_output_tokens')){denied.push('forbidden_max_output_tokens');return route.abort();}
        if(/scheduleSha256|evaluationFault/.test(body)){denied.push('fault_metadata_leak');return route.abort();}
        if(session)sessionCalls++;else providerCalls++;
        requests.push({kind:session?'session':'provider',bodySha256:sha256(body),bodyBytes:Buffer.byteLength(body),keys:Object.keys(parsed),model:parsed.model??null,
            faultMetadataPresent:/scheduleSha256|evaluationFault/.test(body),
            taskPlanPhases:(parsed.input??[]).filter(item=>item.type==='function_call_output').flatMap(item=>{
                try{const value=JSON.parse(item.output);return value.taskPlan?[{kind:value.taskPlan.kind,phase:value.taskPlan.phase,taskId:value.taskPlan.taskId,taskRevision:value.taskPlan.taskRevision}]:[];}catch{return [];}
            }),
            toolNames:(parsed.tools??[]).map(t=>t.name),maxOutputTokensPresent:false});
        return mock?route.fulfill(mock({url:request.url(),body})):route.continue();
    }
    denied.push(url.origin===gateway?'unreviewed_gateway_path':'external_request');return route.abort();
});
page.on('response',response=>{
    const url=new URL(response.url());if(url.origin!==gateway)return;
    pending.push((async()=>{
        const record={path:url.pathname,status:response.status(),model:null,usage:null};
        try{
            const text=await response.text();
            if(url.pathname==='/demo/session'){const body=JSON.parse(text);record.model=body.model??null;}
            else{
                const values=text.startsWith('data:')||text.includes('\ndata:')?text.split('\n').filter(line=>line.startsWith('data: ')).flatMap(line=>{try{return [JSON.parse(line.slice(6))];}catch{return [];}}):[JSON.parse(text)];
                const final=values.map(v=>v.response??v).findLast(v=>v.usage);record.model=final?.model??null;record.usage=final?.usage??null;
                record.outputText=final?.output?.flatMap(item=>(item.content??[]).filter(c=>c.type==='output_text').map(c=>c.text)).join('\n').slice(0,12000)??null;
                record.functionCalls=final?.output?.filter(item=>item.type==='function_call').map(item=>({name:item.name,arguments:item.arguments?.slice(0,12000)}))??[];
            }
        }catch{record.bodyUnavailable=true;}
        responses.push(record);
    })());
});
page.on('pageerror',error=>pageErrors.push(error.message.replace(/(?:dmo_|sk-|gw_)[\w.-]+/g,'[redacted]').slice(0,600)));
page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text().replace(/(?:dmo_|sk-|gw_)[\w.-]+/g,'[redacted]').slice(0,600));});
page.on('console',message=>{if(/\[(IntentClassifier|ChatOrchestrator|ProviderHealth)\]/.test(message.text()))diagnostics.push(message.text().replace(/(?:dmo_|sk-|gw_)[\w.-]+/g,'[redacted]').slice(0,1000));});
const timer=setTimeout(()=>{void context.close();},300000);
try{
    await page.goto(appOrigin+prefix);await page.waitForFunction(()=>document.body.innerText.includes('Select a file'));
    const consent=page.locator('#cloud-ai-consent-title').waitFor({state:'visible',timeout:10000}).then(async()=>{
        const dialog=page.getByRole('dialog',{name:await page.locator('#cloud-ai-consent-title').innerText()});
        await dialog.locator('footer button').last().click();consentAccepted=true;
    }).catch(()=>{});
    const execution=page.evaluate(async({index,agent,alias,files,faultPolicy})=>{
        const store=(await import('./'+index)).u,qualification=(await import('./'+agent))[alias];
        return qualification.runRepairComputationDemoProbe(store,files,faultPolicy);
    },{index,agent,alias,files,faultPolicy});
    result=await execution;await consent;
    await atomicWrite(output+'.png',await page.screenshot({fullPage:true}));
    await Promise.allSettled(pending);
}catch{executionError='live_smoke_execution_unavailable';}
finally{clearTimeout(timer);await context.close().catch(()=>{});await browser.close();}
const manifest=result?.exported?.['manifest.json'],evidence=result?.exported?.['evidence/computation-0.json'];
const score=result?scoreAttempt(item,oracle,result):null;
const approval=result?.approvals?.[0];
const computationExecution=manifest?.executions?.find(e=>e.jobId===manifest.evidence?.computations?.[0]?.executionId);
const passed=consentAccepted&&score?.correct===true&&score.critical.length===0&&result?.approvedCount===1
    &&result.task?.scope?.answer?.dataPreparation==='canonical_fact_table'
    &&result.runtime?.at(-1)?.taskOutputs?.acceptedOutputs?.some(output=>output.kind==='dataset'&&output.references.includes(approval?.commit?.commitId))
    &&approval?.leaseReleased===true&&approval.oldRunId!==approval.freshRunId&&approval.taskId===approval.taskIdAfter
    &&approval.versionAfter!==approval.versionBefore&&approval.commit?.commitId===manifest?.acceptedDataset?.reference?.commitId
    &&manifest?.acceptedDataset?.validation?.receiptDigest===approval.review?.validationDigest
    &&manifest?.acceptedDataset?.program?.sha256===approval.review?.programDigest
    &&approval.commitProof?.approval?.reviewDigest===approval.review?.reviewDigest&&approval.commitProof?.candidateId===approval.review?.candidateId
    &&approval.commitProof?.audit?.runId===approval.freshRunId&&approval.commitProof.approval.consumedAt>=approval.commitProof.approval.approvedAt
    &&JSON.stringify(computationExecution?.inputBindings)===JSON.stringify(approval.commitProof.outputBindings)
    &&result.task?.budget?.limits?.transformationAttempts===3&&result.task.budget.used.transformationAttempts<=3
    &&result.task.budget.limits.toolCalls===40&&result.task.budget.limits.providerTurns===32
    &&pageErrors.length===0&&!requests.some(r=>r.faultMetadataPresent)
    &&requests.some(r=>r.kind==='provider')&&responses.some(r=>r.path==='/demo/v1/responses'&&r.status===200)&&denied.every(reason=>reason==='external_request');
const report={schemaVersion:1,mode:`${localMock?'local_scope_mock':'live_demo'}_${caseId.toLowerCase().replace('-','_')}`,caseId,siteManifestSha256,status:passed?'passed':'failed',isolatedContext:true,localGeneratedBytesOnRegisteredOrigin:true,
    browser:browser.version(),elapsedMs:Math.round(performance.now()-started),limits:{providerCalls:40,sessionCalls:3,requestBytes:600000,elapsedMs:300000},
    score,fixtureManifestSha256:sha256(await readFile(path.join(fixtureRoot,'manifest.json'))),agentFiles:files.map(f=>({name:f.name,sha256:sha256(Buffer.from(f.bytes))})),providerCalls:localMock?0:providerCalls,protocolProviderCalls:providerCalls,sessionCalls,requests,responses,denied,consoleErrors,pageErrors,diagnostics,executionError,consentAccepted,result,
    providerSpendUsd:localMock?0:null,billingVerified:false,syntheticResponses:localMock,modelAutonomyAccepted:!localMock&&passed,fullFrozenQualification:false,scriptSha256:sha256(await readFile(fileURLToPath(import.meta.url))),
    deployment:[...pins].map(([path,sha256])=>({path,sha256}))};
await atomicWrite(output,json(report));
process.stdout.write(json({status:report.status,providerCalls:report.providerCalls,protocolProviderCalls:providerCalls,sessionCalls,elapsedMs:report.elapsedMs,executionError,taskStatus:result?.status??null}));process.exitCode=passed?0:2;
