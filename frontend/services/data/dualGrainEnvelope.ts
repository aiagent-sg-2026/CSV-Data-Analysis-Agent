import type { CandidateOutput, CandidateTable } from './candidateContract';
import { parseCandidateOutput } from './candidateContract';
import type { DualGrainCandidate, DualGrainRequest, DualGrainSourceCell, DualGrainValue } from './dualGrainCandidate';

/**
 * Converts only a freshly built candidate against the same request snapshot. The caller must
 * first use buildDualGrainCandidate: this pure conversion does not verify source bytes or
 * recompute the complete alignment set. `sourceName` is the execution receipt's source alias.
 * The result is an untrusted guest declaration, not a stage, validation, or approval.
 */
export const createDualGrainEnvelope = (
    candidate: DualGrainCandidate, request: DualGrainRequest, keyColumn: number, sourceName: string,
): CandidateOutput => {
    const fail = (): never => { throw new Error('dual_grain_envelope_invalid'); };
    const { intake, source, selection, confirmation } = request;
    const c = selection.candidate, raw = intake.rawRows;
    if (candidate.status !== 'untrusted' || candidate.source.sourceId !== source.sourceId
        || candidate.source.sha256 !== source.sha256 || candidate.source.alignmentFingerprint !== c.sourceFingerprint
        || confirmation.confirmed !== true || confirmation.sourceFingerprint !== c.sourceFingerprint
        || confirmation.mainStartColumn !== c.mainStartColumn || !Array.isArray(selection.alternatives)
        || c.groupCount < 1 || c.groupWidth < 1 || c.mainEndColumn !== c.mainStartColumn + c.groupCount * c.groupWidth
        || c.bodySourceRows.endExclusive <= c.bodySourceRows.start) fail();
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const columns = Array.from({ length: c.dataWidth }, (_, i) => i).filter(i => i < c.mainStartColumn || i >= c.mainEndColumn);
    if (!same(candidate.selection, selection) || !same(confirmation.mainFields.map(f => f.sourceColumn), columns)
        || !same(candidate.mainFields.map(({ name, sourceColumn }) => [name, sourceColumn]), confirmation.mainFields.map(({ name, sourceColumn }) => [name, sourceColumn]))
        || !same(candidate.groupFields, confirmation.groupFields) || candidate.groupFields.length !== c.groupWidth
        || !same(candidate.excludedRows, confirmation.excludedRows)) fail();
    const keyIndex = columns.indexOf(keyColumn);
    if (keyIndex < 0) fail();
    const keyName = candidate.mainFields[keyIndex].name;
    if (candidate.groupFields.some(f => f.name === keyName)) fail();
    const cell = (row: number, column: number): DualGrainSourceCell => {
        if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) || row < 0 || column < 0
            || !Object.hasOwn(raw[row] ?? [], column) || typeof raw[row][column] !== 'string') return fail();
        return { row, column, value: raw[row][column] };
    };
    const header = (column: number) => {
        const mapping = c.mappings[column];
        if (!mapping || mapping.targetColumn !== column || !Array.isArray(mapping.headerPath)) return fail();
        return mapping.headerPath.map(ref => cell(ref.rowIndex, ref.columnIndex));
    };
    candidate.mainFields.forEach(f => { if (!same(f.headerPath, header(f.sourceColumn))) fail(); });
    const bodyCount = c.bodySourceRows.endExclusive - c.bodySourceRows.start;
    if (candidate.main.length !== bodyCount || candidate.detail.length !== bodyCount * c.groupCount) fail();
    const excluded = new Set<number>();
    for (const entry of candidate.excludedRows) {
        if (!Number.isSafeInteger(entry.row) || entry.row < 0 || entry.row >= raw.length
            || entry.row >= c.bodySourceRows.start && entry.row < c.bodySourceRows.endExclusive
            || excluded.has(entry.row) || typeof entry.reason !== 'string' || !entry.reason.trim()) fail();
        excluded.add(entry.row);
    }
    if (excluded.size + bodyCount !== raw.length) fail();
    const table = (name: string, role: CandidateTable['role'], names: string[]): CandidateTable => ({
        name, role, schema: names.map(name => ({ name, dataType: 'string', nullable: false })), rowCount: 0, rows: [], lineage: [],
    });
    const entity = table('entity', 'dimension', candidate.mainFields.map(f => f.name));
    const fact = table('metrics', 'fact', [keyName, ...candidate.groupFields.map(f => f.name)]);
    const put = (target: CandidateTable, values: Array<{ name: string; value: DualGrainValue }>) => {
        const row = target.rows.length;
        target.rows.push(Object.fromEntries(values.map(v => [v.name, v.value.value])));
        for (const v of values) target.lineage.push({ row, column: v.name, origins: [{ kind: 'source', name: sourceName, row: v.value.origin.row, column: v.value.origin.column }] });
        target.rowCount++;
    };
    const keys = new Set<string>();
    for (let i = 0; i < bodyCount; i++) {
        const row = c.bodySourceRows.start + i, main = candidate.main[i];
        if (!main || main.sourceRow !== row || main.id !== JSON.stringify([source.sourceId, source.sha256, row])
            || main.values.length !== columns.length) fail();
        const expected = columns.map(column => { const origin = cell(row, column); return { value: origin.value, origin }; });
        if (!same(main.values, expected)) fail();
        const key = main.values[keyIndex];
        if (!key.value.trim() || keys.has(key.value)) throw new Error('dual_grain_identifier_invalid');
        keys.add(key.value);
        put(entity, candidate.mainFields.map((f, index) => ({ name: f.name, value: main.values[index] })));
        for (let group = 0; group < c.groupCount; group++) {
            const detail = candidate.detail[i * c.groupCount + group], start = c.mainStartColumn + group * c.groupWidth;
            if (!detail || detail.mainId !== main.id || detail.group !== group
                || detail.id !== JSON.stringify([source.sourceId, source.sha256, row, group])
                || !same(detail.headerPath, header(start)) || detail.values.length !== c.groupWidth) fail();
            const expectedValues = candidate.groupFields.map((_, position) => {
                const origin = cell(row, start + position); return { value: origin.value, origin, headerPath: header(start + position) };
            });
            if (!same(detail.values, expectedValues)) fail();
            put(fact, [{ name: keyName, value: key }, ...candidate.groupFields.map((f, index) => ({ name: f.name, value: detail.values[index] }))]);
        }
    }
    return parseCandidateOutput(JSON.stringify({ schemaVersion: 1, complete: true, tables: [entity, fact],
        relationships: [{ fromTable: 'entity', toTable: 'metrics', fromKeys: [keyName], toKeys: [keyName], cardinality: 'one_to_many' }],
        excludedRows: candidate.excludedRows.map(e => ({ origin: { kind: 'source', name: sourceName, row: e.row }, reason: e.reason })) }));
};
