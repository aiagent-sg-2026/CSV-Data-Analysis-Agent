// @vitest-environment node
import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCampaign,openCampaign} from '../scripts/coding-agent-evaluation/campaign.mjs';
import {atomicWrite} from '../scripts/coding-agent-evaluation/fixtureKit.mjs';

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const setup=async(limits={calls:2,inputTokens:100,outputTokens:100,costMicrousd:100})=>{
    const directory=await mkdtemp(path.join(tmpdir(),'ca173-campaign-'));directories.push(directory);
    return createCampaign(path.join(directory,'run'),{qualificationSha256:'a'.repeat(64),pairId:'mock-pair',mode:'mock',runIds:['case/17','case/41']},limits);
};
describe('durable global campaign request reservations',()=>{
    it('reserves the whole request before invoking transport and keeps failed/unknown usage charged',async()=>{
        const campaign=await setup();await campaign.startRun('case/17');
        let sent=0;
        await expect(campaign.request('case/17','pi',{inputTokens:50,outputTokens:50,costMicrousd:50},async()=>{sent++;throw new Error('unknown remote completion');})).rejects.toThrow('request_usage_uncertain');
        expect(sent).toBe(1);expect(campaign.snapshot.allocated.calls).toBe(1);
        expect(campaign.snapshot.status).toBe('uncertain');
        await expect(campaign.request('case/17','compaction',{inputTokens:1,outputTokens:1,costMicrousd:1},async()=>{sent++;return {}; })).rejects.toThrow();
        expect(sent).toBe(1);await campaign.close();
    });
    it('does not send when an exact-boundary reservation would exceed any campaign ceiling',async()=>{
        const campaign=await setup({calls:1,inputTokens:10,outputTokens:10,costMicrousd:10});await campaign.startRun('case/17');
        let sent=0;const send=async()=>{sent++;return {value:'ok',usage:{inputTokens:10,outputTokens:10,costMicrousd:10}};};
        await campaign.request('case/17','health',{inputTokens:10,outputTokens:10,costMicrousd:10},send);
        await expect(campaign.request('case/17','planner',{inputTokens:1,outputTokens:1,costMicrousd:1},send)).rejects.toThrow('campaign_budget_exhausted');
        expect(sent).toBe(1);await campaign.close();
    });
    it('serializes concurrent admissions and reserves one scarce call only once',async()=>{
        const campaign=await setup({calls:1,inputTokens:100,outputTokens:100,costMicrousd:100});await campaign.startRun('case/17');
        let release!:()=>void,entered!:()=>void,sent=0;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
        const first=campaign.request('case/17','pi',{inputTokens:10,outputTokens:10,costMicrousd:1},async()=>{sent++;entered();await gate;return {value:'ok',usage:{inputTokens:10,outputTokens:10,costMicrousd:1}};});
        await started;
        await expect(campaign.request('case/17','compaction',{inputTokens:10,outputTokens:10,costMicrousd:1},async()=>{sent++;return {};})).rejects.toThrow('campaign_budget_exhausted');
        release();await first;
        expect(sent).toBe(1);expect(campaign.snapshot.allocated.calls).toBe(1);await campaign.close();
    });
    it('refuses transport after a reservation persistence failure',async()=>{
        const directory=await mkdtemp(path.join(tmpdir(),'ca173-campaign-'));directories.push(directory);let writes=0;
        const campaign=await createCampaign(path.join(directory,'run'),{qualificationSha256:'a'.repeat(64),pairId:'mock',mode:'mock',runIds:['case/17']},
            {calls:10,inputTokens:10,outputTokens:10,costMicrousd:10},{persist:async(...args:Parameters<typeof atomicWrite>)=>{if(++writes===3)throw new Error('disk full');return atomicWrite(...args);}});
        await campaign.startRun('case/17');
        let sent=0;await expect(campaign.request('case/17','pi',{inputTokens:1,outputTokens:1,costMicrousd:1},async()=>{sent++;return {};})).rejects.toThrow('campaign_persistence_failed');
        expect(sent).toBe(0);await campaign.close();
    });
    it('restores a paused/uncertain run without automatically replaying any request',async()=>{
        const campaign=await setup();await campaign.startRun('case/17');const binding=campaign.snapshot.binding;await campaign.close();
        const restored=await openCampaign(campaign.directory,binding);expect(restored.snapshot.status).toBe('uncertain');
        await expect(restored.startRun('case/41')).rejects.toThrow('campaign_uncertain');await restored.close();
    });
    it('verifies durable result hashes and prevents concurrent owners',async()=>{
        const campaign=await setup();await campaign.startRun('case/17');
        await campaign.finishRun('case/17',{status:'blocked',reason:'synthetic'});
        await expect(openCampaign(campaign.directory,campaign.snapshot.binding)).rejects.toThrow('campaign_already_owned');
        const binding=campaign.snapshot.binding;await campaign.close();
        const result=path.join(campaign.directory,'attempt-001.json');await writeFile(result,'changed');
        await expect(openCampaign(campaign.directory,binding)).rejects.toThrow('campaign_result_hash_mismatch');
    });
    it.each([NaN,'1',null,-1,0])('rejects invalid campaign ceilings (%s)',async value=>{
        const directory=await mkdtemp(path.join(tmpdir(),'ca173-campaign-'));directories.push(directory);
        await expect(createCampaign(path.join(directory,'bad'),{qualificationSha256:'a'.repeat(64),pairId:'mock',mode:'mock',runIds:['run/1']},
            {calls:value,inputTokens:10,outputTokens:10,costMicrousd:10})).rejects.toThrow('campaign_contract_invalid');
    });
    it('never records raw transport errors, credentials or provider payloads',async()=>{
        const campaign=await setup();await campaign.startRun('case/17');
        await expect(campaign.request('case/17','pi',{inputTokens:10,outputTokens:10,costMicrousd:10},async()=>{throw new Error('Bearer private-unlogged');})).rejects.toThrow('request_usage_uncertain');
        expect(await readFile(path.join(campaign.directory,'campaign.json'),'utf8')).not.toContain('private-unlogged');await campaign.close();
    });
    it('keeps an in-flight Stop uncertain and charged, even when a late reply succeeds',async()=>{
        const campaign=await setup();await campaign.startRun('case/17');
        let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
        const pending=campaign.request('case/17','pi',{inputTokens:10,outputTokens:10,costMicrousd:1},async()=>{
            entered();await gate;return {value:'late',usage:{inputTokens:1,outputTokens:1,costMicrousd:0}};
        });
        await started;await campaign.stop();release();
        await expect(pending).rejects.toThrow('request_usage_uncertain');
        expect(campaign.snapshot).toMatchObject({status:'uncertain',allocated:{calls:1,inputTokens:10,outputTokens:10,costMicrousd:1}});
        await expect(campaign.startRun('case/41')).rejects.toThrow('campaign_uncertain');await campaign.close();
    });
    it('retains the full reservation when reported usage exceeds its admitted bound',async()=>{
        const campaign=await setup();await campaign.startRun('case/17');
        await expect(campaign.request('case/17','pi',{inputTokens:10,outputTokens:10,costMicrousd:1},async()=>({
            value:'unsupported usage',usage:{inputTokens:11,outputTokens:1,costMicrousd:0}
        }))).rejects.toThrow('request_usage_uncertain');
        expect(campaign.snapshot).toMatchObject({status:'uncertain',allocated:{calls:1,inputTokens:10,outputTokens:10,costMicrousd:1}});
        await campaign.close();
    });
});
