// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCampaign} from '../scripts/coding-agent-evaluation/campaign.mjs';
import {createLiveHttpAdapter,reconcileHttpAccounting} from '../scripts/coding-agent-evaluation/liveHttpAdapter.mjs';
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const model='local-protocol-mock';
const native=(input=12,output=7)=>({model,status:'completed',usage:{input_tokens:input,output_tokens:output,total_tokens:input+output},output:[]});
const descriptor=(session=false)=>({url:`https://gpt.yapweijun1996.com${session?'/demo/session':'/demo/v1/responses'}`,method:'POST',headers:{Authorization:'Bearer synthetic-private-value'},body:JSON.stringify(session?{projectId:'github-pages'}:{model,input:[]})});
const setup=async(send=async()=>({status:200,body:JSON.stringify(native())}),limits={calls:20,inputTokens:100000,outputTokens:100000,costMicrousd:100000})=>{
    const directory=await mkdtemp(path.join(tmpdir(),'metered-http-'));directories.push(directory);
    const campaign=await createCampaign(path.join(directory,'ledger'),{qualificationSha256:'a'.repeat(64),pairId:'local',mode:'mock',runIds:['run/17']},limits);
    await campaign.startRun('run/17');
    const config={transport:{mode:'local_mock',send},model,bounds:{session:{inputTokens:0,outputTokens:0,costMicrousd:0},provider:{inputTokens:1000,outputTokens:1000,costMicrousd:3000},requestBytes:600000,responseBytes:1000000},
        pricing:{inputMicrousdPerMillion:1000000,outputMicrousdPerMillion:2000000},nonBillableStatuses:[401,429]};
    const adapter=createLiveHttpAdapter(config);
    const exchange=(request=descriptor(),signal?:AbortSignal)=>adapter.exchange(request,(kind,bounds,send)=>campaign.request('run/17',kind,bounds,send),signal);
    return {campaign,adapter,exchange,config};
};
describe('live protocol adapter under local transport custody',()=>{
    it('durably reserves before physical dispatch, settles native usage, and keeps the independent observer secret-safe',async()=>{
        let s:Awaited<ReturnType<typeof setup>>;
        s=await setup(async()=>{
            const ledger=JSON.parse(await readFile(path.join(s.campaign.directory,'campaign.json'),'utf8'));
            expect(ledger.requests.at(-1).state).toBe('reserved');
            expect(ledger.allocated).toMatchObject({calls:1,inputTokens:1000,outputTokens:1000,costMicrousd:3000});
            return {status:200,body:JSON.stringify(native())};
        });
        await s.exchange();
        expect(s.campaign.snapshot.used).toEqual({calls:1,inputTokens:12,outputTokens:7,costMicrousd:26});
        expect(s.adapter.observations).toMatchObject([{attempt:1,status:200,usageStatus:'observed',usage:{inputTokens:12,outputTokens:7,costMicrousd:26}}]);
        expect(s.adapter.observations[0].promptSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(s.adapter.observations[0].toolSchemaSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(reconcileHttpAccounting(s.adapter.observations,s.campaign.snapshot).status).toBe('matched');
        const replaced=s.adapter.observations;replaced[0].usage.inputTokens++;
        expect(reconcileHttpAccounting(replaced,s.campaign.snapshot).status).toBe('unmatched');
        expect(JSON.stringify(s.adapter.observations)).not.toContain('synthetic-private-value');
        expect(await readFile(path.join(s.campaign.directory,'campaign.json'),'utf8')).not.toContain('synthetic-private-value');
        await s.campaign.close();
    });
    it.each([200,201])('counts HTTP %s sessions and every explicitly nonbillable retry as separate physical attempts',async status=>{
        const replies=[{status,body:JSON.stringify({token:'local-session-placeholder',model})},{status:401,body:'{}'},{status:429,body:'{}'},{status:200,body:JSON.stringify(native())}];
        const s=await setup(async()=>replies.shift()!);
        await s.exchange(descriptor(true));for(let n=0;n<3;n++)await s.exchange();
        expect(s.adapter.observations).toHaveLength(4);expect(s.campaign.snapshot.used.calls).toBe(4);
        expect(s.campaign.snapshot.requests.map(r=>r.kind.split('/')[0])).toEqual(['gateway_session','http_provider','http_provider','http_provider']);
        expect(reconcileHttpAccounting(s.adapter.observations,s.campaign.snapshot).status).toBe('matched');
        const replaced=s.adapter.observations;replaced.forEach(item=>{item.usage={inputTokens:s.campaign.snapshot.used.inputTokens,outputTokens:s.campaign.snapshot.used.outputTokens,costMicrousd:s.campaign.snapshot.used.costMicrousd};});
        expect(reconcileHttpAccounting(replaced,s.campaign.snapshot).status).toBe('unmatched');
        await s.campaign.close();
    });
    it.each(['url','query','method','model','output_limit'])('rejects %s before transport or reservation',async kind=>{
        const send=vi.fn(async()=>({status:200,body:JSON.stringify(native())})),s=await setup(send),request=descriptor();
        if(kind==='url')request.url='https://unreviewed.invalid/demo/v1/responses';
        if(kind==='query')request.url+='?secret=private';if(kind==='method')request.method='GET';
        if(kind==='model')request.body=JSON.stringify({model:'different-model'});
        if(kind==='output_limit')request.body=JSON.stringify({model,max_output_tokens:10});
        await expect(s.exchange(request)).rejects.toThrow();
        expect(send).not.toHaveBeenCalled();expect(s.campaign.snapshot.requests).toHaveLength(0);expect(s.adapter.observations).toHaveLength(0);
        await s.campaign.close();
    });
    it.each(['missing','wrong_model','raw_string','over_bound','bad_total','http_error'])('retains full reservation and stops on %s usage',async kind=>{
        const value=native();
        if(kind==='missing')delete (value as Partial<typeof value>).usage;
        if(kind==='wrong_model')value.model='unreviewed';if(kind==='raw_string')Reflect.set(value.usage,'input_tokens','12');
        if(kind==='over_bound')Object.assign(value.usage,{input_tokens:1001,total_tokens:1008});if(kind==='bad_total')value.usage.total_tokens=999;
        const send=vi.fn(async()=>({status:kind==='http_error'?503:200,body:kind==='http_error'?'{}':JSON.stringify(value)})),s=await setup(send);
        await expect(s.exchange()).rejects.toThrow('request_usage_uncertain');
        expect(s.campaign.snapshot).toMatchObject({status:'uncertain',allocated:{calls:1,inputTokens:1000,outputTokens:1000,costMicrousd:3000}});
        await expect(s.exchange()).rejects.toThrow();expect(send).toHaveBeenCalledTimes(1);
        await s.campaign.close();
    });
    it('refuses overflow before dispatch and does not create an observer attempt',async()=>{
        const send=vi.fn(async()=>({status:200,body:JSON.stringify(native())}));
        const s=await setup(send,{calls:1,inputTokens:1000,outputTokens:1000,costMicrousd:3000});
        await s.exchange();await expect(s.exchange()).rejects.toThrow('campaign_budget_exhausted');
        expect(send).toHaveBeenCalledTimes(1);expect(s.adapter.observations).toHaveLength(1);await s.campaign.close();
    });
    it('fences an ignoring transport on abort and never settles a late reply',async()=>{
        let release!:(value:{status:number;body:string})=>void,entered!:()=>void;
        const started=new Promise<void>(r=>entered=r),reply=new Promise<{status:number;body:string}>(r=>release=r);
        const s=await setup(async()=>{entered();return reply;}),controller=new AbortController();
        const pending=s.exchange(descriptor(),controller.signal);await started;controller.abort();
        await expect(pending).rejects.toThrow('request_usage_uncertain');
        release({status:200,body:JSON.stringify(native())});await Promise.resolve();
        expect(s.campaign.snapshot.status).toBe('uncertain');expect(s.campaign.snapshot.used.calls).toBe(0);
        expect(s.adapter.observations[0].usageStatus).toBe('not_exposed');await s.campaign.close();
    });
    it('settles one complete SSE response, refusing ambiguous terminal records',async()=>{
        const body=`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:native()})}\n\ndata: [DONE]\n`;
        const s=await setup(async()=>({status:200,body}));await s.exchange();expect(s.campaign.snapshot.used.calls).toBe(1);await s.campaign.close();
        const duplicate=await setup(async()=>({status:200,body:body+body}));await expect(duplicate.exchange()).rejects.toThrow('request_usage_uncertain');await duplicate.campaign.close();
    });
    it('rejects remote transport activation and does not treat mutable config as authority',async()=>{
        const s=await setup();expect(()=>createLiveHttpAdapter({...s.config,transport:{mode:'live',send:vi.fn()}})).toThrow();
        expect(()=>createLiveHttpAdapter({...s.config,bounds:{...s.config.bounds,provider:{...s.config.bounds.provider,costMicrousd:2999}}})).toThrow();
        s.config.model='changed-after-pin';s.config.bounds.provider.outputTokens=0;
        s.config.transport.send=async()=>{throw new Error('replaced-after-pin');};
        await s.exchange();expect(s.campaign.snapshot.used.outputTokens).toBe(7);await s.campaign.close();
    });
});
