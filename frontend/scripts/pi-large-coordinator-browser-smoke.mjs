import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const base=process.argv[2]??'http://127.0.0.1:4195',output=process.argv[3]??'/tmp/pi-large-coordinator-browser.json';
assert.equal(new URL(base).hostname,'127.0.0.1');
const profile=await mkdtemp('/tmp/pi-large-coordinator-'),assets=await readdir(new URL('../dist/assets/',import.meta.url));
const agent=assets.find(n=>/^csv_data_analysis_app-agent-.*\.js$/.test(n)),index=assets.find(n=>/^csv_data_analysis_index-.*\.js$/.test(n));
const alias=/piCandidateApprovalQualification as (\w+)/.exec(await readFile(new URL(`../dist/assets/${agent}`,import.meta.url),'utf8'))?.[1];assert.ok(alias&&index);
const sw=await readFile(new URL('../dist/service-worker.js',import.meta.url),'utf8');
const evidence={build:/const BUILD_VERSION = '([^']+)'/.exec(sw)?.[1],pageErrors:[],externalAttempts:[],workers:0,scenarios:[],
    method:'Deterministic provider, normal runPiInitialAnalysis/public meaning/code/stage/validate tools, real File/QuickJS/OPFS/React exact review/approval/DuckDB/reload. Not live AI qualification.',
    memoryMethod:'CDP renderer Runtime.getHeapUsage every 200ms, excludes workers/WASM/Blob/OPFS/RSS; sampled high-water, not total peak.'};
