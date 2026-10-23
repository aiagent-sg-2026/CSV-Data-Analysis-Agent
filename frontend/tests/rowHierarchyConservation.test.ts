import { describe, expect, it } from 'vitest';
import { assertFactRowsPreserved, FactRowLossError, findFactRowLoss } from '../services/agent/orchestration/rowHierarchyConservation';
import { sanitizeDatasetSemanticSnapshot } from '../services/agent/datasetSemantics';
import type { CsvData } from '../types';

const row = (label: string, rowClass: string, source: number, total: number | null) => ({
    Label: label, RowClass: rowClass, SourceRowIndex: source, Total: total,
});

const table = [
    row('ASEAN', 'subtotal', 1, 30),
    row('A', 'fact', 2, 10),
    row('B', 'fact', 3, 20),
    row('C', 'fact', 4, null),
];

describe('findFactRowLoss', () => {
    it('ignores tables without an explicit detail-row contract', () => {
        expect(findFactRowLoss([{ Label: 'A', Total: 1 }], [])).toBeNull();
    });

    it('allows removing non-detail rows', () => {
        expect(findFactRowLoss(table, table.filter(entry => entry.RowClass === 'fact'))).toBeNull();
    });

    it('reports a lost detail row with its source coordinates, even when it carries no measure', () => {
        const loss = findFactRowLoss(table, table.filter(entry => entry.Label !== 'C'));
        expect(loss).toMatchObject({ factRowsBefore: 3, factRowsAfter: 2, lostFactRows: 1, lostSourceRowIndexes: [4] });
    });

    it('treats a dropped RowClass column as lost detail rows', () => {
        const withoutClass = table.map(({ RowClass: _removed, ...rest }) => rest);
        expect(findFactRowLoss(table, withoutClass)?.lostFactRows).toBe(3);
    });

    it('throws a typed error naming the stage', () => {
        expect(() => assertFactRowsPreserved(table, table.slice(0, 2), 'sandbox cleaning code'))
            .toThrow(FactRowLossError);
        expect(() => assertFactRowsPreserved(table, table, 'x')).not.toThrow();
        expect(() => assertFactRowsPreserved(null, [], 'x')).not.toThrow();
    });
});

describe('default analysis view for hierarchy tables', () => {
    const data: CsvData = {
        fileName: 'h.csv',
        data: [
            row('ASEAN', 'subtotal', 1, 30),
            row('A', 'fact', 2, 10),
            row('B', 'fact', 3, 20),
            row('C', 'fact', 4, 5),
        ],
        metadataRows: [], headerLayers: [], summaryRows: [], headerDepth: 1,
    };

    it('never hides a RowClass fact row because a model labelled it a note or subtotal', () => {
        const snapshot = sanitizeDatasetSemanticSnapshot({
            rowAnnotations: [
                { rowIndex: 1, rowRole: 'note', confidence: 0.99, reason: 'comment' },
                { rowIndex: 2, rowRole: 'subtotal', confidence: 0.95, reason: 'sum' },
            ],
        } as never, data, 'm', 'v1');
        expect(snapshot.recommendedAnalysisView.excludedRowIndices).toEqual([0]);
        expect(snapshot.recommendedAnalysisView.includedRowIndices).toEqual([1, 2, 3]);
    });

    it('still honours model labels on tables that carry no explicit detail rows', () => {
        const plain: CsvData = { ...data, data: data.data.map(({ Label, Total }) => ({ Label, Total })) };
        const snapshot = sanitizeDatasetSemanticSnapshot({
            rowAnnotations: [{ rowIndex: 1, rowRole: 'note', confidence: 0.95, reason: 'comment' }],
        } as never, plain, 'm', 'v1');
        expect(snapshot.recommendedAnalysisView.excludedRowIndices).toContain(1);
    });
});
