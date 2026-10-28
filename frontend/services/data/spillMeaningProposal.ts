import type { StoreApi } from '../agent/types';
import { spillMeaningConfirmation, requestSpillMeaningChoice } from '../agent/runtime/pi/piSpillMeaningChoice';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { inspectSourceMeaning } from '../agent/execution/codeSourceRecordStream';
import { bindSpillCandidateValidationContract, spillRow } from './spillCandidateValidation';
import { isSpillMeaningProposal, type SpillMeaningProposal } from './spillMeaningContract';
export { isSpillMeaningProposal, type SpillMeaningProposal } from './spillMeaningContract';

/** Compile against the original, never a preview or model assertion. Full scan is bounded and
 * charged to the same source ledger as execution/validation, including rejected proposals. */
export const compileSpillMeaningProposal = async (store: StoreApi, proposal: SpillMeaningProposal, current: () => void) => {
    if (!isSpillMeaningProposal(proposal)) throw new Error('meaning_proposal_invalid');
    const p = structuredClone(proposal), source = store.getState().datasetBundle?.source.inspection;
    if (!source || source.sourceId !== p.stream.sourceId || source.sha256 !== p.stream.sha256
        || source.dialect.delimiter !== p.stream.dialect.delimiter || source.dialect.quoteChar !== p.stream.dialect.quoteChar) throw new Error('meaning_source_evidence_mismatch');
    const meaning = p.stream.meaning;
    const confirmation = spillMeaningConfirmation(store, p), ambiguities = new Set<string>();
    // Equality alone cannot establish a footer role. Precise human confirmation is separate.
    if (meaning.summary !== 'none' && !confirmation) ambiguities.add('The last-record summary role is not established by numeric equality');
    let header: string[] = [];
    await inspectSourceMeaning(store, current, records => {
        for (const record of records) {
            if (record.diagnostics.length || record.cells.slice(meaning.columns.length).some(c => c.value !== '')) throw new Error('meaning_structure_unsupported');
            if (record.row === 0) {
                header = record.cells.map(c => c.value);
                if (record.cells.length !== meaning.columns.length || meaning.columns.some(c => record.cells[c.sourceColumn]?.value !== c.name)) throw new Error('meaning_header_evidence_mismatch');
                for (const c of meaning.columns) {
                    // A verbatim explicit header annotation is evidence of a named source unit;
                    // no label heuristics, currency inference or multiplicative conversions.
                    if (c.conversion === 'decimal' && !confirmation && !c.name.includes(`[${c.unit}]`)) ambiguities.add(`Column ${c.sourceColumn + 1} has no explicit [${c.unit}] header unit evidence (proposed scale ${c.scale})`);
                }
            } else {
                if (record.cells.length === header.length && record.cells.every((c, i) => c.value === header[i])) throw new Error('meaning_repeated_header_structure_unsupported');
                spillRow(meaning, record.cells.map(c => c.value));
            }
        }
    });
    current();
    if (ambiguities.size) {
        requestSpillMeaningChoice(store, p, [...ambiguities]);
        throw new Error('meaning_semantic_confirmation_required');
    }
    const host = await bindSpillCandidateValidationContract(store, store.piTask!.snapshot.goal, meaning); current();
    const proposalDigest = await codeDigest({ proposal: p, semanticSelection: confirmation ?? null }); current();
    return { ...host, inference: { kind: 'ai_inferred' as const, input: p.input, assumptions: p.assumptions, proposalDigest } };
};
