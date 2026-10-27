import type {AiAction,ToolExecutionResult} from '../../../types';
import type {StoreApi} from '../types';
import type {CodePolicyContext} from './codeExecutionContract';
import {validateCandidateArgs} from '../tools/manifests/candidateToolManifests';
export const executeCandidateAction=async(action:AiAction,store:StoreApi,policy?:CodePolicyContext):Promise<ToolExecutionResult>=>{
    if(action.type!=='tool_call'||!action.toolName.startsWith('candidate.'))throw new Error('validation_failed');
    const toolName=action.toolName,args=action.args;
    if(toolName==='candidate.infer_meaning'){
        try{
            const {inferCandidateMeaning}=await import('../../data/inferCandidateMeaning');
            const requirements=await inferCandidateMeaning(store,args);
            return {status:'success',toolName,message:'AI meaning inferred and host source-equivalence checks passed. Accepted rows and types are unchanged. Next execute your own program using the compiled contract (source_records for spill, complete candidate envelope otherwise), stage and independently validate it, then request separate exact human candidate approval. Any required semantic choice has been resolved, not converted into commit permission.',shouldStop:false,
                payload:{requirements,answerEvidence:false},artifacts:{requirements}};
        }catch(error){
            const reason=error instanceof Error&&/^(meaning_[a-z_]+|source_stream_[a-z_]+|validation_[a-z_,]+|input_version_changed|scope_revoked|resource_limit|capability_unavailable)$/.test(error.message)?error.message:'meaning_proposal_rejected';
            return {status:'blocked',toolName,message:reason,shouldStop:false,retryHint:'Inspect bounded original source evidence and correct the proposal before code_run; structural evidence failures need source inspection/repair, not blanket human large-file review. Resource exhaustion must stop, never use full arrays or legacy fallback. Table input rows are data only: row 0 is the first fact, with named sourceColumn fields and no CSV header exclusion. Raw source input rows are physical records, including the header, with numeric sourceColumn indexes. Use the matching coordinates and complete row count. Omit metric unit unless that exact label is present in its source column; preserve a separate unit column without conversion. Accepted data is unchanged.'};
        }
    }
    if(!validateCandidateArgs(toolName,args)||!store.candidateStaging||!store.executionContext)return {status:'blocked',toolName,message:'candidate_unavailable: a valid owned locator and current task are required.',shouldStop:false};
    try{
        const port=store.candidateStaging,id=args.candidateId as string;
        if(toolName==='candidate.request_approval'){
            const {requestPiCandidateApproval}=await import('../runtime/pi/piCandidateApproval');
            await requestPiCandidateApproval(store,id,args.primaryTable as string);
            return {status:'blocked',toolName,message:'Exact human review requested. The current run will release ownership before review is displayed.',shouldStop:true};
        }
        if(toolName==='candidate.validate'){
            const receipt=await port.validate(id,store.executionContext,policy);
            return {status:receipt.decision==='validated'?'success':'blocked',toolName,
                message:`${receipt.decision}: ${receipt.reasonCodes.join(', ')||'Independent host checks passed; exact approval/commit remains required.'}`,
                shouldStop:false,payload:{candidateValidation:receipt},artifacts:{candidateValidation:receipt}};
        }
        let candidate:unknown;
        if(toolName==='candidate.stage'){
            const c=await port.stage(args.jobId as string,store.executionContext,policy);
            candidate={candidateId:c.candidateId,namespaceId:c.namespaceId,changeDigest:c.changeDigest,status:c.status,validation:c.validation,answerEvidence:false,
                tables:c.tables.map(({name,schema,rowCount,role})=>({name,schema,rowCount,role})),lineageDigest:c.lineageDigest,outputArtifacts:c.outputArtifacts};
        }else if(toolName==='candidate.diff')candidate=port.diff(id,args.againstId as string|undefined);
        else if(toolName==='candidate.abandon')candidate=port.abandon(id);
        else {
            const c=port.read(id),t=args.table===undefined?undefined:c.tables.find(t=>t.name===args.table);
            if(args.table!==undefined&&!t)throw new Error('candidate_table_unavailable');
            const offset=Number(args.offset??0),limit=Number(args.limit??10);
            if(t&&offset>t.rowCount)throw new Error('candidate_range_invalid');
            const receipt=port.validationReceipt(id);
            if(c.spill&&t&&receipt?.decision!=='validated')throw new Error('candidate_validation_required');
            const draft=t&&receipt?.decision==='validated'?await port.previewAsync(id,t.name,receipt.receiptDigest,offset,limit):undefined;
            candidate=t?(draft
                ? {...draft,table:t.name,nextRow:offset+draft.rows.length,complete:offset+draft.rows.length>=t.rowCount,validation:'validated'}
                : {candidateId:id,table:t.name,offset,nextRow:Math.min(offset+limit,t.rowCount),complete:offset+limit>=t.rowCount,rows:t.rows.slice(offset,offset+limit),lineage:t.lineage.filter(l=>l.row>=offset&&l.row<offset+limit),validation:c.validation,answerEvidence:false})
                :{candidateId:id,namespaceId:c.namespaceId,changeDigest:c.changeDigest,lineageDigest:c.lineageDigest,requestedChange:c.requestedChange,protectedSource:c.protectedSource,
                    program:c.execution.program,environmentDigest:c.execution.environmentDigest,inputBindings:c.inputBindings,outputArtifacts:c.outputArtifacts,
                    tables:c.tables.map(({name,role,schema,rowCount})=>({name,role,schema,rowCount})),relationships:c.relationships,excludedRowCount:c.excludedRows.length,validation:c.validation,validationReceipt:port.validationReceipt(id),validationRequirements:port.validationRequirements(),answerEvidence:false};
        }
        return {status:'success',toolName,message:'Candidate inspection/staging only; a current host validation receipt and exact approval/commit are required for publication.',shouldStop:false,payload:{candidate},artifacts:{candidate}};
    }catch(error){
        const reason=error instanceof Error&&/^(candidate_[a-z_]+|validation_[a-z_]+|preview_[a-z_]+|spill_[a-z_]+|source_stream_[a-z_]+|source_record_[a-z_]+|input_version_changed|workspace_conflict|source_unavailable|resource_limit|scope_revoked|capability_unavailable)$/.test(error.message)?error.message:'scope_revoked';
        return {status:'blocked',toolName,message:reason,shouldStop:false,artifacts:{candidateFailure:{candidateId:args.candidateId,reason}},retryHint:'Repair the complete output and use a successful current owned job.'};
    }
};
