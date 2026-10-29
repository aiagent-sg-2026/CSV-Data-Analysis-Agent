import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { StoreApi } from '../../services/agent/types';
import { createSingleTableDatasetBundle } from '../../services/data/datasetBundle';
import { captureCsvSource } from '../../services/data/immutableCsvSource';
import { parseCsvTextWithDetection } from '../../services/data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../../services/data/reportCsvIntake';
import { scanCsvSourceForImport, bindCsvSourceScan } from '../../services/data/csvSourceScan';
import { compileDualGrainCandidateMeaning, type DualGrainCandidateMeaning, type DualGrainMeaningAlternatives } from '../../services/data/dualGrainCandidateMeaning';

/** Fictional compressed repeated headers. The non-expanded descriptor associations remain
 * genuinely ambiguous AFTER selecting the metric header group. No customer data. */
export const bridgeFixture = (headerChoice: 'A' | 'B' = 'A') => {
    const raw=[['Entity','North','South','North','South'],['Count','Rate','Count','Rate'],['id-a','1','2','3','4','left-a','right-a'],['id-b','5','6','7','8','left-b','right-b']];
    const col=(name:string,row:number,column:number)=>({name,dataType:'string' as const,nullable:false,conversion:'identity' as const,header:{row,column}});
    const meaning: DualGrainCandidateMeaning={input:{kind:'source',name:'original'},tables:[
        {name:'entities',grain:['Entity'],groupBy:[],columns:[col('Entity',0,0),col('North',0,1),col('South',0,2)],detailRanges:[{start:2,end:3}],
            projections:[[{column:'Entity',sourceColumn:0},{column:'North',sourceColumn:5},{column:'South',sourceColumn:6}]]},
        {name:'metrics',grain:['Entity','North','Count'],groupBy:['North','Count'],columns:[col('Entity',0,0),col('North',0,1),col('Count',1,0),col('Rate',1,1)],detailRanges:[{start:2,end:3}],
            projections:Array.from({length:4},(_,i)=>[{column:'Entity',sourceColumn:0},{column:'North',sourceRow:0,sourceColumn:1+Math.floor(i/2)},
                {column:'Count',sourceRow:1,sourceColumn:i},{column:'Rate',sourceColumn:1+i}])}],
        relationships:[{fromTable:'metrics',toTable:'entities',fromKeys:['Entity'],toKeys:['Entity'],cardinality:'many_to_one'}],
        exclusions:[{row:0,role:'header'},{row:1,role:'header'}],assumptions:['Metric header coordinates are fixed; metric text is preserved without numeric units. Non-expanded descriptor association still requires full human meaning approval.']};
    if(headerChoice==='B'){
        meaning.tables[0].projections[0][1].sourceColumn=1;meaning.tables[0].projections[0][2].sourceColumn=2;
        for(const projection of meaning.tables[1].projections){projection[1].sourceColumn+=2;projection[3].sourceColumn+=2;}
    }
    const alternative=structuredClone(meaning);
    [alternative.tables[0].projections[0][1].sourceColumn,alternative.tables[0].projections[0][2].sourceColumn]=[meaning.tables[0].projections[0][2].sourceColumn,meaning.tables[0].projections[0][1].sourceColumn];
    const proposal: DualGrainMeaningAlternatives={input:meaning.input,interpretations:[
        {label:'A: non-expanded descriptor 1 belongs to North, descriptor 2 to South',meaning},
        {label:'B: non-expanded descriptor 1 belongs to South, descriptor 2 to North',meaning:alternative}],assumptions:['The repeated metric header mapping is fixed. Non-expanded descriptor association still requires a complete meaning choice.']};
    for(const i of proposal.interpretations)compileDualGrainCandidateMeaning(i.meaning,{tables:{},sources:{original:raw}});
    return {raw,proposal,text:raw.map(r=>r.map(v=>JSON.stringify(v)).join(',')).join('\r\n')};
};
const program=(p:DualGrainCandidateMeaning,fault?:string)=>`
const bytes=input.original.bytes;let text='';for(const byte of bytes)text+=String.fromCharCode(byte);
const records=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(value);value='';}else if((c==='\\r'||c==='\\n')&&!quoted){if(c==='\\r'&&text[i+1]==='\\n')i++;row.push(value);records.push(row);row=[];value='';}else value+=c;}row.push(value);records.push(row);
const p=${JSON.stringify(p)};const tables=p.tables.map(t=>{const rows=[],lineage=[];for(const range of t.detailRanges)for(let sourceRow=range.start;sourceRow<=range.end;sourceRow++)for(const projection of t.projections){const out={},index=rows.length;for(const c of t.columns){const m=projection.find(m=>m.column===c.name),r=m.sourceRow===undefined?sourceRow:m.sourceRow;out[c.name]=records[r][m.sourceColumn];lineage.push({row:index,column:c.name,origins:[{kind:'source',name:'original',row:r,column:m.sourceColumn}]});}rows.push(out);}return {name:t.name,role:'fact',schema:t.columns.map(({name,dataType,nullable})=>({name,dataType,nullable})),rowCount:rows.length,rows,lineage};});
${fault==='value'?"tables[1].rows[0].Rate='CORRUPTED';":''}
return {schemaVersion:1,complete:true,tables,relationships:p.relationships,excludedRows:p.exclusions.map(e=>({origin:{kind:'source',name:'original',row:e.row},reason:e.role}))};`;
export const prepareBridgeFixture = async (root:StoreApi,fault?:string,headerChoice: 'A' | 'B' = 'A') => {
    const f=bridgeFixture(headerChoice),file=new File([f.text],'fictional-header-bridge.csv'),parsed=parseCsvTextWithDetection(f.text),ir=buildReportIntakeIr(file.name,parsed.rawRows,parsed.detection),data=buildCsvDataFromIntakeIr(ir);
    const datasetId=crypto.randomUUID(),goal='Review both complete meanings of the non-expanded descriptors, independently validate the exact candidate, and ask separately before Dataset Commit.';
    const bundle=createSingleTableDatasetBundle({datasetId,sourceFingerprint:'pending',file,data});
    root.setState({sessionId:crypto.randomUUID(),sessionCreatedAt:new Date(),confirmedAnalysisGoal:goal,goalState:'confirmed',csvData:data,rawCsvData:structuredClone(data),canonicalCsvData:null,rawIntakeIr:ir,datasetBundle:bundle,currentDatasetId:datasetId,
        currentView:'analysis_dashboard',pipelineOutcome:{canAutoAnalyze:false,reasonCode:'header_shape_drift'} as never,pendingClarification:null,candidateRecovery:null,analysisCards:[],columnProfiles:[],queryHistory:[],workspaceFiles:{},isBusy:false,activeExecution:null,
        settings:{...root.getState().settings,provider:'default',simpleModel:'mock',complexModel:'mock',language:'English',runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}}});
    const source=await captureCsvSource(root,file);root.setState({datasetBundle:{...bundle,source:{...bundle.source,inspection:source}}});await scanCsvSourceForImport(root,file);bindCsvSourceScan(root,file,source);
    let step=0,candidateId='',headerRead=false;const trace:string[]=[];
    const stream:StreamFn=async(model,context)=>{
        const last=context.messages.filter(m=>m.role==='toolResult').at(-1),text=last?.content.filter(p=>p.type==='text').map(p=>p.text).join('')??'';
        if(last)trace.push(`${last.toolName}: ${text}`);let v:Record<string,any>={};try{v=JSON.parse(text);}catch{/* refusal remains in trace */}
        const confirmed=root.getState().workspaceFiles['/intake/meaning-confirmation.json'];if(!last&&confirmed)step=1;
        const selected=confirmed?JSON.parse(confirmed).proposal:f.proposal;
        const call=(name:string,args:unknown):AssistantMessage['content']=>[{type:'toolCall',id:crypto.randomUUID(),name,arguments:args as JsonObject}];let content:AssistantMessage['content'];
        if(!headerRead){headerRead=true;content=call('workspace_read',{path:'/intake/confirmed-header-alignment.json'});}
        else if(root.getState().datasetBundle?.acceptedCommit){trace.push('post_commit_analysis_requested');content=call('run_next_analysis_stage',{});}
        else if(step===0){step++;content=call('candidate_infer_meaning',f.proposal);}
        else if(step===1&&confirmed){step++;content=call('candidate_infer_meaning',selected);}
        else if(step===2){step++;content=call('workspace_write',{path:'/workspace/header-bridge.js',expectedRevision:0,content:program(selected,fault)});}
        else if(step===3){step++;const a=v.payload?.workspace?.artifact;content=call('code_run',{program:a&&{path:a.path,revision:a.revision,sha256:a.sha256},inputs:[],sources:[{name:'original',sourceId:source.sourceId,sha256:source.sha256,offset:0,length:source.byteSize}],output:{path:'/workspace/header-bridge.json',expectedRevision:0,format:'json'}});}
        else if(step===4){step++;content=call('candidate_stage',{jobId:v.receipt?.jobId});}
        else if(step===5){step++;candidateId=v.taskPlan?.candidateId??v.payload?.candidate?.candidateId??'';content=call('candidate_validate',{candidateId});}
        else if(step===6){step++;content=call('candidate_request_approval',{candidateId,primaryTable:'entities'});}
        else content=[{type:'text',text:'No further synthetic actions. Dataset Commit remains a separate human decision.'}];
        const message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:content[0].type==='toolCall'?'toolUse':'stop',timestamp:Date.now()};
        const events=createAssistantMessageEventStream();events.push({type:'start',partial:message});events.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});return events;
    };
    return {f,source,stream,trace,data};
};
