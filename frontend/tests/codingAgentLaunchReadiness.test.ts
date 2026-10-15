// @vitest-environment node
import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {sha256,json} from '../scripts/coding-agent-evaluation/fixtureKit.mjs';
import {validateRuntimeCapture} from '../scripts/coding-agent-evaluation/runtimeCapture.mjs';
import {assessLiveReadiness,summarizeGatewayReply,readinessExitCode} from '../scripts/coding-agent-evaluation/launchReadiness.mjs';

const hash='a'.repeat(64);
const candidate={provider:'default',logicalModel:'gpt-5.4-mini',settings:{modelFallback:null,reasoningEffort:'medium',language:'English',
    taskLimits:{toolCalls:40,skillReads:8,providerTurns:32,transformationAttempts:3,activeMs:900000},contextCap:200000,compactionTrigger:0.8},
    proposedCeilings:{spendUsd:null,providerCalls:null,inputTokens:null,outputTokens:null}};
const capture=()=>{
    const value={settings:{provider:'default',simpleModel:'gpt-5.4-mini',complexModel:'gpt-5.4-mini',fallbackModel:null,
        reasoningEffort:'medium',language:'English',reportTemplate:'management_review',autoConfirmGoal:true,maxAgentTurns:100,
        toolOutputCutoff:10,runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}},
        enableSearchGrounding:false,enableVisualEvaluation:false},credentialsAbsent:true,unknownSettings:0,forcedModelsAbsent:true,
        workspaceEmpty:true,dataEmpty:true,conversationEmpty:true,executionIdle:true,userSkillsAbsent:true,disabledSkillsAbsent:true,externalToolsAbsent:true};
    return {...value,sha256:sha256(json(value))};
};
const pinCapture=(c:ReturnType<typeof capture>)=>{const {sha256:_digest,...value}=c;c.sha256=sha256(json(value));return c;};
const native={model:'demo-auto',status:'completed',usage:{input_tokens:10,output_tokens:2,total_tokens:12}};
const input=()=>{
    const manifest={candidate,pins:{deploymentManifest:{sha256:hash}},schedule:Array.from({length:180},(_,i)=>({id:String(i)})),
        evaluation:{thresholds:{solvableCorrect:108,solvableRuns:120,familyMinimumCorrect:12,familyRuns:15,ambiguityCorrect:29,
            ambiguityRuns:30,adversarialRuns:30,maximumCriticalFailures:0,admittedEvidenceCoverage:1,
            deterministicAcceptanceCoverage:1,minimumNovelRepairCases:16,minimumNewMethodCases:1}}};
    return {manifest,preflight:{status:'preflight_complete',qualificationSha256:sha256(json(manifest))},capture:capture(),
        siteManifestSha256:hash,browserVersion:'155.0.8059.40',emptyStorageBefore:true,
        probe:{mode:'demo_probe',outcome:'observed',failure:null,requests:['session','provider'].map(kind=>({kind,bodySha256:hash,bodyBytes:100,
            maxOutputTokensPresent:false,faultMetadataPresent:false})),replies:[summarizeGatewayReply('session',200,{model:'demo-auto'}),summarizeGatewayReply('provider',200,native)]}};
};

