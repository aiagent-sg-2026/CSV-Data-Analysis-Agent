import {sha256,json} from './fixtureKit.mjs';

/** Read only the fresh evaluation context. Credentials and operator content never leave the page. */
export const captureBrowserConfiguration=async(page,indexUrl)=>{
  const value=await page.evaluate(async indexUrl=>{
    const store=(await import(indexUrl)).u,state=store.getState(),s=state.settings;
    const known=['provider','geminiApiKey','openAIApiKey','simpleModel','complexModel','fallbackModel','reasoningEffort',
      'language','reportTemplate','autoConfirmGoal','maxAgentTurns','toolOutputCutoff','runtimeAccessControl',
      'enableSearchGrounding','enableVisualEvaluation'];
    const config=window.__CSV_AGENT_CONFIG__??{};
    return {settings:{provider:s.provider,simpleModel:s.simpleModel,complexModel:s.complexModel,
      fallbackModel:s.fallbackModel??null,reasoningEffort:s.reasoningEffort,language:s.language,
      reportTemplate:s.reportTemplate,autoConfirmGoal:s.autoConfirmGoal,maxAgentTurns:s.maxAgentTurns,
      toolOutputCutoff:s.toolOutputCutoff,runtimeAccessControl:s.runtimeAccessControl,
      enableSearchGrounding:s.enableSearchGrounding??false,enableVisualEvaluation:s.enableVisualEvaluation??false},
      credentialsAbsent:!s.geminiApiKey&&!s.openAIApiKey,unknownSettings:Object.keys(s).filter(k=>!known.includes(k)).length,
      forcedModelsAbsent:!config.forceSimpleModel&&!config.forceComplexModel&&!config.forceFallbackModel,
      workspaceEmpty:Object.keys(state.workspaceFiles??{}).length===0,
      dataEmpty:!state.csvData&&!state.datasetBundle,
      conversationEmpty:(state.chatHistory??[]).length===0,
      executionIdle:!state.activeExecution&&!state.activeAgentTask,
      userSkillsAbsent:localStorage.getItem('csv-ai-user-skills-v1')===null,
      disabledSkillsAbsent:localStorage.getItem('csv-ai-disabled-skills-v1')===null,
      externalToolsAbsent:!store.mcpTools};
  },indexUrl);
  return {...value,sha256:sha256(json(value))};
};

// This checks a captured context, not a promise that a later process inherits its state.
export const validateRuntimeCapture=(capture,candidate)=>{
  if(!capture||!candidate)return false;
  const {sha256:digest,...value}=capture;
  const expected={settings:{provider:candidate.provider,simpleModel:candidate.logicalModel,complexModel:candidate.logicalModel,
    fallbackModel:candidate.settings.modelFallback,reasoningEffort:candidate.settings.reasoningEffort,
    language:candidate.settings.language,reportTemplate:'management_review',autoConfirmGoal:true,maxAgentTurns:100,
    toolOutputCutoff:10,runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}},
    enableSearchGrounding:false,enableVisualEvaluation:false},credentialsAbsent:true,unknownSettings:0,forcedModelsAbsent:true,
    workspaceEmpty:true,dataEmpty:true,conversationEmpty:true,executionIdle:true,userSkillsAbsent:true,
    disabledSkillsAbsent:true,externalToolsAbsent:true};
  return digest===sha256(json(value))&&json(value)===json(expected);
};
