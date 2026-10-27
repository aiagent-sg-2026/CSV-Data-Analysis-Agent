import { describe, expect, it } from 'vitest';
import { buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { solveHeaderAlignment } from '../services/agent/headerAlignment';
import { buildDualGrainCandidate, type DualGrainRequest } from '../services/data/dualGrainCandidate';
import { createDualGrainEnvelope } from '../services/data/dualGrainEnvelope';
import { parseCandidateOutput } from '../services/data/candidateContract';

const fixture = async (count: number, keys = Array.from({ length: count }, (_, i) => `id-${i}`)) => {
    const groups = Array.from({ length: 12 }, (_, i) => `band-${i}`);
    const fields = Array.from({ length: 5 }, (_, i) => `measure-${i}`);
    const intake = buildReportIntakeIr('fictional.csv', [
        ['Entity', ...groups, ...groups],
        groups.flatMap(() => fields),
        ...keys.map((key, i) => [key, ...groups.flatMap((_, g) => ['0', `-${i + 1}`, '-', '', `${g}.25`]), ...groups.map(() => 'attribute')]),
        ...Array.from({ length: 5 }, (_, i) => [`summary-${i}`]),
    ]);
    const { candidates } = await solveHeaderAlignment(intake);
    const candidate = candidates[0];
    const request: DualGrainRequest = {
        intake, source: { sourceId: 'fictional-source', sha256: 'a'.repeat(64) }, verifySource: () => true,
        selection: { candidate, alternatives: candidates.slice(1) },
        confirmation: { confirmed: true, sourceFingerprint: candidate.sourceFingerprint, mainStartColumn: candidate.mainStartColumn,
            mainFields: [0, ...Array.from({ length: 12 }, (_, i) => 61 + i)].map(sourceColumn => ({ sourceColumn, name: `field-${sourceColumn}` })),
            groupFields: fields.map((name, i) => ({ name, kind: i === 4 ? 'nonadditive' : 'additive' })),
            excludedRows: [0, 1, ...Array.from({ length: 5 }, (_, i) => count + 2 + i)].map(row => ({ row, reason: 'reviewed non-body row' })) },
    };
    return { request, candidate: await buildDualGrainCandidate(request) };
};

describe('untrusted dual-grain CandidateOutput envelope', () => {
    it.each([2, 3])('preserves every source body cell and joins %i entities to twelve bands', async count => {
        const { request, candidate } = await fixture(count);
        const envelope = createDualGrainEnvelope(candidate, request, 0, 'raw');
        const parsed = parseCandidateOutput(JSON.stringify(envelope));
        const [entity, fact] = parsed.tables;
        expect(candidate.status).toBe('untrusted');
        expect(entity.rows).toHaveLength(count);
        expect(fact.rows).toHaveLength(count * 12);
        expect(fact.rows.length * 5).toBe(count * 12 * 5);
        expect(fact.schema.every(s => s.dataType === 'string')).toBe(true);
        expect(fact.rows[0]).toMatchObject({ 'field-0': 'id-0', 'measure-0': '0', 'measure-1': '-1', 'measure-2': '-', 'measure-3': '' });
        expect(fact.rows.every(r => entity.rows.some(e => e['field-0'] === r['field-0']))).toBe(true);
        expect(parsed.relationships).toEqual([{ fromTable: 'entity', toTable: 'metrics', fromKeys: ['field-0'], toKeys: ['field-0'], cardinality: 'one_to_many' }]);
        const origins = new Set(parsed.tables.flatMap(t => t.lineage.flatMap(l => l.origins.map(o => `${o.row}:${o.column}`))));
        const expected = request.intake.rawRows.slice(2, count + 2).flatMap((row, i) => row.map((_, col) => `${i + 2}:${col}`));
        expect(origins).toEqual(new Set(expected));
        expect(parsed.excludedRows.filter(e => e.origin.row >= count + 2)).toHaveLength(5);
        expect(parsed.excludedRows.map(e => e.origin.row)).toEqual([0, 1, ...Array.from({ length: 5 }, (_, i) => count + 2 + i)]);
        expect(Object.keys(envelope).sort()).toEqual(['complete', 'excludedRows', 'relationships', 'schemaVersion', 'tables']);
    });
    it.each([['duplicate', ['same', 'same']], ['empty', ['id', '  ']]])('rejects %s identifiers', async (_, keys) => {
        const { request, candidate } = await fixture(2, keys);
        expect(() => createDualGrainEnvelope(candidate, request, 0, 'raw')).toThrow('dual_grain_identifier_invalid');
    });
    it('rejects stale confirmation, changed source, missing rows and forged cell provenance', async () => {
        const { request, candidate } = await fixture(2);
        const stale = structuredClone(request.confirmation); stale.sourceFingerprint = 'stale';
        expect(() => createDualGrainEnvelope(candidate, { ...request, confirmation: stale }, 0, 'raw')).toThrow();
        expect(() => createDualGrainEnvelope(candidate, { ...request, source: { ...request.source, sha256: 'b'.repeat(64) } }, 0, 'raw')).toThrow();
        const missing = structuredClone(candidate); missing.excludedRows.pop();
        expect(() => createDualGrainEnvelope(missing, request, 0, 'raw')).toThrow();
        const forged = structuredClone(candidate); forged.detail[0].values[0].origin.column++;
        expect(() => createDualGrainEnvelope(forged, request, 0, 'raw')).toThrow();
        expect(() => createDualGrainEnvelope(candidate, { ...request, selection: { ...request.selection, alternatives: [...request.selection.alternatives, request.selection.candidate] } }, 0, 'raw')).toThrow();
        expect(() => createDualGrainEnvelope(candidate, request, 1, 'raw')).toThrow();
    });
});
