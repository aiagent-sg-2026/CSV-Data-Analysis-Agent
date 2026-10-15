import {randomUUID} from 'node:crypto';
import Papa from 'papaparse';

/** Local HTTP fixture only. Inputs are frozen agent files; no oracle, expected answer or fault schedule is read. */
export const createScopeRepairMock=files=>{
    const csv=Buffer.from(files.find(file=>file.name==='input.csv').bytes).toString(),parsed=Papa.parse(csv,{header:true,skipEmptyLines:true});
    const columns=parsed.meta.fields,model='demo-auto';let step=0;
    if(!columns?.includes('amount_minor')||!columns.includes('quantity'))throw new Error('scope_mock_input_invalid');
    const schema=columns.map(name=>({name,dataType:['amount_minor','quantity'].includes(name)?'number':name==='date'?'date':'string',nullable:false}));
    const classification={intent:'data_query',confidence:'high',taskSignal:'statistical',expectedOutput:'scalar_answer',referencedColumns:columns,aggregationFunctions:[],groupingColumns:[],
        filterDescription:'Entire input after canonical repair; preserve zeros, losses, units and excluded-record accounting.',requestedDataPreparation:'canonical_fact_table',requestedQueryScopes:[],
        requestedComputationScope:{method:'weighted_mean',value:'amount_minor',weight:'quantity',unitColumn:'unit',where:{predicates:[]},missingPolicy:'pairwise_complete',weightPolicy:'nonnegative_integer_frequency',seed:'none'},
        subjectRefs:[],timeScope:{kind:'none'},comparisonScope:{kind:'none'},unresolvedReferences:[],reason:'Local fixture deliberately reproduces a classifier filter contradiction.'};
    const repair=`const source=input.facts.rows;const rows=source.map(r=>Object.fromEntries(Object.entries(r).map(([key,value])=>[key,['amount_minor','quantity'].includes(key)?Number(value):value])));return {schemaVersion:1,complete:true,tables:[{name:'facts',role:'fact',schema:${JSON.stringify(schema)},rowCount:rows.length,rows,lineage:rows.flatMap((r,row)=>Object.keys(r).map(column=>({row,column,origins:[{kind:'table',name:'facts',row,column}]})))}],relationships:[],excludedRows:[]};`;
    const computation="const rows=input.facts.rows;let numerator=0n,denominator=0n,n=0,excluded=0,zeroWeightRows=0,unit=null;for(const r of rows){if(r.amount_minor===null||r.quantity===null){excluded++;continue;}if(r.quantity===0){zeroWeightRows++;continue;}numerator+=BigInt(r.amount_minor)*BigInt(r.quantity);denominator+=BigInt(r.quantity);unit=r.unit;n++;}return {method:'weighted_mean',methodVersion:1,seed:'none',scopedRows:rows.length,n,excluded,zeroWeightRows,numerator:String(numerator),denominator:String(denominator),mean:denominator===0n?null:Number(numerator)/Number(denominator),unit};";
    const textItem=text=>({type:'message',id:'msg_'+randomUUID(),role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]});
    const toolItem=(name,args)=>({type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name,arguments:JSON.stringify(args),status:'completed'});
    const reply=(body,item)=>{
        const response={id:'resp_'+randomUUID(),object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model,output:[item],
            usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
        if(!body.stream)return {status:200,contentType:'application/json',body:JSON.stringify(response)};
        const events=[{type:'response.created',response:{...response,output:[]}},
            {type:'response.output_item.added',output_index:0,item:item.type==='function_call'?{...item,arguments:'',status:'in_progress'}:{...item,content:[],status:'in_progress'}}];
        if(item.type==='function_call')events.push({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:item.arguments},
            {type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:item.arguments});
        else events.push({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
            {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text},
            {type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:item.content[0].text},
            {type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
        events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response});
        return {status:200,contentType:'text/event-stream',body:events.map((event,sequence_number)=>`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number})}\n\n`).join('')};
    };
    return request=>{
        const body=JSON.parse(request.body);
        if(new URL(request.url).pathname==='/demo/session')return {status:200,contentType:'application/json',body:JSON.stringify({token:'dmo_local_'+randomUUID(),model,expires_in:300})};
        if(!(body.tools??[]).some(tool=>tool.name==='workspace_write'))return reply(body,textItem(JSON.stringify(body).includes('query understanding engine')?JSON.stringify(classification):'OK'));
        const outputs=(body.input??[]).filter(item=>item.type==='function_call_output').flatMap(item=>{try{return [JSON.parse(item.output)];}catch{return [];}});
        const last=outputs.at(-1),artifact=outputs.map(value=>value.payload?.workspace?.artifact).filter(Boolean).at(-1);
        const plan=outputs.map(value=>value.taskPlan).filter(Boolean).at(-1),tableId=plan?.inputBindings?.[0]?.tableId;
        const call=(name,args)=>reply(body,toolItem(name,args));
        const run=output=>call('code_run',{program:{path:artifact.path,revision:artifact.revision,sha256:artifact.sha256},inputs:[],tables:[{name:'facts',tableId}],mode:'whole_table',output:{path:output,expectedRevision:0,format:'json'}});
        switch(step++){
            case 0:return call('task_scope_repair',{population:'entire_input',goalQuote:'entire input'});
            case 1:return call('candidate_infer_meaning',{input:{kind:'table',name:'facts',tableId},table:{name:'facts',grain:['fact_id'],groupBy:[],
                columns:schema.map(column=>({...column,sourceColumn:column.name,conversion:column.dataType==='number'?'decimal':column.dataType==='date'?'iso_date':'identity',...(column.dataType==='number'?{scale:0}:{})})),detailRanges:[{start:0,end:parsed.data.length-1}]},exclusions:[],assumptions:['Each raw data record is one retained fact; units are preserved without conversion.']});
            case 2:return call('workspace_write',{path:'/workspace/repair.js',expectedRevision:0,content:repair});
            case 3:return run('/workspace/repaired.json');
            case 4:return call('workspace_write',{path:'/workspace/repair.js',expectedRevision:1,content:"if(!Array.isArray(input.facts.rows))throw new Error('complete_table_required');"+repair});
            case 5:return run('/workspace/repaired.json');
            case 6:return call('candidate_stage',{jobId:last.receipt.jobId});
            case 7:return call('candidate_validate',{candidateId:last.payload.candidate.candidateId});
            case 8:return call('candidate_request_approval',{candidateId:last.payload.candidateValidation.candidateId,primaryTable:'facts'});
            case 9:return call('workspace_write',{path:'/workspace/mean.js',expectedRevision:0,content:computation});
            case 10:return run('/workspace/mean.json');
            case 11:return call('computation_validate',{jobId:last.receipt.jobId});
            default:return reply(body,textItem('The mock offers no factual answer; the host must admit the executed computation.'));
        }
    };
};
