import { describe, expect, it } from 'vitest';
import { convertValidationCell, validateCandidateSemantics, type CandidateValidationContract } from '../services/data/candidateValidation';
import type { CandidateOutput } from '../services/data/candidateContract';

const origin = (row: number, column: number) => ({ kind: 'source' as const, name: 'original', row, column });
const setup = () => {
    const schema = [{ name: 'Id', dataType: 'string' as const, nullable: false }, { name: 'Amount', dataType: 'number' as const, nullable: false }];
    const cells = [{ column: 'Id', origin: origin(1, 0), conversion: 'identity' as const }, { column: 'Amount', origin: origin(1, 1), conversion: 'decimal' as const, scale: 2 }];
    const contract: CandidateValidationContract = { version: 1, completeSourceCells: true, ambiguities: [], tables: [{ name: 'entities', role: 'fact', schema,
        grain: ['Id'], groupBy: [], metrics: [{ column: 'Amount', scale: 2, toleranceMinor: 0, unit: 'USD' }], mutableColumns: ['Amount'], rows: [{ cells }] }],
    relationships: [], exclusions: [{ origin: { kind: 'source', name: 'original', row: 0 }, role: 'header', checks: [] }] };
    const candidate: CandidateOutput = { schemaVersion: 1, complete: true, tables: [{ name: 'entities', role: 'fact', schema, rowCount: 1, rows: [{ Id: 'x', Amount: 1 }],
        lineage: cells.map(c => ({ row: 0, column: c.column, origins: [c.origin] })) }], relationships: [], excludedRows: [{ origin: { kind: 'source', name: 'original', row: 0 }, reason: 'header' }] };
    const inputs = { tables: {}, sources: { original: [['Id', 'Amount'], ['x', '1.00']] } };
    return { contract, candidate, inputs };
};
describe('opt-in complete-cell accounting independently of the proposal compiler', () => {
    it('does not equate complete row coverage with complete physical-cell coverage', () => {
        const f = setup(); f.inputs.sources.original[1].push('200.00');
        expect(validateCandidateSemantics(f.candidate, f.contract, f.inputs).reasonCodes).toContain('validation_input_cell_coverage_incomplete');
        delete f.contract.completeSourceCells;
        expect(validateCandidateSemantics(f.candidate, f.contract, f.inputs).decision).toBe('validated');
    });
    it('rejects the same additive source cell owned by two otherwise valid grains', () => {
        const f = setup();
        f.contract.tables.push({ ...structuredClone(f.contract.tables[0]), name: 'metrics' });
        f.candidate.tables.push({ ...structuredClone(f.candidate.tables[0]), name: 'metrics' });
        expect(validateCandidateSemantics(f.candidate, f.contract, f.inputs).reasonCodes).toContain('validation_additive_source_ownership_overlap');
    });
    it('permits header dimension lineage but does not permit numeric header ownership', () => {
        const f = setup(), table = f.contract.tables[0], candidate = f.candidate.tables[0];
        table.schema = [...table.schema, { name: 'Dimension', dataType: 'string', nullable: false }];
        table.rows[0].cells.push({ column: 'Dimension', origin: origin(0, 1), conversion: 'identity' });
        candidate.schema = [...table.schema]; candidate.rows[0].Dimension = 'Amount';
        candidate.lineage.push({ row: 0, column: 'Dimension', origins: [origin(0, 1)] });
        expect(validateCandidateSemantics(f.candidate, f.contract, f.inputs).decision).toBe('validated');
        table.rows[0].cells[1].origin = origin(0, 1);
        f.inputs.sources.original[0][1] = '1.00';
        expect(validateCandidateSemantics(f.candidate, f.contract, f.inputs).reasonCodes).toContain('validation_contract_accounting_invalid');
    });
    it('rejects IEEE-754 decimal round-trip loss even when minor integer is safe', () => {
        const rule = { column: 'Amount', origin: origin(1, 1), conversion: 'decimal' as const, scale: 2 };
        expect(() => convertValidationCell('90071992547409.91', rule)).toThrow('validation_decimal_precision');
        expect(convertValidationCell('-1.25', rule)).toBe(-1.25);
    });
});
