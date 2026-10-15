// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {frozenFaultPolicy,hasFrozenFaultRecovery} from '../scripts/coding-agent-evaluation/faultSchedule.mjs';
import {buildFixtureSuite} from '../scripts/coding-agent-evaluation/fixtureKit.mjs';
import {scoreAttempt,summarizeCampaign} from '../scripts/coding-agent-evaluation/scoring.mjs';
const schedule=[{execution:1,observation:'injected_program_or_schema_failure',requires:'bounded_revision'}];
const evidence=()=>{
    const policy=frozenFaultPolicy(schedule);
    return {scheduleSha256:policy.scheduleSha256,receipts:[
        {jobId:'failed',taskId:'task',sessionId:'session',sessionEpoch:1,status:'failed',reasonCode:'guest_program_failed',program:{sha256:'a'.repeat(64)},
            environment:{evaluationFault:{kind:'program_failure',execution:1,scheduleSha256:policy.scheduleSha256}},workerGenerations:[1],
            error:{message:'Execution failed at the runtime boundary.'},startedAt:1,finishedAt:2},
        {jobId:'revised',taskId:'task',sessionId:'session',sessionEpoch:1,status:'succeeded',program:{sha256:'b'.repeat(64)},environment:{},workerGenerations:[2],startedAt:3,finishedAt:4},
    ]};
};
describe('frozen evaluator fault custody and recovery acceptance',()=>{
    it('projects only the supported schedule without any canonical facts or program text',()=>{
        expect(frozenFaultPolicy([])).toBeUndefined();expect(frozenFaultPolicy(schedule)).toEqual({scheduleSha256:expect.stringMatching(/^[a-f0-9]{64}$/),executions:[1]});
        expect(()=>frozenFaultPolicy([{...schedule[0],execution:2}])).toThrow('fault_schedule_invalid');
        expect(()=>frozenFaultPolicy([{...schedule[0],program:'oracle'}])).toThrow('fault_schedule_invalid');
        expect(hasFrozenFaultRecovery(schedule,evidence())).toBe(true);
    });
    it.each(['missing','same_program','wrong_session','wrong_digest','fake_success','no_worker','duplicate','wrong_order'])('rejects %s recovery evidence',kind=>{
        const value=evidence();
        if(kind==='missing')value.receipts.shift();if(kind==='same_program')value.receipts[1].program.sha256=value.receipts[0].program.sha256;
        if(kind==='wrong_session')value.receipts[1].sessionId='other';if(kind==='wrong_digest')value.scheduleSha256='f'.repeat(64);
        if(kind==='fake_success')value.receipts[0].status='succeeded';if(kind==='no_worker')value.receipts[0].workerGenerations=[];
        if(kind==='duplicate')value.receipts.push(value.receipts[0]);if(kind==='wrong_order')value.receipts[1].startedAt=0;
        expect(hasFrozenFaultRecovery(schedule,value)).toBe(false);
    });
    it('cannot pass live quality merely by reporting every numerical success while omitting frozen fault recovery',()=>{
        const suite=buildFixtureSuite(),runs=suite.manifest.cases.flatMap(c=>[17,41,97].map(seed=>({id:`pair/${c.id}/${seed}`,caseId:c.id})));
        const attempts=runs.map(run=>({runId:run.id,mode:'live',status:'completed',elapsedMs:1,
            score:{correct:true,critical:[],firstAttempt:true,novelRepair:true,independentNewMethod:true,faultRecovery:false}}));
        const summary=summarizeCampaign({schedule:runs,candidate:{pairId:'pair'}},attempts,'live');
        expect(summary).toMatchObject({qualityPassed:false,faultRecovery:{expected:9,observed:9,passed:0}});
        const item=suite.manifest.cases.find(c=>c.id==='S1-4'),oracle=JSON.parse(suite.files.get('evaluator/S1-4/oracle.json'));
        expect(scoreAttempt(item,oracle,{status:'completed',rawOriginalPreserved:true,approvedCount:0}).reasons).toContain('frozen_fault_recovery_unverified');
        const recovered={status:'completed',rawOriginalPreserved:true,approvedCount:1,faultEvidence:evidence(),inspection:{observations:[],omittedObservations:30},
            exported:{'accepted/output.json':{tables:[{role:'fact',rows:oracle.expectedFacts}]},'manifest.json':{acceptedDataset:{status:'independently_validated'},files:[]}}};
        expect(scoreAttempt(item,oracle,recovered)).toMatchObject({correct:true,firstAttempt:false,afterRevision:true});
    });
});
