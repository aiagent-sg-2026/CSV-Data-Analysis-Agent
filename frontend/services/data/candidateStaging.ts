import type {StoreApi} from '../agent/types';
import type {TaskWorkspace} from '../agent/taskWorkspace';
import type {CodeExecutionPort,CodeExecutionReceipt,CodePolicyContext} from '../agent/execution/codeExecutionContract';
import {captureCodeTables,codeDigest} from '../agent/execution/codeTableInputs';
import type {AgentTaskContract} from '../agent/runtime/pi/piTaskContract';
import {assertRunActive,registerSessionResource,rootStore,type ExecutionContext} from '../session/sessionOwnership';
import {validateCandidateSemantics,type CandidateSemanticVerdict,type ValidationInputs} from './candidateValidation';
import {readSourceBytes,readSourceRecords} from './immutableCsvSource';
import {parseCandidateOutput,type CandidateRowOrigin,type CandidateCellOrigin,type StagedDatasetCandidate} from './candidateContract';
import {buildBuiltinToolRegistry,resolveAllowedTools} from '../agent/tools/toolRegistry';
import {buildToolAvailabilityContext} from '../agent/tools/toolGovernance';
import type {ToolName} from '../../types';
import type {HostCandidateValidationContract} from './candidateValidationBinding';

