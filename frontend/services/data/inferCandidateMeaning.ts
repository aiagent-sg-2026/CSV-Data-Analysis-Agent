import type {StoreApi} from '../agent/types';
import {assertRunActive,awaitOwned} from '../session/sessionOwnership';
import {captureCodeTables,codeDigest} from '../agent/execution/codeTableInputs';
import {readSourceRecords} from './immutableCsvSource';
import {bindCandidateValidationContract,type HostCandidateValidationContract} from './candidateValidationBinding';
import {compileInferredCandidateMeaning,isCandidateMeaningProposal} from './inferredCandidateMeaning';
import type {ValidationInputs} from './candidateValidation';
import { isSpillMeaningProposal, compileSpillMeaningProposal } from './spillMeaningProposal';
import { isDualGrainCandidateMeaning, isDualGrainMeaningAlternatives, compileDualGrainCandidateMeaning, DUAL_GRAIN_MEANING_LIMITS } from './dualGrainCandidateMeaning';
import { spillMeaningConfirmation, requestSpillMeaningChoice } from '../agent/runtime/pi/piSpillMeaningChoice';

// Only this trusted inference path can issue custody. Copied/serialized bindings and model
// metadata cannot install a meaning contract or remove its draft-only restriction.
const inferredBindings = new WeakMap<HostCandidateValidationContract, { namespaceId: string; signature: string; draftOnly: boolean; check: () => void }>();
export const captureInferredMeaningBinding = (binding: HostCandidateValidationContract, namespaceId: string) => {
    const custody = inferredBindings.get(binding);
    if (!custody || custody.namespaceId !== namespaceId || custody.signature !== JSON.stringify(binding)) throw new Error('meaning_binding_unavailable');
    custody.check();
    return Object.freeze({ draftOnly: custody.draftOnly, check: custody.check });
};

/** Host compilation is automatic. It cannot inspect guest output or approve a dataset commit. */
export const inferCandidateMeaning=async(store:StoreApi,proposal:unknown)=>{
    if(!isCandidateMeaningProposal(proposal)&&!isSpillMeaningProposal(proposal)&&!isDualGrainCandidateMeaning(proposal)&&!isDualGrainMeaningAlternatives(proposal))throw new Error('meaning_proposal_invalid');
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
    const bind = (compiled: HostCandidateValidationContract, draftOnly = false, meaningCheck = () => {}) => {
        inferredBindings.set(compiled, { namespaceId: port.namespaceId, signature: JSON.stringify(compiled), draftOnly, check: meaningCheck });
        return port.bindInferredMeaning(compiled, context);
    };
    check();
    if (isSpillMeaningProposal(p)) {
        const compiled = await awaitOwned(compileSpillMeaningProposal(store, p, check), store, lease); check();
        return bind(compiled);
    }
    const inputs:ValidationInputs={tables:{},sources:{}};
    let captured:Awaited<ReturnType<typeof captureCodeTables>>|undefined;
    if(p.input.kind==='table'){
        captured=await awaitOwned(captureCodeTables(store,[{name:p.input.name,tableId:p.input.tableId!}],binding,8*1024*1024,check),store,lease);
        inputs.tables[p.input.name]=captured.tables[p.input.name].rows;
    }else{
        if ((isDualGrainCandidateMeaning(p) || isDualGrainMeaningAlternatives(p))
            && (!source || source.byteSize > DUAL_GRAIN_MEANING_LIMITS.sourceBytes || source.recordCount > DUAL_GRAIN_MEANING_LIMITS.sourceRows)) throw new Error('meaning_dual_grain_small_envelope_only');
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
    if (isDualGrainMeaningAlternatives(p)) {
        for (const interpretation of p.interpretations) compileDualGrainCandidateMeaning(interpretation.meaning, inputs);
        check();
        requestSpillMeaningChoice(store, p.interpretations[0].meaning, ['Business roles, units and alignment require exact selection'], p.interpretations[1].meaning, p.interpretations.map(i => i.label));
        throw new Error('meaning_semantic_confirmation_required');
    }
    const dual = isDualGrainCandidateMeaning(p);
    const confirmation = dual ? spillMeaningConfirmation(store, p) : undefined;
    if (dual && !confirmation) throw new Error('meaning_dual_grain_alternatives_required');
    const compiled = dual ? compileDualGrainCandidateMeaning(p, inputs) : compileInferredCandidateMeaning(p,inputs);
    if (dual) compiled.contract.ambiguities = []; // Private exact source-fenced human selection, never a model flag.
    const host=await awaitOwned(bindCandidateValidationContract(store,task.snapshot.goal,compiled.contract),store,lease);
    check();captured?.check();
    if(captured?.coverage.some(c=>host.tableDigests[c.tableId]!==c.sha256))throw new Error('input_version_changed');
    const proposalDigest=await awaitOwned(codeDigest(dual ? { proposal: p, semanticSelection: confirmation } : p),store,lease);check();
    if (dual && spillMeaningConfirmation(store, p) !== confirmation) throw new Error('meaning_choice_stale');
    return bind({...host,inference:{kind:'ai_inferred',input:p.input,assumptions:compiled.assumptions,proposalDigest}},dual, dual ? () => {
        if (spillMeaningConfirmation(store, p) !== confirmation) throw new Error('meaning_choice_stale');
    } : undefined);
};