let context;
try{
    context=await chromium.launchPersistentContext(profile,{executablePath:'/snap/chromium/current/usr/lib/chromium-browser/chrome',headless:true,
        args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'],viewport:{width:1440,height:1000},serviceWorkers:'block'});
    evidence.browser=context.browser()?.version();
    await context.route('**/*',r=>{if(new URL(r.request().url()).origin===new URL(base).origin)return r.continue();evidence.externalAttempts.push(r.request().url());return r.abort();});
    for(const mode of ['semantic-A','semantic-B','neither','retry','deny','approve']){
        const semantic=mode.startsWith('semantic')||mode==='neither',rows=mode==='approve'?27000:2100,columns=['key','payload',semantic?'value':'value [count]'];
        const fixture=`${profile}/${mode}.csv`;
        await writeFile(fixture,columns.join(',')+'\r\n'+Array.from({length:rows},(_,i)=>`${i},"${'x'.repeat(1000)}${i===rows-1?'α\r\n末尾':''}",${i%2?'-1':'0'}${i===rows-1?',,':''}\r\n`).join(''));
        const page=await context.newPage(),cdp=await context.newCDPSession(page);page.on('pageerror',e=>evidence.pageErrors.push(e.message));page.on('worker',()=>evidence.workers++);
        await cdp.send('Storage.clearDataForOrigin',{origin:new URL(base).origin,storageTypes:'all'});await page.goto(base);await page.getByText('Select a file',{exact:true}).waitFor();
        await page.evaluate(async({index})=>{globalThis.qaRoot=(await import(`/assets/${index}`)).u;},{index});await page.waitForFunction(()=>!globalThis.qaRoot.getState().isAppInitializing);
        await page.evaluate(()=>{const i=document.createElement('input');i.id='coordinator-file';i.type='file';document.body.append(i);});await page.locator('#coordinator-file').setInputFiles(fixture);
        let heap=0,samples=0;const timer=setInterval(()=>cdp.send('Runtime.getHeapUsage').then(v=>{heap=Math.max(heap,v.usedSize);samples++;}).catch(()=>{}),200),started=Date.now();
        try{
            const initial=await page.evaluate(async({agent,alias,columns,mode})=>{
                const root=globalThis.qaRoot,qa=(await import(`/assets/${agent}`))[alias];root.setState({ensureDatasetSemanticSnapshot:async()=>null});
                const f=await qa.preparePiLargeCoordinatorSmoke(root,document.querySelector('#coordinator-file').files[0],{columns,numeric:true,mode:mode==='retry'?'retry':'repair'});
                globalThis.coordinatorQa={qa,root,f};return {result:f.result,reads:{...f.reads},bytes:f.source.byteSize,pending:root.getState().pendingClarification,accepted:root.getState().datasetBundle.acceptedCommit??null};
            },{agent,alias,columns,mode});
            console.log('INITIAL',mode,JSON.stringify(initial));assert.equal(initial.accepted,null);assert.equal(initial.reads.fullReads,0);
            const show=page.getByRole('button',{name:'Show Assistant panel',exact:true});if(await show.isVisible())await show.click();
            if(semantic){
                assert.ok(initial.pending.resumeContext.piSpillMeaningChoice);assert.equal(initial.pending.interactionKind,'clarification');
                const name=mode==='semantic-A'?'A — Confirm exact interpretation':mode==='semantic-B'?'B — Preserve raw text':'Neither';
                await page.getByRole('button',{name,exact:true}).click();
                await page.waitForFunction(()=>!globalThis.qaRoot.getState().isBusy&&!globalThis.qaRoot.getState().activeExecution,undefined,{timeout:180000});
                const after=await page.evaluate(()=>{const s=globalThis.qaRoot.getState();return {pending:s.pendingClarification,accepted:s.datasetBundle.acceptedCommit??null,task:s.activeAgentTask,inspection:s.taskInspection,progress:s.progressMessages.slice(-5),taskView:s.agentTaskStatus,checkpoints:Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.includes('initial'))),chat:s.chatHistory.slice(-3),trace:globalThis.coordinatorQa.f.trace};});
                assert.equal(after.accepted,null);
                if(mode==='neither'){assert.equal(after.pending,null);evidence.scenarios.push({mode,initial,after,elapsedMs:Date.now()-started});continue;}
                assert.ok(after.pending?.resumeContext?.piCandidateApproval,JSON.stringify(after));
                assert.ok(after.task.budget.used.toolCalls>3);
            }
            await page.getByRole('button',{name:'Inspect task',exact:true}).click();const review=page.getByRole('dialog',{name:'Task inspection',exact:true});
            await review.getByRole('button',{name:'Review',exact:true}).click();await review.getByText('Decision: validated',{exact:true}).waitFor();
            await review.getByRole('button',{name:'Read draft from start',exact:true}).click();await review.getByLabel('Draft rows',{exact:true}).waitFor();
            await page.screenshot({path:output+`.${mode}-review.png`});
            const precommit=await page.evaluate(()=>({accepted:globalThis.qaRoot.getState().datasetBundle.acceptedCommit??null,query:globalThis.qaRoot.getState().activeDataQuery??null,cards:globalThis.qaRoot.getState().analysisCards.length}));
            assert.deepEqual(precommit,{accepted:null,query:null,cards:0});
            if(mode!=='approve'){
                await review.getByRole('button',{name:'Deny',exact:true}).click();await page.waitForFunction(()=>!globalThis.qaRoot.getState().isBusy&&!globalThis.qaRoot.getState().activeExecution);
                assert.equal(await page.evaluate(()=>globalThis.qaRoot.getState().datasetBundle.acceptedCommit??null),null);
                evidence.scenarios.push({mode,initial,precommit,elapsedMs:Date.now()-started,sampledRendererHeapHighWater:heap,samples});continue;
            }
            await review.getByRole('button',{name:'Approve',exact:true}).click();await page.waitForFunction(()=>!globalThis.qaRoot.getState().isBusy&&!globalThis.qaRoot.getState().activeExecution&&globalThis.qaRoot.getState().datasetCommitBindingStatus==='ready',undefined,{timeout:180000});
            const queries=async()=>page.evaluate(async({agent,alias,columns})=>{
                const root=globalThis.qaRoot,qa=(await import(`/assets/${agent}`))[alias],s=root.getState(),v=columns[2];
                const plans=[{aggregates:[{function:'count',as:'n'}]},{aggregates:[{function:'sum',column:v,as:'n'}]},
                    {aggregates:[{function:'min',column:v,as:'n'}]},{aggregates:[{function:'max',column:v,as:'n'}]},
                    {aggregates:[{function:'avg',column:v,as:'n'}]},{aggregates:[{function:'count_distinct',column:'key',as:'n'}]},
                    {where:{predicates:[{column:v,operator:'eq',value:-1}]},aggregates:[{function:'count',as:'n'}]},
                    {where:{predicates:[{column:'key',operator:'eq',value:'26999'}]},select:['key','payload',v],limit:1},
                    {where:{predicates:[{column:'key',operator:'eq',value:'0'}]},select:['key',v],limit:1},
                    {groupBy:[v],aggregates:[{function:'count',as:'n'}],orderBy:[{column:v,direction:'asc'}]}];
                const result=[];for(const p of plans){const q=await qa.executeManagedDataQuery(s.csvData,p,columns,{allowNativeFallback:false,bypassCache:true});result.push({rows:q.result.rows,engine:q.engine,version:q.loadVersion,sql:q.sqlPreview,boundary:q.result.executionBoundary});}
                return {commit:s.datasetBundle.acceptedCommit,binding:s.datasetCommitBindingStatus,version:s.datasetBundle.datasetVersion,backing:s.csvData.backing,queries:result};
            },{agent,alias,columns});
            const check=q=>{assert.equal(q.queries.length,10);assert.ok(q.queries.every(r=>r.engine==='duckdb'&&r.version===q.version&&r.sql&&r.boundary));
                for(const [i,n]of [27000,-13500,-1,0,-0.5,27000,13500].entries())assert.equal(Number(q.queries[i].rows[0].n),n);
                assert.equal(q.queries[7].rows[0].payload,'x'.repeat(1000)+'α\r\n末尾');assert.equal(q.queries[8].rows[0].key,'0');assert.equal(q.queries[9].rows.length,2);};
            const committed=await queries();check(committed);
            const finalReads=await page.evaluate(()=>globalThis.coordinatorQa.f.reads);assert.equal(finalReads.fullReads,0);assert.ok(finalReads.maxBytes<=65536);assert.ok(finalReads.bytes<initial.bytes*6);assert.ok(initial.bytes>25*1024*1024);
            await page.reload();await page.evaluate(async({index})=>{globalThis.qaRoot=(await import(`/assets/${index}`)).u;},{index});await page.waitForFunction(()=>!globalThis.qaRoot.getState().isAppInitializing);
            if(!await page.getByRole('button',{name:'Restore local rows',exact:true}).count()){await page.getByRole('button',{name:'History',exact:true}).click();await page.getByRole('button',{name:'Resume analysis',exact:true}).first().click();}
            await page.getByRole('button',{name:'Restore local rows',exact:true}).waitFor({timeout:60000});await page.getByRole('button',{name:'Restore local rows',exact:true}).click();
            await page.waitForFunction(()=>{const s=globalThis.qaRoot.getState();return !s.isBusy&&!s.activeExecution&&!!s.csvData&&s.datasetCommitBindingStatus==='ready';},undefined,{timeout:180000});
            const restored=await queries();check(restored);assert.equal(restored.commit.commitId,committed.commit.commitId);
            evidence.scenarios.push({mode,initial,precommit,committed,restored,finalReads,elapsedMs:Date.now()-started,sampledRendererHeapHighWater:heap,samples});
        }finally{clearInterval(timer);await page.close();}
    }
    assert.deepEqual(evidence.pageErrors,[]);assert.deepEqual(evidence.externalAttempts,[]);
}finally{await writeFile(output,JSON.stringify(evidence,null,2));await context?.close();await rm(profile,{recursive:true,force:true});}
console.log(`PASS: normal large-source Pi coordinator, semantic choice, draft, exact UI commit, ten queries/reload: ${output}`);
