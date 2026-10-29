import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {stat,readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const current=path.resolve(process.env.CURRENT_SITE_ROOT||'..');
const previous=path.resolve(process.env.PREVIOUS_SITE_ROOT);
const out=path.resolve(process.env.STARTUP_EVIDENCE_DIR||'/tmp/csv-startup-upgrade');await mkdir(out,{recursive:true});
let root=previous;
const types={'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.wasm':'application/wasm'};
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep))throw Error('path');const info=await stat(file);if(!info.isFile())throw Error('file');res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});createReadStream(file).pipe(res);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(4202,'127.0.0.1',resolve));
const base='http://127.0.0.1:4202';const evidence={oldErrors:[],newErrors:[],external:[],checks:[]};
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/snap/chromium/current/usr/lib/chromium-browser/chrome',headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({serviceWorkers:'allow'});
 context.on('request',req=>{if(!req.url().startsWith(base)&&!req.url().startsWith('data:')&&!req.url().startsWith('blob:'))evidence.external.push(req.url());});
 const page=await context.newPage();let upgraded=false;page.on('pageerror',e=>(upgraded?evidence.newErrors:evidence.oldErrors).push(e.message));
 await page.goto(base);
 await page.waitForFunction(()=>document.body.innerText.includes('Starting application'));
 // Seed the exact old production worker on the synthetic local origin. The broken app
 // may crash before its own registration; no user storage or production site is touched.
 await page.evaluate(async()=>{await navigator.serviceWorker.register('/service-worker.js');await navigator.serviceWorker.ready;localStorage.setItem('startup-preservation-sentinel','keep');});
 await page.reload();await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
 assert.ok(evidence.oldErrors.some(e=>e.includes("Cannot access 'ZodUnknown' before initialization")));
 evidence.checks.push('old-production-TDZ-with-old-worker');
 root=current;upgraded=true;
 await page.reload();await page.getByText('Select a file',{exact:true}).first().waitFor({timeout:30000});
 await page.locator('#app-loading-screen').waitFor({state:'hidden',timeout:30000});
 assert.deepEqual(evidence.newErrors,[]);evidence.checks.push('new-production-boot-under-old-controller');
 await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});
 await page.waitForFunction(async()=>Boolean((await navigator.serviceWorker.getRegistration())?.waiting),{},{timeout:60000});
 // Normal browser lifecycle: closing the only controlled tab permits waiting activation.
 // Do not clear storage or force skip-waiting on behalf of a real user.
 await page.close();
 const next=await context.newPage();next.on('pageerror',e=>evidence.newErrors.push(e.message));await next.goto(base);
 await next.getByText('Select a file',{exact:true}).first().waitFor({timeout:30000});
 await next.locator('#app-loading-screen').waitFor({state:'hidden',timeout:30000});
 const chooser=next.waitForEvent('filechooser');await next.getByText('Select a file',{exact:true}).first().click();await (await chooser).setFiles([]);
 const version=(await readFile(path.join(current,'service-worker.js'),'utf8')).match(/BUILD_VERSION = '([^']+)'/)[1];
 await next.waitForFunction(()=>navigator.serviceWorker.controller!==null);
 const workerVersion=await next.evaluate(()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker version timeout')),15000);const handler=e=>{if(e.data?.type==='PWA_VERSION'){clearTimeout(timer);navigator.serviceWorker.removeEventListener('message',handler);resolve(e.data.version);}};navigator.serviceWorker.addEventListener('message',handler);navigator.serviceWorker.controller.postMessage({type:'GET_VERSION'});}));
 assert.equal(workerVersion,version);evidence.activeWorkerVersion=workerVersion;
 assert.equal(await next.evaluate(()=>localStorage.getItem('startup-preservation-sentinel')),'keep');
 assert.deepEqual(evidence.newErrors,[]);assert.deepEqual(evidence.external,[]);evidence.checks.push('activated-new-worker-reopen-upload-ui-storage-preserved');evidence.version=version;
 await next.screenshot({path:path.join(out,'upgrade.png'),fullPage:true});
}finally{await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));await browser.close();await new Promise(resolve=>server.close(resolve));}
