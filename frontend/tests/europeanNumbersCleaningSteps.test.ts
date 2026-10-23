import { describe, expect, it } from 'vitest';
import type { DataPreparationPlan, SandboxTransformationOutput, SandboxTransformationProposal } from '../types';
import { buildDeterministicNormalizationPlan } from '../services/ai/deterministicNormalizer';
import { applyDataOperations } from '../services/agent/execution/dataOperationRunner';
import { applyPreparationPlanToCanonicalDataset } from '../services/agent/orchestration/canonicalPreparation';
import { profileData } from '../services/data/dataProfiler';
import { validateSandboxOutput } from '../services/sandbox/sandboxValidation';

const europeanRows = [
    { Menge: '1.000', Preis: '161,30', Betrag: '161.300,00', Code: '1.234.567' },
    { Menge: '2.500', Preis: '12,50', Betrag: '31.250,00', Code: '2.345.678' },
    { Menge: '3.200', Preis: '0,93', Betrag: '2.976,00', Code: '3.456.789' },
];

const emptyPlan = (overrides: Partial<DataPreparationPlan> = {}): DataPreparationPlan => ({
    explanation: 'test',
    operations: [],
    outputColumns: [],
    planStatus: 'operations',
    consistencyIssues: [],
    ...overrides,
});

describe('cleaning steps read decimal-comma columns per column, never by stripping commas', () => {
    it('cast_column reads 161,30 as 161.3 and an ambiguous 4.567 as thousands inside a decimal-comma dataset', () => {
        const result = applyDataOperations(europeanRows, [
            { id: 'c1', type: 'cast_column', reason: 'measure', column: 'Preis', targetType: 'number' },
            { id: 'c2', type: 'cast_column', reason: 'measure', column: 'Menge', targetType: 'number' },
            { id: 'c3', type: 'cast_column', reason: 'measure', column: 'Betrag', targetType: 'number' },
        ], { allowEmptyResult: false }).data;
        expect(result.map(row => row.Preis)).toEqual([161.3, 12.5, 0.93]);
        expect(result.map(row => row.Menge)).toEqual([1000, 2500, 3200]);
        expect(result.map(row => row.Betrag)).toEqual([161300, 31250, 2976]);
        // The code column was never cast and stays text.
        expect(result.map(row => row.Code)).toEqual(['1.234.567', '2.345.678', '3.456.789']);
    });

    it('cast_column leaves a US column on the US reading', () => {
        const result = applyDataOperations(
            [{ Amount: '1,234.56' }, { Amount: '1,234' }],
            [{ id: 'c1', type: 'cast_column', reason: 'measure', column: 'Amount', targetType: 'number' }],
            { allowEmptyResult: false },
        ).data;
        expect(result.map(row => row.Amount)).toEqual([1234.56, 1234]);
    });

    it('the deterministic normaliser casts decimal-comma measures and skips the code column', () => {
        const { profiles } = profileData(europeanRows);
        const normalization = buildDeterministicNormalizationPlan(emptyPlan({ outputColumns: profiles }), profiles, europeanRows);
        expect(normalization.numericStringNormalizedColumns.sort()).toEqual(['Betrag', 'Menge', 'Preis']);
        const cleaned = applyDataOperations(europeanRows, normalization.plan.operations, { allowEmptyResult: false }).data;
        expect(cleaned.map(row => row.Betrag)).toEqual([161300, 31250, 2976]);
        expect(cleaned.map(row => row.Code)).toEqual(['1.234.567', '2.345.678', '3.456.789']);
    });

    it('canonical preparation reads listed numeric columns per column', () => {
        const prepared = applyPreparationPlanToCanonicalDataset(
            { fileName: 'w4.csv', data: europeanRows },
            emptyPlan({ numericStringNormalizedColumns: ['Menge', 'Preis', 'Betrag'] }),
        )!;
        expect(prepared.data.map(row => row.Preis)).toEqual([161.3, 12.5, 0.93]);
        expect(prepared.data.map(row => row.Betrag)).toEqual([161300, 31250, 2976]);
        expect(prepared.data.map(row => row.Menge)).toEqual([1000, 2500, 3200]);

        const us = applyPreparationPlanToCanonicalDataset(
            { fileName: 'us.csv', data: [{ Amount: '1,234.56' }, { Amount: '$2,000.00' }] },
            emptyPlan({ numericStringNormalizedColumns: ['Amount'] }),
        )!;
        expect(us.data.map(row => row.Amount)).toEqual([1234.56, 2000]);
    });
});

describe('sandbox validation reads European numbers', () => {
    const proposal: SandboxTransformationProposal = {
        language: 'javascript',
        explanation: 'Keep rows.',
        code: 'function transform(rows, context) { return {}; }',
        primaryTableId: 'fact',
        tables: [{ tableId: 'fact', name: 'Fact', role: 'fact' }],
        preserveRowCount: true,
        maxRowDropRatio: 0,
        preserveNumericColumns: ['Betrag'],
    };

    it('reconciles Betrag totals of unchanged European text instead of stripping commas', () => {
        const rows = europeanRows.map(row => ({ id: row.Code, Betrag: row.Betrag }));
        const output: SandboxTransformationOutput = {
            tables: [{ tableId: 'fact', name: 'Fact', role: 'fact', rows: rows.map(row => ({ ...row })) }],
            lineage: rows.map((_, index) => ({ outputTableId: 'fact', outputRowIndex: index, inputTableId: 'input', inputRowIndexes: [index] })),
            relationships: [],
        };
        const result = validateSandboxOutput({ inputTableId: 'input', inputRows: rows, proposal, output, maxOutputBytes: 100_000 });
        expect(result.decision).toBe('trusted');
        expect(result.preservedNumericTotals.Betrag.before).toBeCloseTo(161300 + 31250 + 2976, 6);
        expect(result.preservedNumericTotals.Betrag.after).toBeCloseTo(161300 + 31250 + 2976, 6);
    });
});
