import type { CsvRow, DatasetColumnSchema } from '../../types';
import type { StoreApi } from '../agent/types';
import type { CodeExecutionPort } from '../agent/execution/codeExecutionContract';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { captureSourceRangeFence } from './immutableCsvSource';
import { captureSessionScope, assertSessionResourceActive } from '../session/sessionOwnership';
import { convertValidationCell, type CandidateSemanticVerdict } from './candidateValidation';
import type { HostCandidateValidationContract } from './candidateValidationBinding';

/** Opt-in HOST meaning, not a guest envelope. Ordered physical records are the grain; no
 * natural-key uniqueness, joins, arbitrary exclusions or grouped/multi-table semantics implied.
 * Numeric units/additivity must already be resolved by the host integration before binding.
 */
export { assertSpillMeaning, type SpillCandidateMeaning } from './spillMeaningContract';
import { assertSpillMeaning, type SpillCandidateMeaning } from './spillMeaningContract';
export type SourceSpillCapability = ReturnType<NonNullable<CodeExecutionPort['sourceSpill']>>;
export const spillSchema = (meaning: SpillCandidateMeaning): DatasetColumnSchema[] => meaning.columns.map(c => ({
    name: c.name, dataType: c.conversion === 'decimal' ? 'number' : 'string', nullable: false,
}));
export const spillRow = (meaning: SpillCandidateMeaning, cells: string[]): CsvRow => Object.fromEntries(meaning.columns.map(c => {
    const raw = cells[c.sourceColumn] ?? '';
    const value = convertValidationCell(raw, { column: c.name, conversion: c.conversion, scale: c.scale,
        origin: { kind: 'source', name: 'original', row: 0, column: c.sourceColumn } });
    // A safe minor integer alone does not guarantee lossless IEEE-754 division by 10^scale.
    if (c.conversion === 'decimal' && minor(value as number, c.scale!) !== minor(raw, c.scale!)) throw new Error('validation_decimal_precision');
    return [c.name, value];
}));
/** Trusted host adapter only. Does not capture provisional rows or install model-provided PASS. */
export const bindSpillCandidateValidationContract = async (store: StoreApi, goal: string, value: SpillCandidateMeaning): Promise<HostCandidateValidationContract> => {
    const meaning = structuredClone(value); assertSpillMeaning(meaning);
    const scope = captureSessionScope(store), bundle = store.getState().datasetBundle, source = bundle?.source.inspection;
    if (!bundle || !source || source.recordCount < (meaning.summary === 'none' ? 2 : 3)) throw new Error('source_unavailable');
    const fence = captureSourceRangeFence(store, source.sourceId), signature = JSON.stringify(bundle);
    const check = () => { assertSessionResourceActive(store, scope); fence();
        if (JSON.stringify(store.getState().datasetBundle) !== signature) throw new Error('input_version_changed'); };
    check();
    if (store.codeExecution && store.executionContext) {
        const jobs = store.codeExecution.inspect(undefined, store.executionContext);
        if (!Array.isArray(jobs) || jobs.length) throw new Error('meaning_contract_locked');
    }
    const digest = await codeDigest(meaning); check();
    const binding: HostCandidateValidationContract = { sessionId: scope.sessionId, sessionEpoch: scope.epoch, goal,
        inputBindings: bundle.tables.map(t => ({ tableId: t.tableId, datasetVersion: t.datasetVersion, relationshipSetId: bundle.relationshipSetId })),
        tableDigests: {}, protectedSource: { sourceId: source.sourceId, sha256: source.sha256 },
        contract: { version: 1, ambiguities: [], tables: [], relationships: [], exclusions: [] }, spill: { meaning, digest } };
    const freeze = (v: unknown) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
    freeze(binding); return binding;
};
// Exact base-10 arithmetic shared with the ordinary validator's strict decimal conversion.
const minor = (value: string | number, scale: number): bigint => {
    const text = String(value);
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error('validation_numeric_invalid');
    const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
    if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) throw new Error('validation_decimal_precision');
    return (text.startsWith('-') ? -1n : 1n) * BigInt(whole + fraction.slice(0, scale).padEnd(scale, '0'));
};
export const validateSpillCandidate = async (capability: SourceSpillCapability, meaning: SpillCandidateMeaning, current: () => void): Promise<CandidateSemanticVerdict> => {
    assertSpillMeaning(meaning); current();
    const totals = meaning.columns.map(() => 0n), observed = meaning.columns.map(() => 0n);
    const summaryRow = meaning.summary === 'none' ? -1 : capability.manifest.sourceRows - 1;
    let nextRow = 0;
    const reasons = new Set<string>();
    for await (const { chunk, records } of capability.inspectRows(current)) {
        current();
        for (let i = 0; i < chunk.rows.length; i++) {
            const row = chunk.rows[i], source = records[i];
            if (row.sourceRow !== nextRow || source.row !== nextRow || row.cells.length !== meaning.columns.length
                || source.cells.slice(meaning.columns.length).some(c => c.value !== '')) throw new Error('candidate_lineage_incomplete');
            if (nextRow === 0) {
                if (meaning.columns.some(c => source.cells[c.sourceColumn]?.value !== c.name)) reasons.add('validation_header_evidence_mismatch');
            } else if (nextRow === summaryRow) {
                meaning.columns.forEach((c, index) => { if (c.conversion === 'decimal') observed[index] = minor(source.cells[c.sourceColumn]?.value ?? '', c.scale!); });
            } else {
                const expected = spillRow(meaning, source.cells.map(c => c.value)), actual = spillRow(meaning, row.cells);
                for (const [index, column] of meaning.columns.entries()) {
                    if (actual[column.name] !== expected[column.name]) reasons.add('validation_source_mapping_mismatch');
                    if (column.conversion === 'decimal') totals[index] += minor(source.cells[column.sourceColumn]?.value ?? '', column.scale!);
                }
            }
            nextRow++;
        }
    }
    current();
    if (nextRow !== capability.manifest.sourceRows) throw new Error('candidate_lineage_incomplete');
    const groups: CandidateSemanticVerdict['groups'] = [];
    meaning.columns.forEach((column, index) => {
        if (column.conversion !== 'decimal') return;
        if (summaryRow !== -1 && totals[index] !== observed[index]) reasons.add('validation_summary_reconciliation_failed');
        groups.push({ table: meaning.table, group: '[]', metric: column.name, expectedMinor: String(totals[index]), actualMinor: String(summaryRow === -1 ? totals[index] : observed[index]) });
    });
    return { decision: reasons.size ? 'blocked' : 'validated', reasonCodes: [...reasons], groups,
        checks: ['source-spill-hash-chain', 'complete-record-accounting', 'source-cell-lineage', 'header-evidence', 'schema-type-null',
            'ordered-source-record-grain', 'host-resolved-units', summaryRow === -1 ? 'no-summary-declared' : 'summary-exclusion-reconciliation'] };
};
