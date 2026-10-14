import type { StoreApi } from '../agent/types';
import { beginRun, scopeRunStore } from '../session/sessionOwnership';
import { preparePiExecutor } from '../agent/runtime/pi/piExecutorPreparation';
import { bindCandidateValidationContract } from './candidateValidationBinding';
import type { CandidateValidationContract } from './candidateValidation';

/** Public synthetic qualification only. All programs still pass the actual executor/staging/validator. */
export const stageRecoveryQualificationCandidate = async (root: StoreApi, kind: 'names' | 'multi' | 'stream',
    guest?: Parameters<typeof preparePiExecutor>[1]['guest']) => {
    const bundle=root.getState().datasetBundle!,lease=beginRun(root,'follow_up',`recovery-fixture-${crypto.randomUUID()}`,`recovery-fixture-turn-${crypto.randomUUID()}`),store=scopeRunStore(root,lease);
    const namesSchema=[{name:'Name',dataType:'string' as const,nullable:false}],factsSchema=[...namesSchema,{name:'Amount',dataType:'number' as const,nullable:false}];
    const cells=(row:number,columns:string[],trim=false)=>({cells:columns.map(column=>({column,origin:{kind:'table' as const,name:'input',row,column},
        conversion:trim&&column==='Name'?'trim' as const:'identity' as const}))});
    const goal=kind==='names'?'Produce the explicitly approved name-only reference table.':'Trim the detail, reconcile the subtotal and produce the declared facts and dimensions.';
    const tables:CandidateValidationContract['tables']=kind==='names'?[{name:'names',role:'reference',schema:namesSchema,grain:['Name'],groupBy:[],metrics:[],mutableColumns:[],rows:[0,1].map(row=>cells(row,['Name']))}]
        :[{name:'facts',role:'fact',schema:factsSchema,grain:['Name'],groupBy:[],metrics:[{column:'Amount',scale:2,toleranceMinor:0,unit:'SGD'}],mutableColumns:['Name'],rows:[0,1].map(row=>cells(row,['Name','Amount'],row===1))}];
    if(kind==='multi')tables.push({name:'names',role:'dimension',schema:namesSchema,grain:['Name'],groupBy:[],metrics:[],mutableColumns:['Name'],rows:[0,1].map(row=>cells(row,['Name'],row===1))});
    const relationships=kind==='multi'?[{fromTable:'facts',toTable:'names',fromKeys:['Name'],toKeys:['Name'],cardinality:'one_to_one' as const,maxAmplification:1,requireCoverage:true}]:[];
    root.candidateValidationContract=await bindCandidateValidationContract(root,goal,{version:1,ambiguities:[],tables,relationships,
        exclusions:kind==='names'?[]:[{origin:{kind:'table',name:'input',row:2},role:'subtotal',checks:[{column:'Amount',table:'facts',detailRows:[0,1],metric:'Amount'}]}]});
    const prep=await preparePiExecutor(store,{entryPoint:'follow_up',goal,guest});
    const declaration=JSON.stringify(tables.map(({name,role,schema})=>({name,role,schema}))),relations=JSON.stringify(relationships.map(({maxAmplification:_max,requireCoverage:_coverage,...r})=>r));
    const output=`const defs=${declaration};const all=${kind==='stream'?'input.stream.state':'input.input.rows'};const tables=defs.map(t=>{const rows=all.slice(0,2).map(r=>Object.fromEntries(t.schema.map(c=>[c.name,c.name==='Name'&&${kind!=='names'}?r[c.name].trim():r[c.name]])));return {...t,rowCount:rows.length,rows,lineage:rows.flatMap((r,row)=>t.schema.map(c=>({row,column:c.name,origins:[{kind:'table',name:'input',row,column:c.name}]})))};});const candidate={schemaVersion:1,complete:true,tables,relationships:${relations},excludedRows:${kind==='names'?'[]':'[{origin:{kind:"table",name:"input",row:2},reason:"subtotal"}]'}};`;
    const code=kind==='stream'?`if(input.stream.phase==='batch')return {state:[...input.stream.state,...input.input.rows],rows:[]};${output}return {state:input.stream.state,rows:[candidate]};`
        :`${output}return candidate;`;
    const program=await store.codeExecution!.workspace.write('/workspace/recovery-program.js',code,0);
    const request={program:{path:program.path,revision:program.revision,sha256:program.sha256},inputs:[],tables:[{name:'input',tableId:bundle.primaryTableId}],
        ...(kind==='stream'?{mode:'stateful_stream' as const,stream:{table:'input',batchRows:1,partitionBy:[],initialState:[]}}:{}),
        output:{path:'/workspace/recovery-output.json',expectedRevision:0,format:'json' as const}};
    const context={lease,toolCallId:'recovery-fixture-code',stepId:'recovery-fixture-code'};
    await prep.task.beforeTool('code.run',request,context.toolCallId);
    const execution=await store.codeExecution!.run(request,context);
    prep.task.afterTool('code.run',{status:'success',toolName:'code.run',message:execution.reasonCode,shouldStop:false,artifacts:{codeExecution:execution}},context);
    if(execution.status!=='succeeded')throw new Error(execution.reasonCode);
    const candidate=await store.candidateStaging!.stage(execution.jobId,{lease,toolCallId:'recovery-fixture-stage',stepId:'recovery-fixture-stage'});
    const validation=await store.candidateStaging!.validate(candidate.candidateId,{lease,toolCallId:'recovery-fixture-validate',stepId:'recovery-fixture-validate'});
    if(validation.decision!=='validated')throw new Error(validation.reasonCodes.join(','));
    return {store,lease,prep,candidate,validation,execution};
};