describe('CA-173 current-context capture and live readiness',()=>{
    it('accepts the observed fresh source-default configuration',()=>expect(validateRuntimeCapture(capture(),candidate)).toBe(true));
    it.each([200,201])('accepts session HTTP %s without treating it as a billed provider response',status=>{
        const i=input();i.probe.replies[0]=summarizeGatewayReply('session',status,{model:'demo-auto'});
        const result=assessLiveReadiness(i);expect(result.gates.nativeDemoProtocolObserved).toBe(true);
        expect(result.accounting.nativeUsage).toEqual({inputTokens:10,outputTokens:2,totalTokens:12});
        expect(result.launchReady).toBe(false);
    });
    it.each(['provider','fallback','reasoning','permission','workspace','credentials','skills','disabled','forced','external','unknown','digest'])
    ('rejects %s drift even when a local operator recomputes the observation hash',kind=>{
        const c=capture();
        if(kind==='provider')c.settings.provider='openai';if(kind==='fallback')Reflect.set(c.settings,'fallbackModel','other');
        if(kind==='reasoning')c.settings.reasoningEffort='high';if(kind==='permission')c.settings.runtimeAccessControl.permissionMode='balanced';
        if(kind==='workspace')c.workspaceEmpty=false;if(kind==='credentials')c.credentialsAbsent=false;
        if(kind==='skills')c.userSkillsAbsent=false;if(kind==='disabled')c.disabledSkillsAbsent=false;
        if(kind==='forced')c.forcedModelsAbsent=false;if(kind==='external')c.externalToolsAbsent=false;
        if(kind==='unknown')c.unknownSettings=1;pinCapture(c);if(kind==='digest')c.sha256='0'.repeat(64);
        expect(validateRuntimeCapture(c,candidate)).toBe(false);
    });
    it('records wire/usage observations without promoting alias or claimed server metadata to qualification',()=>{
        const i=input();Object.assign(i.probe.replies[1],{physicalIdentityDisclosed:true,pricingDisclosed:true,serverBoundsDisclosed:true});
        const result=assessLiveReadiness(i);
        expect(result).toMatchObject({status:'blocked',launchReady:false,liveRunAuthorized:false,
            gates:{candidateIntegrity:true,isolatedContextCaptured:true,nativeDemoProtocolObserved:true,
                physicalModelQualified:false,pricingAndServerBoundsQualified:false,campaignAuthorization:false,fullHoldoutQualified:false},
            accounting:{providerCalls:1,sessionCalls:1,nativeUsage:{inputTokens:10,outputTokens:2,totalTokens:12},paidSpendUsd:null,evaluatedQualificationRuns:0}});
        expect(result.unchanged).toEqual({taskLimits:candidate.settings.taskLimits,contextCap:200000,compactionTrigger:0.8,
            plannedRuns:180,thresholds:i.manifest.evaluation.thresholds,proposedCeilings:candidate.proposedCeilings});
        expect(readinessExitCode(result)).toBe(2);
    });
    it.each(['packet','deployment','storage','capture'])('fails the %s binding without inheriting previous success',kind=>{
        const i=input();if(kind==='packet')i.preflight.qualificationSha256='0'.repeat(64);
        if(kind==='deployment')i.siteManifestSha256='0'.repeat(64);if(kind==='storage')i.emptyStorageBefore=false;
        if(kind==='capture')i.capture.executionIdle=false;
        const result=assessLiveReadiness(i);expect(result.gates.isolatedContextCaptured).toBe(false);
        expect(result.runtime.capture).toBeNull();expect(result.launchReady).toBe(false);expect(readinessExitCode(result)).not.toBe(0);
    });
    it.each(['empty','duplicate','model','usage','forbidden','fault'])('does not accept %s transport observations',kind=>{
        const i=input();if(kind==='empty')i.probe.requests=[];if(kind==='duplicate')i.probe.requests[1]=i.probe.requests[0];
        if(kind==='model')i.probe.replies[1].wireModel='another-model';if(kind==='usage')i.probe.replies[1].usageStatus='unknown';
        if(kind==='forbidden')i.probe.requests[1].maxOutputTokensPresent=true;if(kind==='fault')i.probe.requests[1].faultMetadataPresent=true;
        const result=assessLiveReadiness(i);expect(result.gates.nativeDemoProtocolObserved).toBe(false);
        expect(result.launchBlockers).toContain('demo_protocol_probe_incomplete');expect(result.accounting.nativeUsage).toBeNull();
    });
    it.each(['missing','string','negative','total','incomplete','http'])('retains unknown %s native usage',kind=>{
        const v=structuredClone(native);if(kind==='missing')Reflect.deleteProperty(v,'usage');
        if(kind==='string')Reflect.set(v.usage,'input_tokens','10');if(kind==='negative')v.usage.input_tokens=-1;
        if(kind==='total')v.usage.total_tokens=100;if(kind==='incomplete')v.status='in_progress';
        expect(summarizeGatewayReply('provider',kind==='http'?503:200,v)).toMatchObject({usage:null,usageStatus:'unknown'});
    });
    it('omits session tokens, provider content and unknown metadata from persisted reply projection',()=>{
        const result=summarizeGatewayReply('session',200,{model:'demo-auto',token:'dmo_private',arbitrary:'secret',pricing:{key:'sk-private'}});
        expect(JSON.stringify(result)).not.toMatch(/dmo_private|sk-private|secret/);
        expect(summarizeGatewayReply('provider',200,{...native,model:'dmo_private'}).wireModel).toBeNull();
    });
    it('retains a known session and unknown provider attempt without calling a partial probe complete',()=>{
        const i=input();i.probe.replies=i.probe.replies.slice(0,1);i.probe.outcome='incomplete';
        Reflect.set(i.probe,'failure','probe_typeerror');
        const report=assessLiveReadiness(i);
        expect(report.probe.replies[0]).toMatchObject({kind:'session',status:200,wireModel:'demo-auto'});
        expect(report.accounting).toMatchObject({providerCalls:1,sessionCalls:1,nativeUsage:null,paidSpendUsd:null});
        expect(report.gates.nativeDemoProtocolObserved).toBe(false);expect(readinessExitCode(report)).toBe(2);
    });
    it('refuses campaign/provider/key flags before browser or network dispatch',()=>{
        const result=spawnSync(process.execPath,['scripts/coding-agent-launch-readiness.mjs','--launch','--api-key','private'],{encoding:'utf8'});
        expect(result.status).toBe(1);expect(JSON.parse(result.stdout)).toMatchObject({status:'invalid',launchReady:false,liveRunAuthorized:false});
        expect(result.stdout).not.toContain('private');
    });
});
