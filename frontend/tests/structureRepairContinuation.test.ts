// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { beginRun, finishRun, scopeRunStore } from '../services/session/sessionOwnership';
import { prepareStructureRepairReview, confirmStructureRepairMeaning, continueStructureRepairAnalysis, cancelStructureRepairReview } from '../services/agent/structureRepairConfirmation';
import { installStructureRepairContinuation, captureStructureRepairContinuation, captureStructureRepairProposalConstraint, bindStructureRepairContinuationTask, completeStructureRepairContinuation, sealStructureRepairHandoff } from '../services/agent/structureRepairContinuation';
const mocks = vi.hoisted(() => ({ analysis: vi.fn(), identity: vi.fn() }));
vi.mock('../services/agent/orchestration/initialAnalysisService', () => ({ handleInitialAnalysis: mocks.analysis }));
vi.mock('../services/agent/runtime/pi/piCodingTask', () => ({ captureOwnedPiTaskIdentity: mocks.identity, isCurrentPiTaskIdentity: () => true }));
const fixture = async () => {
    const rows = [['Entity','North','South','North','South'],['Count','Rate','Count','Rate'],['id-a','1','2','3','4','left','right'],['id-b','5','6','7','8','left','right']];
    const text = rows.map(r=>r.join(',')).join('\r\n');
    let state = { sessionId:crypto.randomUUID(), confirmedAnalysisGoal:'Compare fictional records', csvData:{fileName:'synthetic.csv',data:[{old:'unchanged'}]}, canonicalCsvData:null,
        rawCsvData:null, rawIntakeIr:null,datasetBundle:null,workspaceFiles:{},isBusy:false,activeExecution:null,pendingClarification:null } as unknown as ReturnType<StoreApi['getState']>;
    const store: StoreApi={getState:()=>state,setState:patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};}};
    const source=await captureCsvSource(store,new File([text],'synthetic.csv'));
    const parsed=parseCsvTextWithDetection(text);
    store.setState({rawIntakeIr:buildReportIntakeIr('synthetic.csv',parsed.rawRows,parsed.detection),datasetBundle:{source:{inspection:source}} as never});
    const review=(await prepareStructureRepairReview(store))!;
    await confirmStructureRepairMeaning(store,review.reviewId,review.choices[0].candidateDigest);
    return {store,review:store.getState().structureRepairReview!};
};
beforeEach(()=>{mocks.analysis.mockReset();mocks.identity.mockReset();});
describe('header repair handoff retains independent approval boundaries',()=>{
    it('creates one owned initial lease and hands off only to an actionable pending review',async()=>{
        const {store,review}=await fixture();const original=store.getState().datasetBundle;
        mocks.analysis.mockImplementation(async(_data,_goal,scoped:StoreApi)=>{
            expect(scoped.executionContext?.lease.kind).toBe('initial_analysis');
            expect(scoped.executionContext?.lease.closed).toBe(false);
            const pending={resumeContext:{piSpillMeaningChoice:{id:'synthetic-question'}}};
            mocks.identity.mockReturnValue({});
            sealStructureRepairHandoff(scoped,pending);
            finishRun(store,scoped.executionContext!.lease);
            store.setState({pendingClarification:pending as never});
            return {status:'paused'};
        });
        const first=continueStructureRepairAnalysis(store,review.reviewId);
        await expect(continueStructureRepairAnalysis(store,review.reviewId)).rejects.toThrow('repair_continuation_not_ready');
        await first;
        expect(mocks.analysis).toHaveBeenCalledTimes(1);
        expect(store.getState().structureRepairReview?.status).toBe('awaiting_repair');
        expect(store.getState().datasetBundle).toBe(original);
        expect(original?.acceptedCommit).toBeUndefined();expect(store.getState().activeExecution).toBeNull();
    });
    it.each(['projection','dataset','csv','goal'] as const)('rejects %s replacement during asynchronous source recheck',async fault=>{
        const {store,review}=await fixture();const pending=continueStructureRepairAnalysis(store,review.reviewId);
        if(fault==='projection')store.getState().structureRepairReview!.message='tampered';
        if(fault==='dataset')store.setState({datasetBundle:structuredClone(store.getState().datasetBundle)});
        if(fault==='csv')store.setState({csvData:structuredClone(store.getState().csvData)});
        if(fault==='goal')store.setState({confirmedAnalysisGoal:'Different task'});
        await expect(pending).rejects.toThrow();expect(mocks.analysis).not.toHaveBeenCalled();expect(store.getState().activeExecution).toBeNull();
    });
    it('cancels before dispatch without an analysis call or accepted write',async()=>{
        const {store,review}=await fixture();const pending=continueStructureRepairAnalysis(store,review.reviewId);
        cancelStructureRepairReview(store,review.reviewId);await expect(pending).rejects.toThrow();expect(mocks.analysis).not.toHaveBeenCalled();
        expect(store.getState().datasetBundle?.acceptedCommit).toBeUndefined();
    });
    it('late completion cannot publish over or abort a newer run',async()=>{
        const {store,review}=await fixture();let release!:(v:unknown)=>void;let entered!:()=>void;
        const started=new Promise<void>(r=>{entered=r;});
        mocks.analysis.mockImplementation(async()=>{entered();return new Promise(r=>{release=r;});});
        const pending=continueStructureRepairAnalysis(store,review.reviewId);await started;
        const old=mocks.analysis.mock.calls[0][2].executionContext.lease;
        finishRun(store,old);const newer=beginRun(store,'initial_analysis','newer');
        const replacement={...store.getState().structureRepairReview!,message:'Newer view must survive'};store.setState({structureRepairReview:replacement,isReportBoundaryConfirmModalOpen:false});
        release({status:'paused'});await expect(pending).rejects.toThrow('repair_continuation_run_superseded');
        expect(store.getState().structureRepairReview).toBe(replacement);expect(newer.signal.aborted).toBe(false);
        expect(store.getState().activeExecution?.runId).toBe('newer');expect(store.getState().isReportBoundaryConfirmModalOpen).toBe(false);
        finishRun(store,newer);
    });
    it.each(['paused','error','ready'] as const)('does not disguise %s without a pending question as successful handoff',async status=>{
        const {store,review}=await fixture();mocks.analysis.mockResolvedValue({status,message:'Synthetic unsupported fixture'});
        await continueStructureRepairAnalysis(store,review.reviewId);
        expect(store.getState().structureRepairReview?.status).toBe('repair_failed');
        expect(store.getState().structureRepairReview?.message).toContain('Synthetic unsupported fixture');
        expect(store.getState().datasetBundle?.acceptedCommit).toBeUndefined();
    });
});
describe('private header constraint and task ownership',()=>{
    const installed=async()=>{const f=await fixture();const lease=beginRun(f.store,'initial_analysis','first');const scoped=scopeRunStore(f.store,lease);
        const complete=vi.fn();installStructureRepairContinuation(f.store,f.review.reviewId,f.review.choices[0].candidate,f.store.getState().confirmedAnalysisGoal!,()=>{},lease,complete);
        const owner={};mocks.identity.mockReturnValue(owner);bindStructureRepairContinuationTask(scoped);return {...f,lease,scoped,owner,complete};};
    it('allows validated same private task continuation but rejects an unrelated task even with the same source and goal',async()=>{
        const f=await installed();finishRun(f.store,f.lease);const next=beginRun(f.store,'initial_analysis','next');const scoped=scopeRunStore(f.store,next);
        expect(captureStructureRepairContinuation(scoped)).toBeDefined();
        finishRun(f.store,next);const stranger=scopeRunStore(f.store,beginRun(f.store,'initial_analysis','stranger'));mocks.identity.mockReturnValue({});
        expect(()=>captureStructureRepairContinuation(stranger)).toThrow('repair_continuation_wrong_task');
    });
    it('consumes only its own task grant after the trusted commit hook, leaving ordinary analysis unconstrained',async()=>{
        const f=await installed();completeStructureRepairContinuation(f.scoped);expect(f.complete).toHaveBeenCalledOnce();
        expect(captureStructureRepairContinuation(f.scoped)).toBeUndefined();
    });
    it.each(['missing','duplicate','extra','other_interpretation','same_value_alternative'] as const)('rejects %s header coordinates, including an unselected full alternative',async fault=>{
        const f=await installed();const candidate=f.review.choices[0].candidate;
        const selected=candidate.mappings.filter(m=>m.targetColumn>=candidate.mainStartColumn&&m.targetColumn<candidate.mainEndColumn);
        const projections=selected.map(m=>[{column:'value',sourceColumn:m.targetColumn},...m.headerPath.map((ref,i)=>({column:`header${i}`,sourceRow:ref.rowIndex,sourceColumn:ref.columnIndex}))]);
        const column=(name:string,index:number)=>({name,dataType:'string',nullable:false,conversion:'identity',header:{row:0,column:index}});
        const meaning={input:{kind:'source',name:'original'},tables:[
            {name:'entities',grain:['id'],groupBy:[],columns:[column('id',0)],detailRanges:[{start:2,end:3}],projections:[[{column:'id',sourceColumn:0}]]},
            {name:'metrics',grain:['value'],groupBy:[],columns:projections[0].map((m,i)=>column(m.column,i)),detailRanges:[{start:2,end:3}],projections}],
            relationships:[{fromTable:'metrics',toTable:'entities',fromKeys:['value'],toKeys:['id'],cardinality:'many_to_one'}],exclusions:[],assumptions:[]} as never;
        const alternative=structuredClone(meaning) as {assumptions:string[]};alternative.assumptions=['A different fixture assumption'];
        const proposal={input:{kind:'source',name:'original'},interpretations:[{label:'A',meaning},{label:'B',meaning:alternative}],assumptions:[]} as never;
        // First prove this test reaches coordinate checking, rather than failing shape detection.
        expect(()=>captureStructureRepairProposalConstraint(f.scoped,proposal)).not.toThrow();
        const target=(proposal as {interpretations:{meaning:{tables:{projections:{column:string;sourceRow?:number;sourceColumn:number}[][]}[]} }[]}).interpretations[fault==='other_interpretation'?1:0].meaning.tables[1].projections[0];
        if(fault==='missing'||fault==='other_interpretation')target[2].sourceColumn=99;
        if(fault==='same_value_alternative')target[1].sourceColumn+=2;
        if(fault==='duplicate')target[2]={...target[1],column:target[2].column};
        if(fault==='extra'){target.push({column:'conflicting',sourceRow:target[1].sourceRow,sourceColumn:99});
            const table=(proposal as {interpretations:{meaning:{tables:{columns:unknown[];projections:unknown[][]}[]} }[]}).interpretations[0].meaning.tables[1];
            table.columns.push(column('conflicting',0));for(const projection of table.projections.slice(1))projection.push({column:'conflicting',sourceRow:0,sourceColumn:99});}
        expect(()=>captureStructureRepairProposalConstraint(f.scoped,proposal)).toThrow('repair_selected_header_mismatch');
    });
});
