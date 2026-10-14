import type {StoreApi} from '../../types';
import {createSingleTableDatasetBundle} from '../../../data/datasetBundle';
import {beginSessionTransition,cancelOwnedRun} from '../../../session/sessionOwnership';
import {buildTaskExport} from './piTaskExports';
import {unzipSync,strFromU8} from 'fflate';

/** Operator QA only, in an empty private browser context. No script, answer key or scope is supplied to the model. */
export const runWeightedMedianDemoProbe=async(root:StoreApi)=>{
    if(root.getState().csvData||root.getState().activeExecution)throw new Error('weighted_median_probe_context_not_fresh');
    beginSessionTransition(root);
    const rows=[{Amount:-5,Quantity:2,Unit:'SGD',Date:'2026-10-01'},{Amount:0,Quantity:2,Unit:'SGD',Date:'2026-10-31'},
        {Amount:99,Quantity:100,Unit:'SGD',Date:'2026-09-30'},{Amount:null,Quantity:1,Unit:'SGD',Date:'2026-10-02'},
        {Amount:42,Quantity:0,Unit:'SGD',Date:'2026-10-03'},{Amount:999,Quantity:100,Unit:'SGD',Date:'2026-11-01'}];
    const datasetId=crypto.randomUUID(),data={fileName:'synthetic-weighted-median.csv',data:rows},bundle=createSingleTableDatasetBundle({datasetId,sourceFingerprint:'synthetic',file:{name:data.fileName,size:0,lastModified:0},data});
    root.setState({sessionId:`weighted-median-probe-${crypto.randomUUID()}`,sessionCreatedAt:new Date(),csvData:data,canonicalCsvData:data,rawCsvData:structuredClone(data),
        currentDatasetId:datasetId,datasetBundle:bundle,semanticDatasetVersion:bundle.datasetVersion,analysisCards:[],queryHistory:[],activeDataQuery:null,
        workspaceFiles:{},chatHistory:[],pendingClarification:null,taskInspection:null,columnRegistry:null,
        columnProfiles:[{name:'Amount',type:'number'},{name:'Quantity',type:'number'},{name:'Unit',type:'string'},{name:'Date',type:'date'}] as never,
        dataQualityIssues:[],currentView:'analysis_dashboard',
        settings:{...root.getState().settings,provider:'default',language:'English',reasoningEffort:'low'}});
    const original=JSON.stringify(root.getState().rawCsvData),goal='Calculate the lower weighted median Amount, weighted by Quantity as nonnegative integer frequencies, for October 2026 only. Unit is the measurement unit. Select the first sorted observed value whose cumulative weight is at least half the total; do not average the middle values. Exclude missing Amount/Quantity pairs and account for zero weights. Use an inspectable task-specific JavaScript program and independently validated computation evidence; give the result and reference.';
    try{
        await root.getState().handleChatMessage(goal,{source:'composer'});
        const state=root.getState();let exported:Record<string,unknown>|undefined;
        if(state.activeAgentTask?.status==='completed'){
            const zip=unzipSync((await buildTaskExport(root,state.activeAgentTask.taskId)).bytes);
            exported=Object.fromEntries(Object.entries(zip).filter(([name])=>name.endsWith('.json')||name.endsWith('.js')).map(([name,bytes])=>[name,name.endsWith('.json')?JSON.parse(strFromU8(bytes)):strFromU8(bytes)]));
        }
        return {status:state.activeAgentTask?.status??state.chatLifecycleState,goal,chat:state.chatHistory,task:state.activeAgentTask,inspection:state.taskInspection,
            rawOriginalPreserved:JSON.stringify(state.rawCsvData)===original,rows:state.csvData?.data,exported,pending:state.pendingClarification,
            runtime:state.runtimeRunHistory?.at(-1)};
    }finally{cancelOwnedRun(root);}
};
