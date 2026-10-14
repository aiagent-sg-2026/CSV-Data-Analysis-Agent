import {resolveAnswerScope} from '../agent/runtime/pi/queryEvidence';
import type { StoreApi } from '../agent/types';
import { beginRun, scopeRunStore, finishRun, beginSessionTransition, cancelOwnedRun } from '../session/sessionOwnership';
import { preparePiExecutor } from '../agent/runtime/pi/piExecutorPreparation';
import { createSingleTableDatasetBundle } from './datasetBundle';
import { bindCandidateValidationContract } from './candidateValidationBinding';
import { captureCsvSource } from './immutableCsvSource';
import type {CsvData,DatasetColumnSchema} from '../../types';

/** Public synthetic fixture only; shared executor and native guest remain the actual execution path. */
export const prepareCandidateCommitFixture = async (options: {
    queryUnderstandingArtifact?: import('../agent/runtime/intentClassificationTypes').QueryUnderstandingArtifact;
    guest?: Parameters<typeof preparePiExecutor>[1]['guest']; root?: StoreApi; sessionId?: string; signal?: AbortSignal;
    weightedMedian?: boolean;
} = {}) => {
    const data:CsvData={fileName:'synthetic-commit.csv',data:options.weightedMedian
        ?[{Name:'Total Solutions',Amount:0,Quantity:2},{Name:' Detail ',Amount:-5,Quantity:2},{Name:'Subtotal',Amount:-5,Quantity:4}]
        :[{Name:'Total Solutions',Amount:0},{Name:' Detail ',Amount:-5},{Name:'Subtotal',Amount:-5}]};
    const bundle=createSingleTableDatasetBundle({datasetId:`synthetic-${crypto.randomUUID()}`,sourceFingerprint:'synthetic',file:{name:data.fileName,size:0,lastModified:0},data});
    const seed={sessionId:options.sessionId??`commit-lab-${crypto.randomUUID()}`,sessionCreatedAt:new Date(),csvData:data,canonicalCsvData:data,
        rawCsvData:structuredClone(data),datasetBundle:bundle,datasetCommitBindingStatus:undefined,columnProfiles:[],analysisCards:[],activeDataQuery:null,
        workspaceFiles:{},initialAnalysisStatus:'completed',settings:{language:'English',runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}}};
    let state=seed as unknown as ReturnType<StoreApi['getState']>;
    const root=options.root??{getState:()=>state,setState:(p)=>{state={...state,...(typeof p==='function'?p(state):p)};}} satisfies StoreApi;
    if(options.root) root.setState({...seed,settings:{...root.getState().settings,...seed.settings}} as Partial<ReturnType<StoreApi['getState']>>);
    const goal='Trim the approved detail name and remove the reconciled subtotal. Preserve other facts.'
        +(options.weightedMedian?' Then calculate the lower weighted median Amount weighted by Quantity from the committed facts.':'');
    const lease=beginRun(root,'follow_up',`commit-run-${crypto.randomUUID()}`,'commit-turn'),store=scopeRunStore(root,lease);
    const abort=()=>cancelOwnedRun(root);options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    let prep: Awaited<ReturnType<typeof preparePiExecutor>> | undefined;
    const cleanup=()=>{options.signal?.removeEventListener('abort',abort);prep?.task.close('cancelled');finishRun(root,lease);beginSessionTransition(root);};
    try {
    const columns=Object.keys(data.data[0]);
    const source=await captureCsvSource(store,new File([`${columns.join(',')}\n${data.data.map(r=>columns.map(c=>r[c]).join(',')).join('\n')}\n`],data.fileName));
    root.setState({datasetBundle:{...bundle,source:{...bundle.source,inspection:source}}});
    const schema:DatasetColumnSchema[]=[{name:'Name',dataType:'string',nullable:false},{name:'Amount',dataType:'number',nullable:false},
        ...(options.weightedMedian?[{name:'Quantity',dataType:'number' as const,nullable:false}]:[])];
    root.candidateValidationContract=await bindCandidateValidationContract(root,goal,{version:1,ambiguities:[],tables:[{
        name:'facts',role:'fact',schema,grain:['Name'],groupBy:[],metrics:[{column:'Amount',scale:2,toleranceMinor:0,unit:'SGD'},
            ...(options.weightedMedian?[{column:'Quantity',scale:0,toleranceMinor:0,unit:'frequency'}]:[])],mutableColumns:['Name'],
        rows:[0,1].map(row=>({cells:columns.map(column=>({column,origin:{kind:'table',name:'input',row,column},conversion:column==='Name'&&row===1?'trim':'identity'}))}))
    }],relationships:[],exclusions:[{origin:{kind:'table',name:'input',row:2},role:'subtotal',checks:columns.filter(c=>c!=='Name').map(column=>({column,table:'facts',detailRows:[0,1],metric:column}))}]});
    prep=await preparePiExecutor(store,{entryPoint:'follow_up',goal,guest:options.guest});
    if(options.queryUnderstandingArtifact)await prep.task.resolveScope(resolveAnswerScope(goal,options.queryUnderstandingArtifact,undefined,store));
    const program=await store.codeExecution!.workspace.write('/workspace/program.js',`const rows=input.input.rows.slice(0,2).map(r=>({...r,Name:r.Name.trim()}));return {schemaVersion:1,complete:true,tables:[{name:'facts',role:'fact',schema:${JSON.stringify(schema)},rowCount:rows.length,rows,lineage:rows.flatMap((r,row)=>${JSON.stringify(columns)}.map(column=>({row,column,origins:[{kind:'table',name:'input',row,column}]})))}],relationships:[],excludedRows:[{origin:{kind:'table',name:'input',row:2},reason:'subtotal'}]};`,0);
    const request={program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],tables:[{name:'input',tableId:bundle.primaryTableId}],output:{path:'/workspace/output.json',expectedRevision:0,format:'json' as const}};
    const codeContext={lease,toolCallId:'qualification-code',stepId:'qualification-code'};
    await prep.task.beforeTool('code.run',request,codeContext.toolCallId);
    const execution=await store.codeExecution!.run(request,codeContext);
    prep.task.afterTool('code.run',{status:'success',toolName:'code.run',message:execution.reasonCode,shouldStop:false,artifacts:{codeExecution:execution}},codeContext);
    if(execution.status!=='succeeded')throw new Error(execution.reasonCode);
    const candidate=await store.candidateStaging!.stage(execution.jobId,{lease,toolCallId:'qualification-stage',stepId:'qualification-stage'});
    const validation=await store.candidateStaging!.validate(candidate.candidateId,{lease,toolCallId:'qualification-validate',stepId:'qualification-validate'});
    if(validation.decision!=='validated')throw new Error(validation.reasonCodes.join(','));
    return {root,store,lease,prep,program,candidate,validation,execution,source,
        cleanup};
    } catch(error) {cleanup();throw error;}
};