const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export interface CandidateValidationReceipt extends CandidateSemanticVerdict {
    validationId:string;candidateId:string;namespaceId:string;taskId:string;taskRevision:number;sessionId:string;sessionEpoch:number;runId:string;turnId?:string;
    toolCallId:string;stepId:string;contractDigest:string;changeDigest:string;lineageDigest:string;inputDigest:string;outputDigest:string;
    programDigest:string;environmentDigest:string;scopeDigest:string;protectedSource:StagedDatasetCandidate['protectedSource'];validator:'host-candidate-semantics-v1';receiptDigest:string;answerEvidence:false;
    determinism:'not_certified';reproducibility:'pinned_environment_and_independent_reference_equivalence';
}
/** A captured task namespace owns candidate scratch. No dataset, query, storage or alias writer is present. */
export const createCandidateStaging=(store:StoreApi,workspace:TaskWorkspace,getTask:()=>AgentTaskContract,execution:CodeExecutionPort)=>{
    const lease=store.executionContext?.lease;if(!lease)throw new Error('scope_revoked');
    const namespaceId=crypto.randomUUID(),taskId=getTask().taskId;
    const candidates=new Map<string,StagedDatasetCandidate>();
    const validations=new Map<string,Readonly<CandidateValidationReceipt>>();
    const validationChecks=new Map<string,()=>void>();
    const validationAttempts=new Map<string,symbol>();
    const validationBindingChecks=new Map<string,(target:StoreApi)=>void>();
    const recoveryInputs=new Map<string,ValidationInputs>();
    // Capture a host-provided contract before the candidate exists. Agent tool arguments cannot install one.
    let supplied=rootStore(store).candidateValidationContract;
    const sourceAtPreparation=store.getState().datasetBundle?.source.inspection;
    const sourceBinding=sourceAtPreparation?{sourceId:sourceAtPreparation.sourceId,sha256:sourceAtPreparation.sha256}:null;
    const validContractBinding=Boolean(supplied&&supplied.sessionId===lease.scope.sessionId&&supplied.sessionEpoch===lease.scope.epoch&&supplied.goal===getTask().goal
        &&JSON.stringify(supplied.inputBindings)===JSON.stringify(getTask().inputBindings)&&JSON.stringify(supplied.protectedSource)===JSON.stringify(sourceBinding));
    let validationBinding=validContractBinding?freeze(structuredClone(supplied!)):undefined;
    let validationContract=validationBinding?.contract;
    const differences=new Map<string,{mappedCells:number;changedCells:number;changes:unknown[];truncated:boolean}>();let disposed=false,suspended=false,bytes=0;
    const own=(context?:ExecutionContext)=>{
        assertRunActive(store,lease);
        if(disposed||suspended||workspace.taskId!==taskId||getTask().taskId!==taskId
            ||context&&(context.lease!==lease||!context.toolCallId||!context.stepId))throw new Error('scope_revoked');
    };
    const policyCheck=(name:ToolName,options:CodePolicyContext={})=>{
        own();const state=store.getState();
        const result=resolveAllowedTools(buildBuiltinToolRegistry(state.columnProfiles?.map(c=>c.name)??[]),buildToolAvailabilityContext(state,{...options,hasCodeExecution:true}));
        if(!result.decisions[name]?.allowed)throw new Error('capability_unavailable');
    };
    const dispose=()=>{disposed=true;candidates.clear();differences.clear();validations.clear();validationChecks.clear();validationAttempts.clear();validationBindingChecks.clear();recoveryInputs.clear();bytes=0;};
    registerSessionResource(lease.scope,dispose);
    const checkReceipt=(receipt:Readonly<CodeExecutionReceipt>,revision:number)=>{
        own();const task=getTask(),state=store.getState();
        if(task.revision!==revision||receipt.taskId!==taskId||receipt.taskRevision!==revision||receipt.sessionId!==lease.scope.sessionId
            ||receipt.sessionEpoch!==lease.scope.epoch||receipt.runId!==lease.runId||receipt.turnId!==lease.turnId
            ||!receipt.toolCallId||!receipt.stepId||receipt.status!=='succeeded'||!receipt.program||!receipt.output
            ||!receipt.environmentDigest||!receipt.inputDigest||!receipt.requestDigest||receipt.outputContract?.format!=='json')throw new Error('candidate_execution_unavailable');
        for(const ref of [receipt.program,...(receipt.inputs??[]),receipt.output]){
            const current=workspace.read(ref.path);
            if(current.revision!==ref.revision||current.sha256!==ref.sha256)throw new Error('workspace_conflict');
        }
        if(receipt.inputBindings.some(b=>!state.datasetBundle?.tables.some(t=>t.tableId===b.tableId&&t.datasetVersion===b.datasetVersion)
            ||state.datasetBundle.relationshipSetId!==b.relationshipSetId))throw new Error('input_version_changed');
        if(receipt.sources?.some(s=>state.datasetBundle?.source.inspection?.sourceId!==s.sourceId||state.datasetBundle.source.inspection.sha256!==s.sha256))throw new Error('input_version_changed');
    };
    const current=(candidateId:string)=>{
        own();const c=candidates.get(candidateId);if(!c)throw new Error('candidate_unavailable');
        checkReceipt(c.execution,c.taskRevision);
        const task=getTask();if(task.scope.digest!==c.requestedChange.scopeDigest||task.scope.intentDigest!==c.requestedChange.intentDigest||task.goal!==c.requestedChange.goal)throw new Error('candidate_scope_changed');
        return c;
    };
    const stage=async(jobId:string,context:ExecutionContext,policy?:CodePolicyContext):Promise<StagedDatasetCandidate>=>{
        own(context);policyCheck('candidate.stage',policy);
        const receipt=execution.inspect(jobId,context,policy) as Readonly<CodeExecutionReceipt>;
        const task=getTask(),revision=task.revision;
        checkReceipt(receipt,revision);
        const protectedSource=store.getState().datasetBundle?.source.inspection;
        const sourceIdentity=protectedSource?{sourceId:protectedSource.sourceId,sha256:protectedSource.sha256}:null;
        const scope={goal:task.goal,intentDigest:task.scope.intentDigest,scopeDigest:task.scope.digest};
        const check=()=>{
            own(context);policyCheck('candidate.stage',policy);checkReceipt(receipt,revision);
            const now=getTask(),source=store.getState().datasetBundle?.source.inspection;
            if(now.goal!==scope.goal||now.scope.digest!==scope.scopeDigest||now.scope.intentDigest!==scope.intentDigest)throw new Error('candidate_scope_changed');
            if(JSON.stringify(source?{sourceId:source.sourceId,sha256:source.sha256}:null)!==JSON.stringify(sourceIdentity))throw new Error('input_version_changed');
        };
        if(receipt.mode==='source_records')throw new Error('candidate_stream_semantic_contract_required');
        const output=workspace.read(receipt.output!.path);
        let materialization=output.content;
        if(receipt.mode==='stateful_stream'){
            const streamed:unknown=JSON.parse(materialization);
            if(!Array.isArray(streamed)||streamed.length!==1)throw new Error('candidate_malformed');
            materialization=JSON.stringify(streamed[0]);
        }
        const value=parseCandidateOutput(materialization);
        if(!receipt.coverage?.length&&!receipt.sources?.length)throw new Error('candidate_complete_input_required');
        if(receipt.coverage?.some(c=>!c.complete||c.deliveredRows!==c.rowCount))throw new Error('candidate_partial_input');
        const snapshot=await captureCodeTables(store,(receipt.coverage??[]).map(({name,tableId})=>({name,tableId})),receipt.inputBindings,8*1024*1024,check);
        if(snapshot.coverage.some(c=>c.sha256!==receipt.coverage!.find(r=>r.name===c.name)?.sha256))throw new Error('input_version_changed');
        const inputs:Record<string,unknown>=Object.create(null);
        for(const ref of receipt.inputs??[])inputs[ref.name]={path:ref.path,revision:ref.revision,sha256:ref.sha256,content:workspace.read(ref.path,ref.revision).content};
        for(const s of receipt.sources??[])inputs[s.name]=readSourceBytes(store,s.sourceId,s.offset,s.length);
        Object.assign(inputs,snapshot.tables);
        if(await codeDigest(inputs)!==receipt.inputDigest)throw new Error('input_version_changed');check();snapshot.check();
        const accounted=new Map<string,Set<number>>();
        const excluded=new Map<string,Set<number>>();
        const sourceRows=new Map<string,ReturnType<typeof readSourceRecords>['records'][number]>();
        const sources=new Map<string,NonNullable<CodeExecutionReceipt['sources']>[number]>();
        for(const s of receipt.sources??[])sources.set(s.name,s);
        // Source-byte snippets cannot establish a complete transformation input. Require full original coverage.
        if(sources.size){
            if(!protectedSource)throw new Error('source_unavailable');
            const ranges=[...sources.values()].sort((a,b)=>a.offset-b.offset);let end=0;
            for(const r of ranges){if(r.offset>end)throw new Error('candidate_partial_input');end=Math.max(end,r.offset+r.length);}
            if(end<protectedSource.byteSize)throw new Error('candidate_partial_input');
        }
        const key=(o:CandidateRowOrigin)=>o.kind==='table'?`table:${o.name}`:`source:${sources.get(o.name)?.sourceId??'missing'}`;
        const checkOrigin=(o:CandidateRowOrigin|CandidateCellOrigin,cell:boolean)=>{
            if(o.kind==='table'){
                const t=snapshot.tables[o.name];
                if(!t||o.row>=t.rows.length||cell&&!Object.hasOwn(t.rows[o.row],(o as CandidateCellOrigin).column))throw new Error('candidate_origin_invalid');
            }else{
                const s=sources.get(o.name);if(!s||!protectedSource||o.row>=protectedSource.recordCount)throw new Error('candidate_origin_invalid');
                const id=`${s.sourceId}:${o.row}`;
                let r=sourceRows.get(id);
                if(!r){r=readSourceRecords(store,s.sourceId,o.row,1).records[0];if(!r)throw new Error('candidate_origin_invalid');sourceRows.set(id,r);}
                // The referenced cell was actually exposed to this program through this exact source range.
                if(r.byteStart<s.offset||r.byteEnd>s.offset+s.length||cell&&!r.cells.some(c=>c.column===(o as CandidateCellOrigin).column))throw new Error('candidate_origin_invalid');
            }
        };
        for(const t of value.tables)for(const cell of t.lineage)for(const o of cell.origins){
            checkOrigin(o,true);const k=key(o),seen=accounted.get(k)??new Set<number>();seen.add(o.row);accounted.set(k,seen);
        }
        for(const e of value.excludedRows){checkOrigin(e.origin,false);const k=key(e.origin),seen=excluded.get(k)??new Set<number>();
            if(seen.has(e.origin.row)||accounted.get(k)?.has(e.origin.row))throw new Error('candidate_accounting_conflict');seen.add(e.origin.row);excluded.set(k,seen);}
        const counts=new Map((receipt.coverage??[]).map(c=>[`table:${c.name}`,c.rowCount]));
        for(const s of sources.values())counts.set(`source:${s.sourceId}`,protectedSource!.recordCount);
        for(const [k,count] of counts)if((accounted.get(k)?.size??0)+(excluded.get(k)?.size??0)!==count)throw new Error('candidate_lineage_incomplete');
        const changes:unknown[]=[];let changedCells=0,mappedCells=0;
        for(const t of value.tables)for(const l of t.lineage){
            mappedCells++;const after=t.rows[l.row][l.column];
            const before=l.origins.map(o=>o.kind==='table'?snapshot.tables[o.name].rows[o.row][o.column]
                :sourceRows.get(`${sources.get(o.name)!.sourceId}:${o.row}`)!.cells.find(c=>c.column===o.column)!.value);
            if(before.length!==1||before[0]!==after){changedCells++;if(changes.length<50)changes.push({table:t.name,row:l.row,column:l.column,before,after});}
        }
        const checkTables=()=>{
            check();snapshot.check();
            for(const c of receipt.coverage??[])if(JSON.stringify(snapshot.tables[c.name].columns)!==JSON.stringify(store.getState().datasetBundle?.tables.find(t=>t.tableId===c.tableId)?.schema.map(s=>s.name)))throw new Error('input_version_changed');
        };
        const lineageDigest=await codeDigest({tables:value.tables.map(t=>({name:t.name,lineage:t.lineage})),excludedRows:value.excludedRows});checkTables();
        const bound={schemaVersion:1 as const,namespaceId,taskId,taskRevision:revision,sessionId:lease.scope.sessionId,sessionEpoch:lease.scope.epoch,
            runId:lease.runId,turnId:lease.turnId,inputBindings:receipt.inputBindings,requestedChange:scope,protectedSource:sourceIdentity,
            execution:{jobId:receipt.jobId,toolCallId:receipt.toolCallId,stepId:receipt.stepId,program:receipt.program,environmentDigest:receipt.environmentDigest,
                inputDigest:receipt.inputDigest,requestDigest:receipt.requestDigest,coverage:receipt.coverage,sources:receipt.sources},outputArtifacts:[receipt.output!],lineageDigest};
        const changeDigest=await codeDigest(bound);checkTables();
        const prior=[...candidates.values()].find(c=>c.changeDigest===changeDigest);if(prior)return prior;
        const size=new TextEncoder().encode(output.content).byteLength;
        if(candidates.size>=20||bytes+size>8*1024*1024)throw new Error('resource_limit');
        const candidate=freeze({...value,...bound,candidateId:`candidate-${crypto.randomUUID()}`,changeDigest,createdAt:Date.now(),
            status:'staged' as const,validation:'pending' as const,answerEvidence:false as const,execution:receipt,
            staging:{toolCallId:context.toolCallId!,stepId:context.stepId!}});
        candidates.set(candidate.candidateId,candidate);differences.set(candidate.candidateId,freeze({mappedCells,changedCells,changes,truncated:changedCells>changes.length}));bytes+=size;return candidate;
    };
    const read=(id:string)=>{policyCheck('candidate.read');return current(id);};
    const validationRequirements=()=>{
        policyCheck('candidate.read');
        return {configured:Boolean(validationBinding),ambiguities:validationContract?.ambiguities??[],inference:validationBinding?.inference,
            tables:validationContract?.tables.map(t=>({name:t.name,role:t.role,schema:t.schema,grain:t.grain,groupBy:t.groupBy,metrics:t.metrics,mutableColumns:t.mutableColumns,expectedRows:t.rows.length})),
            note:'Host contract is fixed before staging. AI interpretation must pass complete-source host compilation before execution. Inferred business semantics remain explicit assumptions.'};
    };
    const bindInferredMeaning=(binding:HostCandidateValidationContract,context:ExecutionContext)=>{
        own(context);
        const jobs=execution.inspect(undefined,context);
        if(supplied||candidates.size||!Array.isArray(jobs)||jobs.length)throw new Error('meaning_contract_locked');
        const source=store.getState().datasetBundle?.source.inspection;
        if(binding.inference?.kind!=='ai_inferred'||binding.sessionId!==lease.scope.sessionId||binding.sessionEpoch!==lease.scope.epoch
            ||binding.goal!==getTask().goal||JSON.stringify(binding.inputBindings)!==JSON.stringify(getTask().inputBindings)
            ||JSON.stringify(binding.protectedSource)!==JSON.stringify(source?{sourceId:source.sourceId,sha256:source.sha256}:null))throw new Error('input_version_changed');
        supplied=freeze(structuredClone(binding));validationBinding=supplied;validationContract=supplied.contract;
        return validationRequirements();
    };
    const validationReceipt=(id:string)=>{current(id);validationChecks.get(id)?.();return validations.get(id);};
    const validate=async(id:string,context:ExecutionContext,policy?:CodePolicyContext):Promise<Readonly<CandidateValidationReceipt>>=>{
        own(context);policyCheck('candidate.validate',policy);const c=current(id);
        const attempt=Symbol();validationAttempts.set(id,attempt);validations.delete(id);validationChecks.delete(id);recoveryInputs.delete(id);
        const check=()=>{own(context);policyCheck('candidate.validate',policy);if(current(id)!==c)throw new Error('candidate_unavailable');
            if(validationAttempts.get(id)!==attempt)throw new Error('candidate_validation_superseded');
            const source=store.getState().datasetBundle?.source.inspection;
            if(JSON.stringify(source?{sourceId:source.sourceId,sha256:source.sha256}:null)!==JSON.stringify(c.protectedSource))throw new Error('input_version_changed');};
        const snapshot=await captureCodeTables(store,(c.execution.coverage??[]).map(({name,tableId})=>({name,tableId})),c.inputBindings,8*1024*1024,check);
        if(snapshot.coverage.some(v=>v.sha256!==c.execution.coverage?.find(x=>x.name===v.name)?.sha256))throw new Error('input_version_changed');
        const inputs:ValidationInputs={tables:Object.fromEntries(Object.entries(snapshot.tables).map(([name,t])=>[name,t.rows])),sources:{},sourceIdentities:{}};
        let sourceUnresolved=false;
        for(const s of c.execution.sources??[]){
            const rows:string[][]=[];const count=store.getState().datasetBundle!.source.inspection!.recordCount;
            if(count>50000)throw new Error('resource_limit');
            for(let i=0;i<count;i++){
                const record=readSourceRecords(store,s.sourceId,i,1).records[0];if(!record)throw new Error('resource_limit');
                if(record.diagnostics.length)sourceUnresolved=true;
                rows.push(record.cells.map(cell=>cell.value));
                if((i+1)%5000===0){await new Promise<void>(resolve=>setTimeout(resolve,0));check();snapshot.check();}
            }
            inputs.sources[s.name]=rows;
            inputs.sourceIdentities![s.name]=s.sourceId;
        }
        check();snapshot.check();
        if(store.getState().datasetBundle?.source.inspection?.diagnostics.some(d=>d==='invalid_utf8'||d==='unclosed_quote'))sourceUnresolved=true;
        const bindingChanged=Boolean(supplied&&!validationBinding)||(c.execution.coverage??[]).some(v=>validationBinding&&v.sha256!==validationBinding.tableDigests[v.tableId]);
        const verdict:CandidateSemanticVerdict=bindingChanged?{decision:'clarification',reasonCodes:['validation_contract_binding_mismatch'],checks:[],groups:[]}
            :sourceUnresolved?{decision:'clarification',reasonCodes:['validation_source_parse_unresolved'],checks:[],groups:[]}:validateCandidateSemantics(c,validationContract,inputs);
        const contractDigest=await codeDigest(validationBinding??{unresolved:true});check();snapshot.check();
        const bound={...verdict,validationId:`validation-${crypto.randomUUID()}`,candidateId:id,namespaceId,taskId,taskRevision:c.taskRevision,
            sessionId:c.sessionId,sessionEpoch:c.sessionEpoch,runId:c.runId,turnId:c.turnId,toolCallId:context.toolCallId!,stepId:context.stepId!,
            contractDigest,changeDigest:c.changeDigest,lineageDigest:c.lineageDigest,inputDigest:c.execution.inputDigest!,outputDigest:c.outputArtifacts[0].sha256,
            programDigest:c.execution.program!.sha256,environmentDigest:c.execution.environmentDigest!,scopeDigest:c.requestedChange.scopeDigest,
            protectedSource:c.protectedSource,validator:'host-candidate-semantics-v1' as const,answerEvidence:false as const,
            determinism:'not_certified' as const,reproducibility:'pinned_environment_and_independent_reference_equivalence' as const};
        const receiptDigest=await codeDigest(bound);check();snapshot.check();
        const receipt=freeze({...bound,receiptDigest});validations.set(id,receipt);validationChecks.set(id,()=>{check();snapshot.check();});validationBindingChecks.set(id,snapshot.checkBinding);
        if (verdict.decision === 'validated') recoveryInputs.set(id, freeze(structuredClone(inputs)));
        return receipt;
    };
    // The caller's digest is only a stale-view precondition; authority remains in validations.
    // Preview never survives the staging lease and is not an accepted dataset or answer evidence.
    const preview=(id:string,tableName:string,receiptDigest:string,offset=0,limit=50)=>{
        policyCheck('candidate.read');
        if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('preview_bounds_invalid');
        const c=current(id),receipt=validationReceipt(id);
        if(!receipt||receipt.decision!=='validated'||receipt.receiptDigest!==receiptDigest
            ||receipt.candidateId!==id||receipt.namespaceId!==namespaceId||receipt.changeDigest!==c.changeDigest
            ||receipt.lineageDigest!==c.lineageDigest||receipt.outputDigest!==c.outputArtifacts[0].sha256
            ||receipt.sessionId!==c.sessionId||receipt.sessionEpoch!==c.sessionEpoch)throw new Error('validation_failed');
        const table=c.tables.find(t=>t.name===tableName);if(!table)throw new Error('candidate_table_unavailable');
        if(offset>table.rowCount)throw new Error('preview_bounds_invalid');
        const result={label:'draft_uncommitted' as const,candidateId:id,tableName:table.name,validationReceiptDigest:receipt.receiptDigest,changeDigest:c.changeDigest,
            sessionId:c.sessionId,sessionEpoch:c.sessionEpoch,protectedSource:c.protectedSource,
            // Immutable sources have no independent version counter: their SHA-256 is their content version.
            sourceSha256:c.protectedSource?.sha256??null,sourceVersion:c.protectedSource?.sha256??null,inputBindings:c.inputBindings,
            offset,totalRows:table.rowCount,rows:[] as typeof table.rows,lineageSamples:[] as typeof table.lineage,
            truncated:false,lineageTruncated:false,answerEvidence:false as const};
        const size=()=>new TextEncoder().encode(JSON.stringify(result)).byteLength;
        if(size()>64*1024)throw new Error('resource_limit');
        const end=Math.min(table.rowCount,offset+limit);
        for(let index=offset;index<end;index++){
            result.rows.push(table.rows[index]);
            if(size()>64*1024){result.rows.pop();break;}
        }
        result.truncated=offset+result.rows.length<table.rowCount;
        for(const lineage of table.lineage){
            if(lineage.row<offset||lineage.row>=offset+result.rows.length)continue;
            if(result.lineageSamples.length>=50){result.lineageTruncated=true;break;}
            result.lineageSamples.push(lineage);
            if(size()>64*1024){result.lineageSamples.pop();result.lineageTruncated=true;break;}
        }
        // Changing false to true shortens JSON; nevertheless enforce the bound on the exact response.
        if(size()>64*1024)throw new Error('resource_limit');
        return freeze(result);
    };
    const diff=(id:string,againstId?:string)=>{
        policyCheck('candidate.diff');
        const c=current(id),before=againstId?current(againstId):undefined;
        let valueDiff:unknown=differences.get(id);
        if(before){
            const changes:unknown[]=[];let changedCells=0;
            for(const t of c.tables)for(let row=0;row<t.rowCount;row++)for(const column of t.schema){
                const previous=before.tables.find(b=>b.name===t.name)?.rows[row]?.[column.name],after=t.rows[row][column.name];
                if(previous!==after){changedCells++;if(changes.length<50)changes.push({table:t.name,row,column:column.name,before:previous??null,after});}
            }
            valueDiff={changedCells,changes,truncated:changedCells>changes.length,alignment:'Candidate table name and row position; not fact-grain equivalence.'};
        }
        return {candidateId:id,against:before?.candidateId??'accepted',changeDigest:c.changeDigest,validation:c.validation,validationReceipt:validationReceipt(id),
            tables:c.tables.map(t=>({name:t.name,rowCount:t.rowCount,schema:t.schema,againstRowCount:before?.tables.find(b=>b.name===t.name)?.rowCount??null})),
            inputCoverage:c.execution.coverage??[],excludedRows:c.excludedRows,relationships:c.relationships,valueDiff,
            note:'Structural comparison only. The separate host validation receipt provides the independent semantic decision.'};
    };
    const captureCommitCheck=(id:string)=>{
        const candidate=current(id),validation=validationReceipt(id),bindingCheck=validationBindingChecks.get(id);
        if(!validation||validation.decision!=='validated'||!bindingCheck)throw new Error('validation_failed');
        return (target:StoreApi,context:ExecutionContext)=>{
            assertRunActive(target,context.lease);
            const task=target.piTask?.snapshot;
            if(disposed||context.lease.scope.sessionId!==lease.scope.sessionId||context.lease.scope.epoch!==lease.scope.epoch
                ||candidates.get(id)!==candidate||validations.get(id)!==validation||!task||task.taskId!==taskId
                ||task.revision!==candidate.taskRevision||task.scope.digest!==candidate.requestedChange.scopeDigest
                ||task.scope.intentDigest!==candidate.requestedChange.intentDigest||task.goal!==candidate.requestedChange.goal)throw new Error('approval_invalid');
            const source=target.getState().datasetBundle?.source.inspection;
            if(JSON.stringify(source?{sourceId:source.sourceId,sha256:source.sha256}:null)!==JSON.stringify(candidate.protectedSource))throw new Error('input_version_changed');
            for(const ref of [candidate.execution.program!,...(candidate.execution.inputs??[]),...candidate.outputArtifacts]){
                const actual=workspace.read(ref.path);if(actual.revision!==ref.revision||actual.sha256!==ref.sha256)throw new Error('workspace_conflict');
            }
            bindingCheck(target);
        };
    };
    const captureRecovery = (id:string) => {
        const c=current(id), receipt=validationReceipt(id), inputs=recoveryInputs.get(id);
        if (!validationBinding || receipt?.decision!=='validated' || !inputs) throw new Error('recovery_metadata_unavailable');
        return { binding:structuredClone(validationBinding), inputs:structuredClone(inputs), execution:c.execution };
    };
    return Object.freeze({namespaceId,stage,read,diff,validate,validationReceipt,validationRequirements,bindInferredMeaning,captureCommitCheck,captureRecovery,preview,
        suspend:()=>{own();suspended=true;},list:()=>{
            own();const live:StagedDatasetCandidate[]=[];
            for(const id of candidates.keys()){
                try{live.push(current(id));}
                catch(error){
                    // A repaired program/output supersedes earlier scratch. Keep exact stale reads
                    // fail-closed, but do not let one historical revision hide the new valid candidate.
                    if(!(error instanceof Error)||error.message!=='workspace_conflict')throw error;
                }
            }
            return live;
        },
        abandon:(id:string)=>{policyCheck('candidate.abandon');const c=candidates.get(id);if(!c)throw new Error('candidate_unavailable');candidates.delete(id);differences.delete(id);validations.delete(id);validationChecks.delete(id);validationAttempts.delete(id);recoveryInputs.delete(id);
            bytes-=new TextEncoder().encode(workspace.read(c.outputArtifacts[0].path,c.outputArtifacts[0].revision).content).byteLength;
            return {candidateId:id,status:'abandoned' as const,namespaceId};},dispose});
};
export type CandidateStagingPort=ReturnType<typeof createCandidateStaging>;
