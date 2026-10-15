import type {StoreApi} from '../../types';
import {captureCsvSource} from '../../../data/immutableCsvSource';
import {parseCsvTextWithDetection} from '../../../data/csvDialectDetector';
import {buildReportIntakeIr,buildCsvDataFromIntakeIr} from '../../../data/reportCsvIntake';
import {createSingleTableDatasetBundle} from '../../../data/datasetBundle';
import {beginSessionTransition,cancelOwnedRun} from '../../../session/sessionOwnership';
import {inspectPiCandidateReview} from './piCandidateReviewState';
import {buildTaskExport} from './piTaskExports';
import {readExactCommit} from '../../../data/datasetRecoveryActions';
import {getStorageDatabase} from '../../../storageService';
import {installEvaluationFaults,type EvaluationFaultPolicy} from '../../../sandbox/evaluationFaults';
import {unzipSync,strFromU8} from 'fflate';

/** Operator QA in a fresh private context. Only frozen agent files enter the normal live Chatbox. */
export const runRepairComputationDemoProbe=async(root:StoreApi,files:Array<{name:string;bytes:number[]}>,faultPolicy?:EvaluationFaultPolicy)=>{
    if(root.getState().csvData||root.getState().activeExecution||files.length!==2)throw new Error('repair_probe_context_not_fresh');
    const taskFile=files.find(f=>f.name==='task.json');
    const task=taskFile&&JSON.parse(new TextDecoder().decode(new Uint8Array(taskFile.bytes))) as {goal:string;inputFiles:string[];outputContract:unknown}|undefined;
    if(!task||typeof task.goal!=='string'||task.inputFiles.length!==1)throw new Error('repair_probe_task_invalid');
    const csv=files.find(f=>f.name===task.inputFiles[0]);
    if(!csv||!csv.name.endsWith('.csv')||csv.bytes.length>8*1024*1024)throw new Error('repair_probe_csv_invalid');
    beginSessionTransition(root);
    root.setState({sessionId:`repair-probe-${crypto.randomUUID()}`,sessionCreatedAt:new Date(),analysisCards:[],queryHistory:[],activeDataQuery:null,
        chatHistory:[],workspaceFiles:{},columnProfiles:[],columnRegistry:null,dataQualityIssues:[],pendingClarification:null,taskInspection:null,
        settings:{...root.getState().settings,provider:'default',language:'English',reasoningEffort:'low'}});
    const file=new File([new Uint8Array(csv.bytes)],csv.name),parsed=parseCsvTextWithDetection(await file.text());
    const ir=buildReportIntakeIr(file.name,parsed.rawRows,parsed.detection),data=buildCsvDataFromIntakeIr(ir),source=await captureCsvSource(root,file);
    const datasetId=crypto.randomUUID(),bundle=createSingleTableDatasetBundle({datasetId,sourceFingerprint:source.sha256,file,data});
    bundle.source={...bundle.source,inspection:source};
    root.setState({csvData:data,rawCsvData:structuredClone(data),canonicalCsvData:data,rawIntakeIr:ir,datasetBundle:bundle,currentDatasetId:datasetId,
        semanticDatasetVersion:bundle.datasetVersion,columnProfiles:bundle.tables[0].schema.map(c=>({name:c.name,type:c.dataType})) as never,currentView:'analysis_dashboard'});
    const original=JSON.stringify(root.getState().rawCsvData),goal=`${task.goal}\nRequired output contract: ${JSON.stringify(task.outputContract)}\nUse inspectable task-specific JavaScript and the existing candidate validation/approval path for repairs.`;
    const approvals=[];
    const faults=faultPolicy?installEvaluationFaults(root,faultPolicy):undefined;
    try{
        await root.getState().handleChatMessage(goal,{source:'composer'});
        // The operator explicitly authorized this public synthetic exact-approval test. Use the same action as the UI.
        const pending=root.getState().pendingClarification,review=inspectPiCandidateReview(root,pending);
        if(pending?.resumeContext?.piCandidateApproval&&review.available){
            const before=root.getState();
            const approval={review:review.review,taskId:before.activeAgentTask?.taskId,oldRunId:before.taskInspection?.runId,
                leaseReleased:!before.activeExecution,versionBefore:before.datasetBundle?.datasetVersion,budgetBefore:structuredClone(before.activeAgentTask?.budget)};
            await root.getState().handleClarificationResponse({label:'Approve',value:'approve'});
            const after=root.getState(),marker=after.datasetBundle?.acceptedCommit
                ?await readExactCommit(await getStorageDatabase(),after.datasetBundle.acceptedCommit):undefined;
            approvals.push({...approval,freshRunId:after.taskInspection?.runId,taskIdAfter:after.activeAgentTask?.taskId,
                versionAfter:after.datasetBundle?.datasetVersion,budgetAfter:after.activeAgentTask?.budget,commit:after.datasetBundle?.acceptedCommit,
                commitProof:marker?{candidateId:marker.candidateId,approval:marker.approval,audit:marker.audit,programSha256:marker.program.sha256,
                    validationDigest:marker.validation.receiptDigest,inputBindings:marker.inputBindings,outputBindings:marker.outputBindings}:null});
        }
        const state=root.getState();let exported:Record<string,unknown>|undefined;
        if(state.activeAgentTask?.status==='completed'){
            const zip=unzipSync((await buildTaskExport(root,state.activeAgentTask.taskId)).bytes);
            exported=Object.fromEntries(Object.entries(zip).filter(([name])=>name.endsWith('.json')||name.endsWith('.js')).map(([name,bytes])=>[name,name.endsWith('.json')?JSON.parse(strFromU8(bytes)):strFromU8(bytes)]));
        }
        return {status:state.activeAgentTask?.status==='completed'?'completed':state.pendingClarification?'blocked':state.activeAgentTask?.status??'failed',
            goal,chat:state.chatHistory,task:state.activeAgentTask,inspection:state.taskInspection,pending:state.pendingClarification?.interactionKind??null,
            rows:state.canonicalCsvData?.data??[],rawOriginalPreserved:JSON.stringify(state.rawCsvData)===original,sourceHashes:[{name:file.name,sha256:source.sha256}],
            ...(faults?{faultEvidence:faults.snapshot()}:{}),
            approvedCount:approvals.length,approvals,acceptedCommit:state.datasetBundle?.acceptedCommit??null,exported,runtime:state.runtimeRunHistory};
    }finally{faults?.dispose();cancelOwnedRun(root);}
};
