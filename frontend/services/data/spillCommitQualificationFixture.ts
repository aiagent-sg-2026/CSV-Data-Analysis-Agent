import type { StoreApi } from '../agent/types';
import type { CsvData } from '../../types';
import { beginRun,scopeRunStore,finishRun,beginSessionTransition } from '../session/sessionOwnership';
import { resolveAnswerScope } from '../agent/runtime/pi/queryEvidence';
import { preparePiExecutor } from '../agent/runtime/pi/piExecutorPreparation';
import { createSingleTableDatasetBundle } from './datasetBundle';
import { CsvStreamScanner,type CsvRecordSpan } from './csvStreamScanner';
import { registerScannedCsvBlob } from './immutableCsvSource';
import { bindSpillCandidateValidationContract } from './spillCandidateValidation';
import type { CandidateSpillFactory } from './candidateSpill';

/** Synthetic trusted-supported meaning only; uses the production task/guest/staging/approval services. */
export const prepareSpillCommitFixture=async(options:{file:File;root?:StoreApi;guest?:Parameters<typeof preparePiExecutor>[1]['guest'];spillFactory?:CandidateSpillFactory;scale?:number})=>{
    const data:CsvData={fileName:options.file.name,data:[{key:'0',payload:'preview only',value:0}]};
    const bundle=createSingleTableDatasetBundle({datasetId:`spill-lab-${crypto.randomUUID()}`,sourceFingerprint:'pending',file:options.file,data});
    const seed={sessionId:`spill-commit-lab-${crypto.randomUUID()}`,sessionCreatedAt:new Date(),csvData:data,canonicalCsvData:data,rawCsvData:null,
        datasetBundle:bundle,datasetCommitBindingStatus:undefined,columnProfiles:[],analysisCards:[],activeDataQuery:null,workspaceFiles:{},
        initialAnalysisStatus:'completed',settings:{language:'English',runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}}};
    let state=seed as unknown as ReturnType<StoreApi['getState']>;
    const root=options.root??{getState:()=>state,setState:p=>{state={...state,...(typeof p==='function'?p(state):p)};}} satisfies StoreApi;
    if(options.root)root.setState({...seed,settings:{...root.getState().settings,...seed.settings}} as Partial<ReturnType<StoreApi['getState']>>);
    const lease=beginRun(root,'follow_up',`spill-commit-run-${crypto.randomUUID()}`,'spill-commit-turn'),store=scopeRunStore(root,lease);
    let prep:Awaited<ReturnType<typeof preparePiExecutor>>|undefined;
    try{
        const reads={count:0,bytes:0,maxBytes:0,fullReads:0},file=options.file;
        const guard=(blob:Blob,original:boolean):Blob=>{
            const slice=blob.slice.bind(blob),arrayBuffer=blob.arrayBuffer.bind(blob);
            Object.defineProperty(blob,'slice',{configurable:true,value:(start?:number,end?:number)=>guard(slice(start,end),false)});
            Object.defineProperty(blob,'arrayBuffer',{configurable:true,value:async()=>{
                if(original||blob.size>65536){reads.fullReads++;throw new Error('qualification_unbounded_blob_read');}
                reads.count++;reads.bytes+=blob.size;reads.maxBytes=Math.max(reads.maxBytes,blob.size);return arrayBuffer();
            }});return blob;
        };guard(file,true);
        const spans:CsvRecordSpan[]=[];let last=-512*1024;
        const scan=await new CsvStreamScanner(file,{delimiter:',',onRecord:s=>{if(s.row%1024===0||s.start-last>=512*1024){spans.push(s);last=s.start;}}}).run();
        if(scan.parsingCoverage!=='complete'||!scan.sha256)throw new Error('qualification_scan_failed');
        const source={sourceId:crypto.randomUUID(),sha256:scan.sha256,byteSize:file.size,fileName:file.name,recordCount:scan.rows,dialect:{delimiter:',',quoteChar:'"'},diagnostics:[]};
        root.setState({datasetBundle:{...bundle,source:{...bundle.source,inspection:source}}});registerScannedCsvBlob(store,file,source,spans);
        const goal='Validate all original records under the supported host-declared source-record grain. Request exact approval; never publish a draft as accepted.';
        root.candidateValidationContract=await bindSpillCandidateValidationContract(store,goal,{version:1,kind:'ordered-source-records',table:'records',grain:'source_record',headerRow:0,summary:'none',
            columns:[{name:'key',sourceColumn:0,conversion:'identity'},{name:'payload',sourceColumn:1,conversion:'identity'},{name:'value',sourceColumn:2,conversion:'decimal',scale:options.scale??0,unit:options.scale?'SGD':'count'}]});
        // The normal preparation path owns budgets, grants and run retirement.
        prep=await preparePiExecutor(store,{entryPoint:'follow_up',goal,guest:options.guest,spillFactory:options.spillFactory});
        await prep.task.resolveScope(resolveAnswerScope(goal,undefined,undefined,store));
        const program=await store.codeExecution!.workspace.write('/workspace/spill-repair.js','return {state:{},rows:input.records.map(r=>({sourceRow:r.sourceRow,cells:r.cells.slice(0,3)}))};',0);
        const request={program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],mode:'source_records' as const,
            sourceRecords:{sourceId:source.sourceId,sha256:source.sha256,width:3,initialState:{}},output:{path:'/workspace/spill-output.json',expectedRevision:0,format:'json' as const}};
        const context={lease,toolCallId:'spill-qualification-code',stepId:'spill-qualification-code'};
        await prep.task.beforeTool('code.run',request,context.toolCallId);
        const execution=await store.codeExecution!.run(request,context);
        prep.task.afterTool('code.run',{status:'success',toolName:'code.run',message:execution.reasonCode,shouldStop:false,artifacts:{codeExecution:execution}},context);
        if(execution.status!=='succeeded')throw new Error(execution.reasonCode);
        const candidate=await store.candidateStaging!.stage(execution.jobId,{lease,toolCallId:'spill-stage',stepId:'spill-stage'});
        const validation=await store.candidateStaging!.validate(candidate.candidateId,{lease,toolCallId:'spill-validate',stepId:'spill-validate'});
        if(validation.decision!=='validated')throw new Error(validation.reasonCodes.join(','));
        return {root,store,lease,prep,candidate,validation,execution,source,reads,cleanup:()=>{prep?.task.close('cancelled');finishRun(root,lease);beginSessionTransition(root);}};
    }catch(e){prep?.task.close('cancelled');finishRun(root,lease);beginSessionTransition(root);throw e;}
};
