import type { ReportIntakeIr } from '../../types/intake';
import type { HeaderAlignmentCandidateV1, HeaderAlignmentCell } from '../../types/headerAlignment';
import { solveHeaderAlignment, validateHeaderAlignment } from '../agent/headerAlignment';

export type DualGrainMeasureKind = 'additive' | 'nonadditive' | 'dimension';
export interface DualGrainField { name: string; kind: DualGrainMeasureKind }
export interface DualGrainSourceCell { row: number; column: number; value: string }
export interface DualGrainValue { value: string; origin: DualGrainSourceCell }

/** An untrusted materialization, not a CandidateOutput, staging receipt, or approval. */
export interface DualGrainCandidate {
    status: 'untrusted';
    source: { sourceId: string; sha256: string; alignmentFingerprint: string };
    mainFields: Array<{ name: string; sourceColumn: number; headerPath: DualGrainSourceCell[] }>;
    groupFields: DualGrainField[];
    main: Array<{ id: string; sourceRow: number; values: DualGrainValue[] }>;
    relationship: { from: 'detail'; to: 'main'; fromKey: 'mainId'; toKey: 'id'; cardinality: 'many_to_one' };
    detail: Array<{ id: string; mainId: string; group: number; headerPath: DualGrainSourceCell[]; values: Array<DualGrainValue & { headerPath: DualGrainSourceCell[] }> }>;
    excludedRows: Array<{ row: number; reason: string }>;
}

export interface DualGrainRequest {
    intake: ReportIntakeIr;
    source: { sourceId: string; sha256: string };
    /** Host must independently verify the source identity AND that rawRows are its complete parsed records. */
    verifySource: (source: { sourceId: string; sha256: string }, rawRows: readonly (readonly string[])[]) => boolean | Promise<boolean>;
    selection: { candidate: HeaderAlignmentCandidateV1; alternatives: HeaderAlignmentCandidateV1[] };
    /** Explicit semantic review of this precise structural fingerprint and selected alignment. */
    confirmation: {
        confirmed: true;
        sourceFingerprint: string;
        mainStartColumn: number;
        mainFields: Array<{ name: string; sourceColumn: number }>;
        groupFields: DualGrainField[];
        excludedRows: Array<{ row: number; reason: string }>;
    };
}

const validName = (name: unknown): name is string => typeof name === 'string' && name.trim().length > 0
    && name.length <= 240 && !['__proto__', 'prototype', 'constructor'].includes(name);

/** Structural alignment and caller confirmation do not prove business meaning. No commit path is provided. */
export const buildDualGrainCandidate = async (request: DualGrainRequest): Promise<DualGrainCandidate> => {
    // Freeze a private snapshot across asynchronous host verification and alignment recomputation.
    const intake = structuredClone(request.intake);
    const source = structuredClone(request.source);
    const selection = structuredClone(request.selection);
    const confirmation = structuredClone(request.confirmation);
    if (!validName(source?.sourceId) || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '') || typeof request.verifySource !== 'function'
        || !await request.verifySource(structuredClone(source), structuredClone(intake.rawRows))) throw new Error('dual_grain_source_unverified');
    const result = await solveHeaderAlignment(intake);
    if (result.status !== 'semantic_review_required' || result.ambiguities.some(a => a === 'candidate_limit_reached' || a === 'header_scan_limited'))
        throw new Error('dual_grain_alignment_incomplete');
    if (!selection || !Array.isArray(selection.alternatives)
        || !(await validateHeaderAlignment(intake, selection.candidate, selection.alternatives)).valid)
        throw new Error('dual_grain_selection_invalid');
    const c = selection.candidate;
    if (!confirmation || confirmation.confirmed !== true || confirmation.sourceFingerprint !== c.sourceFingerprint
        || confirmation.mainStartColumn !== c.mainStartColumn || !Array.isArray(confirmation.mainFields)
        || !Array.isArray(confirmation.groupFields) || !Array.isArray(confirmation.excludedRows))
        throw new Error('dual_grain_confirmation_required');
    const mainColumns = Array.from({ length: c.dataWidth }, (_, i) => i).filter(i => i < c.mainStartColumn || i >= c.mainEndColumn);
    const mainFields = confirmation.mainFields;
    const groupFields = confirmation.groupFields;
    if (mainFields.length !== mainColumns.length || groupFields.length !== c.groupWidth
        || mainFields.some((f, i) => !f || !validName(f.name) || f.sourceColumn !== mainColumns[i])
        || groupFields.some(f => !f || !validName(f.name) || !['additive', 'nonadditive', 'dimension'].includes(f.kind))
        || new Set(mainFields.map(f => f.name)).size !== mainFields.length
        || new Set(groupFields.map(f => f.name)).size !== groupFields.length)
        throw new Error('dual_grain_mapping_invalid');
    const excluded = new Set<number>();
    for (const entry of confirmation.excludedRows) {
        if (!entry || !Number.isSafeInteger(entry.row) || entry.row < 0 || entry.row >= intake.rawRows.length
            || entry.row >= c.bodySourceRows.start && entry.row < c.bodySourceRows.endExclusive
            || excluded.has(entry.row) || typeof entry.reason !== 'string' || !entry.reason.trim())
            throw new Error('dual_grain_exclusion_invalid');
        excluded.add(entry.row);
    }
    if (excluded.size + c.bodySourceRows.endExclusive - c.bodySourceRows.start !== intake.rawRows.length)
        throw new Error('dual_grain_coverage_incomplete');
    const cell = (row: number, column: number): DualGrainSourceCell => {
        if (!Object.hasOwn(intake.rawRows[row] ?? [], column)) throw new Error('dual_grain_mapping_invalid');
        return { row, column, value: intake.rawRows[row][column] };
    };
    const value = (row: number, column: number): DualGrainValue => {
        const origin = cell(row, column); return { value: origin.value, origin };
    };
    const header = (ref: HeaderAlignmentCell) => cell(ref.rowIndex, ref.columnIndex);
    const main: DualGrainCandidate['main'] = [], detail: DualGrainCandidate['detail'] = [];
    for (let row = c.bodySourceRows.start; row < c.bodySourceRows.endExclusive; row++) {
        const id = JSON.stringify([source.sourceId, source.sha256, row]);
        main.push({ id, sourceRow: row, values: mainFields.map(f => value(row, f.sourceColumn)) });
        for (let group = 0; group < c.groupCount; group++) {
            const start = c.mainStartColumn + group * c.groupWidth;
            detail.push({ id: JSON.stringify([source.sourceId, source.sha256, row, group]), mainId: id, group,
                headerPath: c.mappings[start].headerPath.map(header),
                values: groupFields.map((_, position) => ({ ...value(row, start + position), headerPath: c.mappings[start + position].headerPath.map(header) })) });
        }
    }
    return { status: 'untrusted', source: { ...source, alignmentFingerprint: c.sourceFingerprint },
        mainFields: mainFields.map(f => ({ ...f, headerPath: c.mappings[f.sourceColumn].headerPath.map(header) })), groupFields, main, detail,
        relationship: { from: 'detail', to: 'main', fromKey: 'mainId', toKey: 'id', cardinality: 'many_to_one' },
        excludedRows: confirmation.excludedRows };
};
