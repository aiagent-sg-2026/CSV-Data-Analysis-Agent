import path from 'node:path';
import {readFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {assertFixtureRuntime,json} from './coding-agent-evaluation/fixtureKit.mjs';
import {runQualificationCampaign} from './coding-agent-evaluation/runner.mjs';
import {createBrowserEvaluationAdapter} from './coding-agent-evaluation/browserAdapter.mjs';

const args=process.argv.slice(2),repository=fileURLToPath(new URL('../../',import.meta.url));
let adapter;
try{
  assertFixtureRuntime();
  const allowed=['--suite','--manifest','--output','--budget','--browser','--entry-point'];
  if(args.length!==12||allowed.some((flag,n)=>args[n*2]!==flag)||!['initial_analysis','follow_up'].includes(args[11]))throw new Error('usage_invalid');
  const read=async file=>{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw new Error('input_invalid');return JSON.parse(await readFile(file,'utf8'));};
  const manifest=await read(path.resolve(args[3])),limits=await read(path.resolve(args[7]));
  const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  adapter=await createBrowserEvaluationAdapter({site:repository,browserPath:args[9],entryPoint:args[11]});
  const result=await runQualificationCampaign({repository,suite:path.resolve(args[1]),manifest,directory:path.resolve(args[5]),adapter,limits,signal:controller.signal});
  process.stdout.write(json({status:result.status,summary:result.summary,providerCalls:0,paidSpendUsd:0,liveRunAuthorized:false}));
  process.exitCode=result.status==='finished'&&result.summary.scheduleComplete?0:2;
}catch{
  await adapter?.close().catch(()=>{});
  process.stdout.write(json({status:'invalid',reasons:['campaign_input_or_execution_invalid'],providerCalls:0,paidSpendUsd:0,liveRunAuthorized:false}));process.exitCode=2;
}
