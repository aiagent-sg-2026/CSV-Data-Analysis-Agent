import {json,sha256} from './fixtureKit.mjs';
import {validateRuntimeCapture} from './runtimeCapture.mjs';

const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const model=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(v)&&!/^(dmo_|sk-|gw_)/.test(v)?v:null;

/** A transport response discloses a wire label, not an attested physical deployment or price. */
export const summarizeGatewayReply=(kind,status,payload)=>{
  if(!['session','provider'].includes(kind)||!integer(status)||status<100||status>599)throw new Error('gateway_observation_invalid');
  const value={kind,status,wireModel:model(payload?.model),usage:null,usageStatus:'unknown',
    physicalIdentityDisclosed:Boolean(payload?.resolved_provider&&payload?.resolved_model),
    pricingDisclosed:Boolean(payload?.pricing),serverBoundsDisclosed:Boolean(payload?.limits)};
  if(kind==='provider'){
    const u=payload?.usage;
    if(status===200&&payload?.status==='completed'&&u&&integer(u.input_tokens)&&integer(u.output_tokens)
      &&integer(u.total_tokens)&&u.input_tokens+u.output_tokens===u.total_tokens){
      value.usage={inputTokens:u.input_tokens,outputTokens:u.output_tokens,totalTokens:u.total_tokens};value.usageStatus='observed';
    }
  }
  return value;
};

/** Readiness evidence cannot grant a campaign permission or remove a qualification denominator. */
export const assessLiveReadiness=({manifest,preflight,capture,probe,siteManifestSha256,browserVersion,emptyStorageBefore})=>{
  const qualificationSha256=sha256(json(manifest));
  const bindingValid=preflight?.status==='preflight_complete'&&preflight.qualificationSha256===qualificationSha256
    &&hash(siteManifestSha256)&&manifest?.pins?.deploymentManifest?.sha256===siteManifestSha256;
  const isolated=bindingValid&&emptyStorageBefore===true&&typeof browserVersion==='string'&&browserVersion.length<100
    &&validateRuntimeCapture(capture,manifest.candidate);
  const requests=probe?.requests??[],replies=probe?.replies??[];
  const wire=probe?.mode==='demo_probe'&&probe.failure==null&&probe.outcome==='observed'&&requests.length===2&&replies.length===2
    &&requests.every((r,i)=>r.kind===(i?'provider':'session')&&hash(r.bodySha256)&&integer(r.bodyBytes)
      &&r.maxOutputTokensPresent===false&&r.faultMetadataPresent===false)
    &&replies[0]?.kind==='session'&&[200,201].includes(replies[0].status)&&replies[1]?.kind==='provider'
    &&replies[1].status===200&&replies[1].usageStatus==='observed'&&Boolean(replies[0].wireModel)
    &&replies[0].wireModel===replies[1].wireModel;
  const blockers=[...new Set([...(bindingValid?[]:['qualification_binding_invalid']),
    ...(isolated?[]:['isolated_runtime_configuration_not_captured']),
    ...(probe?.mode==='demo_probe'&&!wire?['demo_protocol_probe_incomplete']:[]),
    'resolved_provider_model_missing','provider_pricing_and_server_bounds_missing',
    'paid_authorization_missing','live_transport_usage_bounds_not_qualified',
    'live_campaign_dispatch_not_enabled','holdout_fault_recovery_not_live_qualified'])];
  return {schemaVersion:1,ticket:'CA-173',status:bindingValid?'blocked':'invalid',launchReady:false,liveRunAuthorized:false,
    capabilityAcceptance:'pending',qualificationSha256,siteManifestSha256,
    gates:{candidateIntegrity:bindingValid,isolatedContextCaptured:isolated,nativeDemoProtocolObserved:wire,
      physicalModelQualified:false,pricingAndServerBoundsQualified:false,campaignAuthorization:false,
      remoteLedgerQualified:false,fullHoldoutQualified:false},launchBlockers:blockers,
    runtime:{browserVersion,emptyStorageBefore,capture:isolated?capture:null,scope:'observed_context_only',
      promptAndToolPolicy:'pinned_source_and_bundle; task-specific serialized schemas require per-run custody',
      replicateSemantics:'independent fresh sessions; seeds identify slots, provider sampling seed is not asserted'},
    probe,accounting:{providerCalls:requests.filter(r=>r.kind==='provider').length,
      sessionCalls:requests.filter(r=>r.kind==='session').length,
      nativeUsage:wire?replies[1].usage:null,billedModel:null,paidSpendUsd:null,evaluatedQualificationRuns:0},
    unchanged:{taskLimits:manifest?.candidate?.settings?.taskLimits,contextCap:manifest?.candidate?.settings?.contextCap,
      compactionTrigger:manifest?.candidate?.settings?.compactionTrigger,plannedRuns:manifest?.schedule?.length,
      thresholds:manifest?.evaluation?.thresholds,proposedCeilings:manifest?.candidate?.proposedCeilings},
    requiredProviderEvidence:{resolvedProvider:null,resolvedModel:null,routingRevision:null,pricingRevision:null,
      inputMicrousdPerMillion:null,outputMicrousdPerMillion:null,maximumBillableInputTokens:null,
      maximumBillableOutputTokens:null,errorAndRetryBilling:null,cancellationBilling:null,
      contract:'authoritative gateway/operator evidence bound to this endpoint and routing revision; client observations are insufficient'}};
};

export const readinessExitCode=report=>report?.status==='ready'&&report.launchReady===true&&report.liveRunAuthorized===true?0:
  report?.status==='blocked'&&report.launchReady===false&&report.liveRunAuthorized===false?2:1;
