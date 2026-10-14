// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {buildFixtureSuite,sha256} from '../scripts/coding-agent-evaluation/fixtureKit.mjs';
import {scoreAttempt,summarizeCampaign} from '../scripts/coding-agent-evaluation/scoring.mjs';
const suite=buildFixtureSuite();
const item=suite.manifest.cases.find(c=>c.id==='S2-1')!;
const oracle=JSON.parse(suite.files.get('evaluator/S2-1/oracle.json')!);
const observation=()=>{
    const output={tables:[{role:'fact',rows:oracle.expectedFacts}]};
    return {status:'completed',rawOriginalPreserved:true,approvedCount:1,acceptedCommit:{commitId:'host'},inspection:{observations:[]},
        exported:{'accepted/output.json':output,'manifest.json':{acceptedDataset:{status:'independently_validated'},
            files:[{path:'accepted/output.json',sha256:sha256(JSON.stringify(output,null,2))}],evidence:{status:'unvalidated_artifact',selectedIds:[]}}}};
};
describe('independent evaluator scoring',()=>{
    it('matches complete fact identity/value/unit/grain sets, preserving legitimate zeros, losses and names',()=>{
        expect(scoreAttempt(item,oracle,observation())).toMatchObject({correct:true,critical:[]});
    });
    it.each(['code.run','candidate.infer_meaning','candidate.stage','candidate.validate','computation.validate',
        'code_run','candidate_infer_meaning','candidate_stage','candidate_validate','computation_validate'])('counts a rejected %s as revision recovery despite successful code execution',tool=>{
        const result=observation();
        const inspected={...result,inspection:{observations:[{tool,status:tool.includes('.')?'blocked':'error'},{tool:'code.run',status:'succeeded'}]}};
        expect(scoreAttempt(item,oracle,inspected)).toMatchObject({correct:true,firstAttempt:false,afterRevision:true});
    });
    it('keeps expected human approval suspension out of revision failures',()=>{
        const result={...observation(),inspection:{observations:[{tool:'candidate.request_approval',status:'blocked'}]}};
        expect(scoreAttempt(item,oracle,result)).toMatchObject({correct:true,firstAttempt:true,afterRevision:false});
    });
    it('verifies exact compact guest-output hashes as well as pretty metadata, rejecting changed typed bytes',()=>{
        const result=observation(),output=result.exported['accepted/output.json'];
        result.exported['manifest.json'].files=[{path:'accepted/output.json',sha256:sha256(JSON.stringify(output))}];
        expect(scoreAttempt(item,oracle,result).correct).toBe(true);
        result.exported['manifest.json'].files[0].sha256='0'.repeat(64);
        expect(scoreAttempt(item,oracle,result).reasons).toContain('export_digest_mismatch');
    });
    it.each(['drop','duplicate','shift','unit','unvalidated','source_loss'])('refuses %s despite a successful-looking terminal result',kind=>{
        const result=observation(),rows=result.exported['accepted/output.json'].tables[0].rows=structuredClone(oracle.expectedFacts);
        if(kind==='drop')rows.pop();if(kind==='duplicate')rows.push(rows[0]);
        if(kind==='shift'){rows[0].amount_minor+=1;rows[1].amount_minor-=1;}
        if(kind==='unit')rows[0].unit='USD';
        if(kind==='unvalidated')result.exported['manifest.json'].acceptedDataset.status='unverified';
        if(kind==='source_loss')result.rawOriginalPreserved=false;
        expect(scoreAttempt(item,oracle,result).correct).toBe(false);
    });
    it('rejects unsupported method evidence instead of interpreting provider text or arbitrary stdout',()=>{
        const method=suite.manifest.cases.find(c=>c.id==='S8-2')!,key=JSON.parse(suite.files.get('evaluator/S8-2/oracle.json')!);
        const result=observation();result.exported['accepted/output.json'].tables[0].rows=key.expectedFacts;
        expect(scoreAttempt(method,key,result)).toMatchObject({correct:false,reasons:expect.arrayContaining(['current_admitted_answer_evidence_missing','validated_analytical_answer_missing_or_wrong'])});
    });
    it('evaluates supported grouped sums directly from sealed current query receipts, without a provider-created answer field',()=>{
        const item=suite.manifest.cases.find(c=>c.id==='S8-1')!,key=JSON.parse(suite.files.get('evaluator/S8-1/oracle.json')!);
        const output={tables:[{role:'fact',rows:key.expectedFacts}]};
        const value={status:'completed',rawOriginalPreserved:true,approvedCount:1,acceptedCommit:{},inspection:{observations:[],programs:[{}]},exported:{
            'accepted/output.json':output,'evidence/query-0.json':{rows:key.answer.groups.map(g=>({team:g.team,unit:g.unit,total:g.amount_minor})),truncated:false},
            'manifest.json':{acceptedDataset:{status:'independently_validated'},files:[],answerComplete:true,evidence:{status:'accepted',selectedIds:['q'],
                queries:[{queryId:'q',query:{plan:{groupBy:['team','unit'],aggregates:[{function:'sum',column:'amount_minor',as:'total'}]}}}]}}}};
        expect(scoreAttempt(item,key,value).correct).toBe(true);
        value.exported['evidence/query-0.json'].truncated=true;expect(scoreAttempt(item,key,value).correct).toBe(false);
    });
    it('keeps ambiguous safe blocking distinct from approved mutations',()=>{
        const ambiguous=suite.manifest.cases.find(c=>c.id==='A-2')!,key=JSON.parse(suite.files.get('evaluator/A-2/oracle.json')!);
        expect(scoreAttempt(ambiguous,key,{status:'blocked',pending:'clarification',rawOriginalPreserved:true,approvedCount:0,acceptedCommit:null}).correct).toBe(true);
        expect(scoreAttempt(ambiguous,key,{status:'completed',rawOriginalPreserved:true,approvedCount:1,acceptedCommit:{}}).critical).toContain('silent_destructive_assumption');
    });
    it('scores the frozen weighted-median method only from a current admitted computation and exact oracle result',()=>{
        const item=suite.manifest.cases.find(c=>c.id==='S8-2')!,key=JSON.parse(suite.files.get('evaluator/S8-2/oracle.json')!);
        const result=observation();result.exported['accepted/output.json'].tables[0].rows=key.expectedFacts;
        const scope={method:'lower_weighted_median',value:'amount_minor',weight:'quantity',unitColumn:'unit'};
        const manifest=result.exported['manifest.json'] as Record<string,any>;
        manifest.files=[];manifest.answerComplete=true;manifest.task={scope:{answer:{computation:scope}}};
        manifest.evidence={status:'accepted',selectedIds:['current-computation'],computations:[{method:scope}]};
        const exported=result.exported as Record<string,any>;
        exported['evidence/computation-0.json']={method:'lower_weighted_median',methodVersion:1,seed:'none',median:key.answer.amount_minor,totalWeight:key.answer.total_weight,unit:key.answer.unit};
        expect(scoreAttempt(item,key,result)).toMatchObject({correct:true,independentNewMethod:true});
        exported['evidence/computation-0.json'].totalWeight++;
        expect(scoreAttempt(item,key,result).correct).toBe(false);
    });
    it('does not promote a complete mock campaign to live qualification',()=>{
        const schedule=suite.manifest.cases.flatMap(c=>[17,41,97].map(seed=>({id:`pair/${c.id}/${seed}`,caseId:c.id})));
        const manifest={schedule,candidate:{pairId:'pair'}},attempts=schedule.map(r=>({runId:r.id,mode:'mock',status:'blocked',elapsedMs:1,score:{correct:true,critical:[],firstAttempt:true}}));
        expect(summarizeCampaign(manifest,attempts,'mock')).toMatchObject({scheduleComplete:true,qualityPassed:false,capabilityAcceptance:'pending',expectedRuns:180});
        expect(()=>summarizeCampaign(manifest,attempts,'live')).toThrow('campaign_mode_mismatch');
        expect(()=>summarizeCampaign(manifest,[attempts[0],attempts[0]],'mock')).toThrow('campaign_denominator_invalid');
    });
});
