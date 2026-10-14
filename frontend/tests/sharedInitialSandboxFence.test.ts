import {describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({proposal:vi.fn(),execute:vi.fn(),persist:vi.fn()}));
vi.mock('../services/ai/sandboxTransformationGenerator',()=>({generateSandboxTransformationProposal:mocks.proposal}));
vi.mock('../services/sandbox/transformationSandboxClient',()=>({executeSandboxTransformation:mocks.execute}));
vi.mock('../services/agent/orchestration/cleaningPipelinePersistence',()=>({persistSuccessfulCleaning:mocks.persist}));
import {trySandboxCleaningFallback} from '../services/agent/orchestration/sandboxCleaningFallback';
describe('shared initial sandbox publication fence',()=>{
    it('refuses the legacy fallback before provider, execution or direct publication',async()=>{
        const getState=vi.fn(),setState=vi.fn();
        const result=await trySandboxCleaningFallback({store:{getState,setState,executorPreparation:{entryPoint:'initial_analysis',mode:'staging_only',taskId:'task',taskRevision:1,namespaceId:'ns',runId:'run',sessionEpoch:0}},
            rawData:{fileName:'synthetic.csv',data:[]},workingData:{fileName:'synthetic.csv',data:[]},workingProfiles:[],round:2,previousFailure:new Error('failed')});
        expect(result.status).toBe('retry');expect(result.error?.message).toBe('shared_executor_requires_candidate_validation');
        expect(getState).not.toHaveBeenCalled();expect(setState).not.toHaveBeenCalled();
        expect(mocks.proposal).not.toHaveBeenCalled();expect(mocks.execute).not.toHaveBeenCalled();expect(mocks.persist).not.toHaveBeenCalled();
    });
});
