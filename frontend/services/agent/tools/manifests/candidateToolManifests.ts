import type {ToolManifest} from '../../../../types';
export const validateCandidateArgs=(name:string,args:Record<string,unknown>)=>{
    const keys=name==='candidate.request_approval'?['candidateId','primaryTable']:name==='candidate.stage'?['jobId']:name==='candidate.diff'?['candidateId','againstId']:name==='candidate.read'?['candidateId','table','offset','limit']:['candidateId'];
    const required=name==='candidate.stage'?'jobId':'candidateId';
    return Boolean(args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).every(k=>keys.includes(k))
        &&typeof args[required]==='string'&&(args[required] as string).length>0&&(args[required] as string).length<=80
        &&(name!=='candidate.request_approval'||typeof args.primaryTable==='string'&&args.primaryTable.length>0&&args.primaryTable.length<=240)
        &&(args.againstId===undefined||typeof args.againstId==='string'&&args.againstId.length>0&&args.againstId.length<=80)
        &&(args.table===undefined||typeof args.table==='string'&&args.table.length>0&&args.table.length<=240)
        &&(args.offset===undefined||Number.isSafeInteger(args.offset)&&Number(args.offset)>=0)
        &&(args.limit===undefined||Number.isSafeInteger(args.limit)&&Number(args.limit)>=1&&Number(args.limit)<=20));
};
export const createCandidateToolManifests=():ToolManifest[]=>['candidate.stage','candidate.read','candidate.diff','candidate.abandon','candidate.validate','candidate.request_approval'].map(tool=>{
    const name=tool as ToolManifest['name'],required=name==='candidate.stage'?'jobId':'candidateId';
    const properties:Record<string,unknown>={[required]:{type:'string',minLength:1,maxLength:80}};
    if(name==='candidate.read')Object.assign(properties,{table:{type:'string',minLength:1,maxLength:240},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20}});
    if(name==='candidate.request_approval')properties.primaryTable={type:'string',minLength:1,maxLength:240};
    if(name==='candidate.diff')properties.againstId={type:'string',minLength:1,maxLength:80};
    return {name,category:'workspace',risk:'low',enabledByDefault:true,groups:[name==='candidate.stage'||name==='candidate.abandon'?'code.execute':'code.inspect'],requiresCleaningCompleted:false,
        description:name==='candidate.request_approval'?'Request human review of an independently validated candidate with an explicit primaryTable. Suspends this task, then exact approval resumes under a fresh lease and requires fresh evidence on the committed version: code_run plus computation_validate for a computation scope, otherwise data_query. This tool cannot approve or commit.':name==='candidate.stage'?'Materialize an immutable, unvalidated dataset candidate from one successful current owned code.run job. Does not change accepted data or answer evidence.'
            :name==='candidate.validate'?'Independently validate the exact candidate against a captured host contract. Missing or ambiguous meaning blocks completion without user semantic confirmation. Infer and host-check meaning before code.run; never commits accepted data or supplies answer evidence.'
            :name==='candidate.read'?'Inspect candidate metadata or a bounded named table row/cell-lineage range.'
            :name==='candidate.diff'?'Inspect candidate structural and bounded value differences against its immutable inputs or another current candidate.'
            :'Abandon exact candidate scratch in the captured namespace. Execution/program artifacts and accepted data are preserved.',
        promptHints:name==='candidate.stage'?[
            'The code output must be JSON {schemaVersion:1,complete:true,tables:[{name,role,schema:[{name,dataType,nullable}],rowCount,rows,lineage:[{row,column,origins:[{kind:"table",name,row,column} or {kind:"source",name,row,column:number}]}]}],relationships:[{fromTable,toTable,fromKeys,toKeys,cardinality}],excludedRows:[{origin:{kind,name,row},reason}]}. Table names refer to candidate tables; origin names refer to exact code.run input tables/sources. Row indices start at zero. Include every output cell, account for every input row through mappings or explicit exclusions. Raw source inputs must cover the complete source bytes; bounded snippets cannot stage a dataset.',
            'Only an owned jobId is accepted. Host binds task goal/scope, session/run, program/environment/output and SHA-256 digests. Declared lineage, types, subtotal reasons, grain and relationships still require independent validation; no commit capability is supplied.',
            'For stateful_stream, emit exactly one complete candidate envelope in finish rows; other steps emit empty rows. Multiple envelopes or bare streamed data rows are refused. Existing carry/output limits still apply.',
        ]:[],resultShape:'Candidate reference or host validation receipt with decision/reasons and SHA-256 bindings. answerEvidence=false; no commit.',
        isAvailable:c=>c.hasCodeExecution?{available:true}:{available:false,reason:'A host-owned task executor is required.'},
        inputSchema:{type:'object',additionalProperties:false,required:name==='candidate.request_approval'?[required,'primaryTable']:[required],properties},validate:args=>validateCandidateArgs(name,args)?[]:['Invalid owned candidate locator/range.'],
    };
});
