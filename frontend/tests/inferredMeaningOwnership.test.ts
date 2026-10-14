// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
const hook=vi.hoisted(()=>({capture:undefined as (()=>Promise<void>)|undefined}));
vi.mock('../services/agent/execution/codeTableInputs',async importActual=>{
    const actual=await importActual<typeof import('../services/agent/execution/codeTableInputs')>();
    return {...actual,captureCodeTables:async(...args:Parameters<typeof actual.captureCodeTables>)=>{const capture=hook.capture;hook.capture=undefined;if(capture)await capture();return actual.captureCodeTables(...args);}};
});
import {beginRun,beginSessionTransition,cancelOwnedRun,finishRun,scopeRunStore} from '../services/session/sessionOwnership';
import {createSingleTableDatasetBundle} from '../services/data/datasetBundle';
import {inferCandidateMeaning} from '../services/data/inferCandidateMeaning';
import type {CandidateMeaningProposal} from '../services/data/inferredCandidateMeaning';
import type {StoreApi} from '../services/agent/types';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const setup=()=>{
    const data={fileName:'synthetic.csv',data:[{Id:'a',Amount:0},{Id:'b',Amount:-5},{Id:'Subtotal',Amount:-5}]};
    const bundle=createSingleTableDatasetBundle({datasetId:'synthetic',sourceFingerprint:'synthetic',file:{name:data.fileName,size:0,lastModified:0},data});
    let state={sessionId:'meaning-race',csvData:data,canonicalCsvData:data,datasetBundle:bundle} as unknown as ReturnType<StoreApi['getState']>;
    const root:StoreApi={getState:()=>state,setState:p=>{state={...state,...(typeof p==='function'?p(state):p)};}};
    const lease=beginRun(root,'follow_up','meaning-run','meaning-turn'),store=scopeRunStore(root,lease);
    store.executionContext={lease,toolCallId:'real-meaning-call',stepId:'meaning-step'};
    const bind=vi.fn(),snapshot={revision:1,goal:'Repair complete input',inputBindings:bundle.tables.map(t=>({tableId:t.tableId,datasetVersion:t.datasetVersion,relationshipSetId:bundle.relationshipSetId}))};
    store.piTask={snapshot} as StoreApi['piTask'];store.codeExecution={inspect:()=>[]} as unknown as StoreApi['codeExecution'];
    store.candidateStaging={validationRequirements:()=>({configured:false}),bindInferredMeaning:bind} as unknown as StoreApi['candidateStaging'];
    const proposal:CandidateMeaningProposal={input:{kind:'table',name:'original',tableId:bundle.primaryTableId},table:{name:'facts',grain:['Id'],groupBy:[],columns:[{name:'Id',sourceColumn:'Id',dataType:'string',nullable:false,conversion:'identity'},{name:'Amount',sourceColumn:'Amount',dataType:'number',nullable:false,conversion:'identity',scale:2}],detailRanges:[{start:0,end:1}]},exclusions:[{row:2,role:'subtotal'}],assumptions:[]};
    return {root,store,lease,proposal,bind,cleanup:()=>{finishRun(root,lease);beginSessionTransition(root);}};
};
afterEach(()=>{hook.capture=undefined;});
describe('automatic meaning captured ownership',()=>{
    for(const mode of ['stop','switch','version'] as const)it(`refuses a deferred complete-input capture after ${mode}`,async()=>{
        const f=setup(),entered=deferred(),release=deferred();hook.capture=async()=>{entered.resolve();await release.promise;};
        try{
            const pending=inferCandidateMeaning(f.store,f.proposal);const rejected=expect(pending).rejects.toThrow();await entered.promise;
            if(mode==='stop')cancelOwnedRun(f.root);else if(mode==='switch')beginSessionTransition(f.root);else f.root.setState(s=>({datasetBundle:{...s.datasetBundle!,tables:s.datasetBundle!.tables.map(t=>({...t,datasetVersion:'new-version'}))}}));
            release.resolve();await rejected;expect(f.bind).not.toHaveBeenCalled();expect(f.root.getState().csvData!.data).toEqual([{Id:'a',Amount:0},{Id:'b',Amount:-5},{Id:'Subtotal',Amount:-5}]);
        }finally{release.resolve();f.cleanup();}
    });
    it('rejects a stale source-free table digest rather than installing meaning under a new binding',async()=>{
        const f=setup();try{f.root.setState(s=>({datasetBundle:{...s.datasetBundle!,relationshipSetId:'new-relations'}}));await expect(inferCandidateMeaning(f.store,f.proposal)).rejects.toThrow('input_version_changed');expect(f.bind).not.toHaveBeenCalled();}finally{f.cleanup();}
    });
});
