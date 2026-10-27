import type {DatasetScopeBinding} from '../../types';
import type {StoreApi} from '../agent/types';
import {captureCodeTables} from '../agent/execution/codeTableInputs';
import {captureSessionScope,assertSessionResourceActive} from '../session/sessionOwnership';
import type {CandidateValidationContract} from './candidateValidation';
export interface HostCandidateValidationContract {
    sessionId:string;sessionEpoch:number;goal:string;inputBindings:DatasetScopeBinding[];tableDigests:Record<string,string>;
    protectedSource:{sourceId:string;sha256:string}|null;contract:CandidateValidationContract;
    spill?:{meaning:import('./spillCandidateValidation').SpillCandidateMeaning;digest:string};
    inference?:{kind:'ai_inferred';assumptions:string[];proposalDigest:string;input?:{kind:'table'|'source';name:string;tableId?:string}};
}
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
/** Trusted host integration only. No tool accepts this API or an agent-generated oracle. */
export const bindCandidateValidationContract=async(store:StoreApi,goal:string,contract:CandidateValidationContract):Promise<HostCandidateValidationContract>=>{
    const scope=captureSessionScope(store),state=store.getState(),bundle=state.datasetBundle;
    if(!bundle)throw new Error('complete_input_unavailable');
    const meaning=freeze(structuredClone(contract));
    const inputBindings=bundle.tables.map(t=>({tableId:t.tableId,datasetVersion:t.datasetVersion,relationshipSetId:bundle.relationshipSetId}));
    const source=bundle.source.inspection,protectedSource=source?{sourceId:source.sourceId,sha256:source.sha256}:null;
    const check=()=>{assertSessionResourceActive(store,scope);const now=store.getState().datasetBundle,source=now?.source.inspection;
        if(JSON.stringify(now?.tables.map(t=>({tableId:t.tableId,datasetVersion:t.datasetVersion,relationshipSetId:now.relationshipSetId})))!==JSON.stringify(inputBindings)
            ||JSON.stringify(source?{sourceId:source.sourceId,sha256:source.sha256}:null)!==JSON.stringify(protectedSource))throw new Error('input_version_changed');};
    const captured=await captureCodeTables(store,inputBindings.map(b=>({name:b.tableId,tableId:b.tableId})),inputBindings,8*1024*1024,check);check();captured.check();
    return freeze({sessionId:scope.sessionId,sessionEpoch:scope.epoch,goal,inputBindings,protectedSource,contract:meaning,tableDigests:Object.fromEntries(captured.coverage.map(c=>[c.tableId,c.sha256]))});
};
