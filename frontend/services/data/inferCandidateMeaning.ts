import type {StoreApi} from '../agent/types';
import {assertRunActive,awaitOwned} from '../session/sessionOwnership';
import {captureCodeTables,codeDigest} from '../agent/execution/codeTableInputs';
import {readSourceRecords} from './immutableCsvSource';
import {bindCandidateValidationContract} from './candidateValidationBinding';
import {compileInferredCandidateMeaning,isCandidateMeaningProposal} from './inferredCandidateMeaning';
import type {ValidationInputs} from './candidateValidation';

/** Host compilation is automatic. It cannot inspect guest output or approve a dataset commit. */
export const inferCandidateMeaning=async(store:StoreApi,proposal:unknown)=>{
    if(!isCandidateMeaningProposal(proposal))throw new Error('meaning_proposal_invalid');
    const context=store.executionContext,task=store.piTask,port=store.candidateStaging;
    if(!context||!task||!port||!store.codeExecution)throw new Error('meaning_task_unavailable');
    const lease=context.lease,version=task.snapshot.revision,binding=structuredClone(task.snapshot.inputBindings);
    const p=structuredClone(proposal);
    const source=store.getState().datasetBundle?.source.inspection;
    const check=()=>{
        assertRunActive(store,lease);
        const now=store.getState().datasetBundle;
        if(task.snapshot.revision!==version||JSON.stringify(task.snapshot.inputBindings)!==JSON.stringify(binding)
            ||binding.some(b=>!now?.tables.some(t=>t.tableId===b.tableId&&t.datasetVersion===b.datasetVersion)||now.relationshipSetId!==b.relationshipSetId)
            ||now?.source.inspection?.sourceId!==source?.sourceId||now?.source.inspection?.sha256!==source?.sha256)throw new Error('input_version_changed');
        const jobs=store.codeExecution!.inspect(undefined,context);
        if(!Array.isArray(jobs)||jobs.length||port.validationRequirements().configured)throw new Error('meaning_contract_locked');
    };
    check();
    const inputs:ValidationInputs={tables:{},sources:{}};
    let captured:Awaited<ReturnType<typeof captureCodeTables>>|undefined;
    if(p.input.kind==='table'){
        captured=await awaitOwned(captureCodeTables(store,[{name:p.input.name,tableId:p.input.tableId!}],binding,8*1024*1024,check),store,lease);
        inputs.tables[p.input.name]=captured.tables[p.input.name].rows;
    }else{
        if(!source||source.recordCount>50000||source.byteSize>8*1024*1024||source.diagnostics.some(d=>d==='invalid_utf8'||d==='unclosed_quote'))throw new Error('meaning_complete_source_unavailable');
        const rows:string[][]=[];
        for(let row=0;row<source.recordCount;row++){
            const record=readSourceRecords(store,source.sourceId,row,1).records[0];
            if(!record||record.diagnostics.length)throw new Error('meaning_source_parse_unresolved');
            rows.push(record.cells.map(c=>c.value));
            if((row+1)%5000===0){await awaitOwned(new Promise<void>(resolve=>setTimeout(resolve,0)),store,lease);check();}
        }
        inputs.sources[p.input.name]=rows;
    }
    check();captured?.check();
    const compiled=compileInferredCandidateMeaning(p,inputs);
    const host=await awaitOwned(bindCandidateValidationContract(store,task.snapshot.goal,compiled.contract),store,lease);
    check();captured?.check();
    if(captured?.coverage.some(c=>host.tableDigests[c.tableId]!==c.sha256))throw new Error('input_version_changed');
    const proposalDigest=await awaitOwned(codeDigest(p),store,lease);check();
    return port.bindInferredMeaning({...host,inference:{kind:'ai_inferred',input:p.input,assumptions:compiled.assumptions,proposalDigest}},context);
};
