// @vitest-environment node
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {writeFixtureSuite} from '../scripts/coding-agent-evaluation/fixtureKit.mjs';
import {freezeQualification} from '../scripts/coding-agent-evaluation/qualificationPreflight.mjs';
import {runQualificationCampaign} from '../scripts/coding-agent-evaluation/runner.mjs';
let temporary:string,suite:string,manifest:Awaited<ReturnType<typeof freezeQualification>>;
const repository=path.resolve('..'),limits={calls:200,inputTokens:2000,outputTokens:2000,costMicrousd:1};
beforeAll(async()=>{temporary=await mkdtemp(path.join(tmpdir(),'ca173-runner-test-'));suite=path.join(temporary,'suite');await writeFixtureSuite(suite);manifest=await freezeQualification(repository,suite);},30000);
afterAll(async()=>{await rm(temporary,{recursive:true,force:true});});
const result=()=>({status:'blocked',rawOriginalPreserved:true,approvedCount:0,acceptedCommit:null,pending:'clarification'});
describe('frozen zero-call campaign orchestration',()=>{
    it('executes the complete 180-slot denominator with only agent artifacts and no live acceptance',async()=>{
        let sent=0,closed=false;
        const adapter={mode:'mock',close:async()=>{closed=true;},execute:async args=>{
            expect(args.files.every(f=>!['oracle.json','canonical.csv'].includes(f.name))).toBe(true);
            const task=JSON.parse(Buffer.from(args.files.find(f=>f.name==='task.json').bytes).toString());
            expect(task).not.toHaveProperty('faultSchedule');expect(task).not.toHaveProperty('expectedFacts');
            await args.request('pi',{inputTokens:1,outputTokens:1,costMicrousd:0},async()=>{sent++;return {value:null,usage:{inputTokens:1,outputTokens:1,costMicrousd:0}};});return result();}};
        const directory=path.join(temporary,'complete');
        const actual=await runQualificationCampaign({repository,suite,manifest,directory,adapter,limits});
        expect(actual.status).toBe('finished');expect(actual.summary).toMatchObject({scheduleComplete:true,expectedRuns:180,qualityPassed:false,capabilityAcceptance:'pending'});
        expect(sent).toBe(180);expect(closed).toBe(true);expect(actual.ledger.used.calls).toBe(180);
        expect(JSON.parse(await readFile(path.join(directory,'summary.json'),'utf8')).providerCalls).toBe(0);
    },60000);
    it('pauses on budget exhaustion and resumes with complete partial accounting without any extra dispatch',async()=>{
        let sent=0;const adapter={mode:'mock',execute:async args=>{
            await args.request('health',{inputTokens:1,outputTokens:1,costMicrousd:0},async()=>{sent++;return {value:null,usage:{inputTokens:1,outputTokens:1,costMicrousd:0}};});return result();}};
        const directory=path.join(temporary,'partial');
        const actual=await runQualificationCampaign({repository,suite,manifest,directory,adapter,limits:{...limits,calls:1}});
        expect(actual.status).toBe('paused');expect(sent).toBe(1);expect(actual.summary.observedRuns).toBe(2);
        const resumed=await runQualificationCampaign({repository,suite,manifest,directory,adapter,resume:true});
        expect(resumed.status).toBe('paused');expect(sent).toBe(1);
    });
    it('refuses a live adapter or output inside the fixture before launching a run',async()=>{
        await expect(runQualificationCampaign({repository,suite,manifest,directory:path.join(temporary,'live'),adapter:{mode:'live',execute:async()=>result()},limits})).rejects.toThrow('live_campaign_not_authorized');
        await expect(runQualificationCampaign({repository,suite,manifest,directory:path.join(suite,'bad'),adapter:{mode:'mock',execute:async()=>result()},limits})).rejects.toThrow('campaign_destination_invalid');
    });
});
