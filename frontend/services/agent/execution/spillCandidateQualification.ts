import { qualifySourceStream } from './codeSourceStreamQualification';
import { bindSpillCandidateValidationContract, type SpillCandidateMeaning } from '../../data/spillCandidateValidation';
import { createCandidateStaging } from '../../data/candidateStaging';
import { executeCandidateAction } from './executorCandidateActions';
import type { CodeExecutionReceipt } from './codeExecutionContract';

/** Synthetic host-resolved meaning only. This is not a general semantic inference entry point. */
export const qualifySpillCandidate = async (...args: Parameters<typeof qualifySourceStream>) => {
    const fixture = await qualifySourceStream(...args);
    const meaning: SpillCandidateMeaning = { version: 1, kind: 'ordered-source-records', table: 'records', grain: 'source_record', headerRow: 0, summary: 'none',
        columns: [{ name: 'key', sourceColumn: 0, conversion: 'identity' }, { name: 'payload', sourceColumn: 1, conversion: 'identity' },
            { name: 'value', sourceColumn: 2, conversion: 'decimal', scale: 0, unit: 'count' }] };
    fixture.root.candidateValidationContract = await bindSpillCandidateValidationContract(fixture.store, fixture.getTask().goal, meaning);
    const port = createCandidateStaging(fixture.store, fixture.workspace, fixture.getTask, fixture.adapter);
    fixture.store.candidateStaging = port;
    const run = async () => {
        const executed = await fixture.dispatch(), receipt = executed.artifacts?.codeExecution as CodeExecutionReceipt | undefined;
        if (receipt?.status !== 'succeeded') throw new Error(JSON.stringify(executed));
        const staged = await executeCandidateAction({ type: 'tool_call', toolName: 'candidate.stage', args: { jobId: receipt.jobId } }, fixture.store);
        const candidateId = (staged.artifacts?.candidate as {candidateId?: string})?.candidateId;
        if (staged.status !== 'success' || !candidateId) throw new Error(JSON.stringify(staged));
        const validated = await executeCandidateAction({ type: 'tool_call', toolName: 'candidate.validate', args: { candidateId } }, fixture.store);
        return { receipt, candidateId, validated, validation: port.validationReceipt(candidateId) };
    };
    return { ...fixture, port, meaning, run };
};
