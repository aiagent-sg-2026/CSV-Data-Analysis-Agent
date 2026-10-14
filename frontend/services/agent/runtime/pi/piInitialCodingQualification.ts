import {createAssistantMessageEventStream, type AssistantMessage, type JsonObject} from '@earendil-works/pi-ai';
import type {StreamFn} from '@earendil-works/pi-agent-core';
import type {StoreApi} from '../../types';
import {createSingleTableDatasetBundle} from '../../../data/datasetBundle';
import {captureCsvSource} from '../../../data/immutableCsvSource';
import {executeSqlPlanAndCreateCard} from '../../execution/sqlCardExecutor';
import {runPiInitialAnalysis, type PiInitialAnalysisOptions} from './piInitialAnalysisRuntimeService';
import type {CandidateMeaningProposal} from '../../../data/inferredCandidateMeaning';
import {attachAutoAnalysisEvaluationToCards} from '../../autoAnalysisEvaluation';

const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const tool = (name:string, args:unknown):AssistantMessage['content'] => [{type:'toolCall',id:crypto.randomUUID(),name,arguments:args as JsonObject}];

/** Browser QA only: the caller must own an isolated synthetic app/storage context. Models are scripted;
 * execution, inference, validation, exact approval, SQL-card admission and checkpoint publication are real. */
