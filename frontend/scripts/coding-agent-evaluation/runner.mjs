import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {inspectQualification,captureFrozenAgentInputs} from './qualificationPreflight.mjs';
import {readFixtureArtifact} from './preflight.mjs';
import {createCampaign,openCampaign} from './campaign.mjs';
import {scoreAttempt,summarizeCampaign} from './scoring.mjs';
import {sha256,json,atomicWrite} from './fixtureKit.mjs';
import {frozenFaultPolicy} from './faultSchedule.mjs';

/** No provider SDK, credential, environment, or network import. Adapter is a host-owned execution port. */
export const runQualificationCampaign=async({repository,suite,manifest,directory,adapter,limits=undefined,resume=false,signal=undefined,onAttempt=undefined})=>{
  const output=path.resolve(directory),corpus=path.resolve(suite);
  if(output===corpus||output.startsWith(corpus+path.sep))throw new Error('campaign_destination_invalid');
  const preflight=await inspectQualification(repository,suite,manifest);
  if(preflight.status!=='preflight_complete')throw new Error('qualification_preflight_invalid');
  if(!adapter||adapter.mode!=='mock'||typeof adapter.execute!=='function')throw new Error('live_campaign_not_authorized');
  if(adapter.deploymentPins){const expected=new Map(manifest.pins.deployment.map(p=>[p.path,p.sha256]));
    if(adapter.deploymentPins.length!==expected.size||adapter.deploymentPins.some(p=>expected.get(p.path)!==p.sha256))throw new Error('campaign_browser_build_mismatch');}
  const binding={qualificationSha256:sha256(json(manifest)),pairId:manifest.candidate.pairId,mode:'mock',runIds:manifest.schedule.map(r=>r.id)};
  const fixture=JSON.parse((await readFixtureArtifact(suite,'manifest.json')).toString()),items=new Map(fixture.cases.map(c=>[c.id,c]));
  const loadInputs=await captureFrozenAgentInputs(suite),oracles=new Map();
  for(const item of fixture.cases){const artifact=item.evaluatorFiles.find(f=>f.path.endsWith('/oracle.json'));
    const bytes=await readFixtureArtifact(suite,artifact.path);if(sha256(bytes)!==artifact.sha256)throw new Error('oracle_hash_mismatch');oracles.set(item.id,JSON.parse(bytes.toString()));}
  const campaign=resume?await openCampaign(directory,binding):await createCampaign(directory,binding,limits);
  const attempts=[];
  try{
    for(const run of campaign.snapshot.runs.filter(r=>r.result))attempts.push(JSON.parse(await readFile(`${directory}/${run.result.file}`,'utf8')));
    if(['paused','uncertain','stopped','storage_failed'].includes(campaign.snapshot.status))return {status:campaign.snapshot.status,summary:summarizeCampaign(manifest,attempts,'mock'),ledger:campaign.snapshot};
    for(const run of manifest.schedule){
      if(campaign.snapshot.runs.find(r=>r.id===run.id)?.status!=='pending')continue;
      if(signal?.aborted){await campaign.stop();break;}
      const files=loadInputs(run.caseId),item=items.get(run.caseId);
      await campaign.startRun(run.id);const started=performance.now();let result;
      try{
        result=await adapter.execute({runId:run.id,seed:run.seed,files:files.map(f=>({name:f.name,bytes:Array.from(f.bytes)})),signal,
          faultPolicy:frozenFaultPolicy(oracles.get(run.caseId).faultSchedule),
          request:(kind,bounds,send)=>campaign.request(run.id,kind,bounds,send)});
      }catch{result={status:signal?.aborted?'cancelled':'blocked',rawOriginalPreserved:null,approvedCount:0,acceptedCommit:null,pending:null,transportError:true};}
      const oracle=oracles.get(run.caseId);
      const attempt={runId:run.id,seed:run.seed,mode:'mock',status:result.status,elapsedMs:Math.round(performance.now()-started),
        score:scoreAttempt(item,oracle,result),result};
      await campaign.finishRun(run.id,attempt);attempts.push(attempt);await onAttempt?.(attempt);
      if(!['ready','running'].includes(campaign.snapshot.status))break;
    }
    const summary=summarizeCampaign(manifest,attempts,'mock'),ledger=campaign.snapshot;
    await atomicWrite(`${directory}/summary.json`,json({...summary,accounting:{allocated:ledger.allocated,settled:ledger.used},
      providerCalls:0,paidSpendUsd:0,simulatedRequests:ledger.requests.length,liveRunAuthorized:false}));
    return {status:ledger.status,summary,ledger};
  }finally{try{await adapter.close?.();}finally{await campaign.close();}}
};