export const preparePiInitialCodingUiSmoke = async (root:StoreApi, options: {
    mode?: 'repair' | 'no-cleaning' | 'wrong-output' | 'missing-report';
    stageServices?: PiInitialAnalysisOptions['stageServices'];
    observe?: (context:Parameters<StreamFn>[1]) => void;
    wrapStream?: (stream:StreamFn)=>StreamFn;
    failFirstProgram?: boolean;
} = {}) => {
    const mode=options.mode ?? 'repair';
    const data={fileName:'synthetic-initial.csv',data:[{Name:'Total Solutions',Amount:0},{Name:'Detail',Amount:-5},...(mode==='no-cleaning'?[]:[{Name:'Subtotal',Amount:-5}])]};
    const file=new File([`Name,Amount\nTotal Solutions,0\nDetail,-5\n${mode==='no-cleaning'?'':'Subtotal,-5\n'}`],data.fileName);
    const datasetId=`initial-synthetic-${crypto.randomUUID()}`;
    const bundle=createSingleTableDatasetBundle({datasetId,sourceFingerprint:'synthetic',file,data});
    const goal='Remove the reconciled subtotal and analyse detail values.';
    root.setState({sessionId:`initial-smoke-${crypto.randomUUID()}`,sessionCreatedAt:new Date(),confirmedAnalysisGoal:goal,
        csvData:data,canonicalCsvData:data,rawCsvData:structuredClone(data),datasetBundle:bundle,currentDatasetId:datasetId,
        datasetCommitBindingStatus:undefined,pendingClarification:null,analysisCards:[],columnProfiles:[],queryHistory:[],activeDataQuery:null,
        workspaceFiles:{},finalSummary:null,finalSummaryProvenance:null,aiCoreAnalysisSummary:null,aiCoreAnalysisSummaryProvenance:null,
        initialAnalysisStatus:'running',isBusy:true,currentView:'analysis_dashboard',
        settings:{...root.getState().settings,provider:'default',simpleModel:'mock',complexModel:'mock',language:'English',
            runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}}});
    const source=await captureCsvSource(root,file);
    root.setState({datasetBundle:{...bundle,source:{...bundle.source,inspection:source}}});
    const proposal:CandidateMeaningProposal={input:{kind:'table',name:'original',tableId:bundle.primaryTableId},
        table:{name:'facts',grain:['Name'],groupBy:[],columns:[
            {name:'Name',sourceColumn:'Name',dataType:'string',nullable:false,conversion:'identity'},
            {name:'Amount',sourceColumn:'Amount',dataType:'number',nullable:false,conversion:'identity',scale:2}],detailRanges:[{start:0,end:1}]},
        exclusions:[{row:2,role:'subtotal'}],assumptions:['Name identifies one detail fact; the final subtotal covers every detail.']};
    const program=`const rows=input.original.rows.slice(0,2).map(r=>({...r}));${mode==='wrong-output'?'rows[0].Amount=999;':''}
        return {schemaVersion:1,complete:true,tables:[{name:'facts',role:'fact',schema:[{name:'Name',dataType:'string',nullable:false},{name:'Amount',dataType:'number',nullable:false}],rowCount:rows.length,rows,
        lineage:rows.flatMap((r,row)=>['Name','Amount'].map(column=>({row,column,origins:[{kind:'table',name:'original',row,column}]})))}],relationships:[],excludedRows:[{origin:{kind:'table',name:'original',row:2},reason:'reconciled subtotal'}]};`;
    let step=0,candidateId='';
    const stream:StreamFn=(model,context)=>{
        options.observe?.(context);
        const last=context.messages.filter(m=>m.role==='toolResult').at(-1);
        let parsed:{payload?:{workspace?:{artifact?:{path:string;revision:number;sha256:string}};
            candidate?:{candidateId:string};candidateValidation?:{decision:string}};receipt?:{jobId:string}} | undefined;
        try { parsed=last?JSON.parse(last.content.filter(p=>p.type==='text').map(p=>p.text).join('')):undefined; } catch { parsed=undefined; }
        let content:AssistantMessage['content'];
        const rawStep=step++,current=options.failFirstProgram&&rawStep>=7?rawStep-2:rawStep;
        if(current<2)content=tool('run_next_analysis_stage',{});
        else if(mode==='no-cleaning')content=tool('run_next_analysis_stage',current===2?{stage:'dataset.validatePreparedData'}:{});
        else if(current===2)content=tool('candidate_infer_meaning',proposal);
        else if(current===3)content=tool('workspace_write',{path:'/workspace/initial.js',expectedRevision:0,content:options.failFirstProgram?'throw new TypeError("evaluation missing field");':program});
        else if(options.failFirstProgram&&rawStep===5)content=tool('workspace_replace',{path:'/workspace/initial.js',expectedRevision:1,oldText:'throw new TypeError("evaluation missing field");',newText:program});
        else if(current===4||options.failFirstProgram&&rawStep===6){
            const artifact=parsed?.payload?.workspace?.artifact;
            content=artifact?tool('code_run',{program:{path:artifact.path,revision:artifact.revision,sha256:artifact.sha256},inputs:[],
                tables:[{name:'original',tableId:bundle.primaryTableId}],output:{path:'/workspace/initial-output.json',expectedRevision:0,format:'json'}}):[{type:'text',text:'Unverified 999 completed.'}];
        }else if(current===5)content=parsed?.receipt?tool('candidate_stage',{jobId:parsed.receipt.jobId}):[{type:'text',text:'Unverified 999 completed.'}];
        else if(current===6){candidateId=parsed?.payload?.candidate?.candidateId ?? '';content=tool('candidate_validate',{candidateId});}
        else if(current===7)content=parsed?.payload?.candidateValidation?.decision==='validated'?tool('candidate_request_approval',{candidateId,primaryTable:'facts'}):[{type:'text',text:'Unverified 999 completed.'}];
        else content=tool('run_next_analysis_stage',{});
        const stopReason=content.some(p=>p.type==='toolCall')?'toolUse':'stop';
        const message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason,timestamp:Date.now()};
        const events=createAssistantMessageEventStream();events.push({type:'start',partial:message});events.push({type:'done',reason:stopReason,message});return events;
    };
    const runtimeOptions:PiInitialAnalysisOptions={codingPreparation:{enabled:true,qualified:true},stageServices:{
            resolveStructure:async()=>({canonicalCsvData:data,canonicalBuildMeta:null,canonicalizationStatus:'ready',
                reportStructureResolution:{requiresHumanReview:false,source:'synthetic',decision:{targetShape:'row_table'},
                    rowInspection:{residualUnknownRowIndexes:[],residualSummaryLikeRowIndexes:mode==='no-cleaning'?[]:[2]}},
                pipelineOutcome:{canAutoAnalyze:true}}) as never,
            runEvidence:async({store})=>{
                const card=await executeSqlPlanAndCreateCard({chartType:'bar',title:'Current detail amounts',description:'Synthetic complete current-version detail.',
                    aggregation:'sum',queryMode:'aggregate',query:{groupBy:['Name'],aggregates:[{function:'sum',column:'Amount',as:'Total'}],
                        orderBy:[{column:'Total',direction:'desc'}],limit:10},bindings:{groupByColumn:'Name',valueColumn:'Total'}},store);
                store.setState(state=>({analysisCards:attachAutoAnalysisEvaluationToCards(state.analysisCards,{columnProfiles:state.columnProfiles})}));
                return {acceptedCardCount:1,session:{status:'completed',acceptedOutputs:[{cardId:card.id}]}} as never;
            },
            generateSummaries:async(store)=>{
                const card=store.getState().analysisCards.at(-1)!;
                if(mode!=='missing-report')store.setState({finalSummary:{language:'English',text:'Synthetic current query: Total Solutions 0; Detail -5.'},finalSummaryProvenance:card.provenance});
            },
            ...options.stageServices,
        }};
    const meteredStream=options.wrapStream?.(stream)??stream;
    const result=await runPiInitialAnalysis({appSessionId:root.getState().sessionId,datasetId,datasetVersion:bundle.datasetVersion,
        researchGoal:goal,provider:{provider:'default',modelId:'mock'}},root,meteredStream,runtimeOptions);
    return {result,file,source,sessionId:root.getState().sessionId,taskId:root.getState().activeAgentTask?.taskId,
        oldRunId:result.runtimeRunId,oldBudget:structuredClone(root.getState().activeAgentTask?.budget),stream:meteredStream,runtimeOptions};
};
