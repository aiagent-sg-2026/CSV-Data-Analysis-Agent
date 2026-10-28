import type { CsvRow } from '../../types';
import type { CandidateOutput, CandidateCellOrigin, CandidateRelationship } from './candidateContract';
import type { CandidateMeaningProposal } from './inferredCandidateMeaning';
import { convertValidationCell, validateCandidateSemantics, type CandidateValidationContract, type ValidationInputs } from './candidateValidation';

/** Bounded source-coordinate proposal, not an oracle, execution receipt or commit grant.
 * This compiler is deliberately not exposed by candidate.infer_meaning yet: streaming storage,
 * source-bound semantic selection and atomic multi-table activation must land together first.
 */
export interface DualGrainCandidateMeaning {
    input: { kind: 'source'; name: string };
    tables: Array<{
        name: string;
        grain: string[];
        groupBy: string[];
        columns: Array<Omit<CandidateMeaningProposal['table']['columns'][number], 'sourceColumn'> & {
            header: { row: number; column: number };
        }>;
        detailRanges: Array<{ start: number; end: number }>;
        // Each projection emits one row per original detail record. Fixed header coordinates
        // supply dimensions without synthesized period/category values or lost lineage.
        projections: Array<Array<{ column: string; sourceColumn: number; sourceRow?: number }>>;
    }>;
    relationships: CandidateRelationship[];
    exclusions: CandidateMeaningProposal['exclusions'];
    assumptions: string[];
}
export const DUAL_GRAIN_MEANING_LIMITS = Object.freeze({ sourceRows: 50000, sourceCells: 200000, outputRows: 50000, outputCells: 80000, projections: 256 });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, required: string[], optional: string[] = []) => object(v)
    && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim() && v.length <= 240
    && !['__proto__', 'constructor', 'prototype'].includes(v);
const index = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < 50000;
const names = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 24 && v.every(text) && new Set(v).size === v.length;
export const isDualGrainCandidateMeaning = (value: unknown): value is DualGrainCandidateMeaning => {
    if (!exact(value, ['input', 'tables', 'relationships', 'exclusions', 'assumptions'])) return false;
    const p = value as DualGrainCandidateMeaning;
    return exact(p.input, ['kind', 'name']) && p.input.kind === 'source' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(p.input.name) && text(p.input.name)
        && Array.isArray(p.tables) && p.tables.length === 2 && new Set(p.tables.map(t => t?.name)).size === 2
        && p.tables.every(t => exact(t, ['name', 'grain', 'groupBy', 'columns', 'detailRanges', 'projections']) && text(t.name)
            && names(t.grain) && t.grain.length > 0 && names(t.groupBy) && Array.isArray(t.columns) && t.columns.length > 0 && t.columns.length <= 256
            && t.columns.every(c => exact(c, ['name', 'dataType', 'nullable', 'conversion', 'header'], ['scale', 'unit']) && text(c.name)
                && ['string', 'number', 'date', 'boolean'].includes(c.dataType) && typeof c.nullable === 'boolean'
                && ['identity', 'trim', 'decimal', 'decimal_or_null', 'iso_date'].includes(c.conversion)
                && (c.scale === undefined || Number.isInteger(c.scale) && c.scale >= 0 && c.scale <= 6) && (c.unit === undefined || text(c.unit))
                && exact(c.header, ['row', 'column']) && index(c.header.row) && index(c.header.column))
            && Array.isArray(t.detailRanges) && t.detailRanges.length > 0 && t.detailRanges.length <= 256
            && t.detailRanges.every(r => exact(r, ['start', 'end']) && index(r.start) && index(r.end) && r.end >= r.start)
            && Array.isArray(t.projections) && t.projections.length > 0 && t.projections.length <= DUAL_GRAIN_MEANING_LIMITS.projections
            && t.projections.every(projection => Array.isArray(projection) && projection.length === t.columns.length
                && projection.every(c => exact(c, ['column', 'sourceColumn'], ['sourceRow']) && text(c.column) && index(c.sourceColumn)
                    && (c.sourceRow === undefined || index(c.sourceRow)))))
        && Array.isArray(p.relationships) && p.relationships.length === 1 && p.relationships.every(r => exact(r, ['fromTable', 'toTable', 'fromKeys', 'toKeys', 'cardinality'])
            && text(r.fromTable) && text(r.toTable) && names(r.fromKeys) && names(r.toKeys) && r.fromKeys.length > 0 && r.fromKeys.length === r.toKeys.length
            && r.cardinality === 'many_to_one')
        && Array.isArray(p.exclusions) && p.exclusions.length <= 2048 && p.exclusions.every(e => exact(e, ['row', 'role'], ['duplicateOf']) && index(e.row)
            && ['header', 'note', 'subtotal', 'grand_total', 'duplicate'].includes(e.role) && (e.duplicateOf === undefined || index(e.duplicateOf)))
        && Array.isArray(p.assumptions) && p.assumptions.length <= 12 && p.assumptions.every(text);
};

/** Independently builds values from complete ORIGINAL input, before any guest output exists.
 * A structurally valid result still has a semantic ambiguity gate. No caller can obtain an
 * accepted/draft-ready contract from this function by passing a model-provided "confirmed" flag.
 */
export const compileDualGrainCandidateMeaning = (proposal: DualGrainCandidateMeaning, inputs: ValidationInputs) => {
    if (!isDualGrainCandidateMeaning(proposal)) throw new Error('meaning_proposal_invalid');
    const p = structuredClone(proposal), raw = inputs.sources[p.input.name];
    if (!raw?.length || raw.length > DUAL_GRAIN_MEANING_LIMITS.sourceRows || Object.keys(inputs.tables).length
        || Object.keys(inputs.sources).length !== 1) throw new Error('meaning_complete_input_unavailable');
    let inputCells = 0;
    for (const row of raw) {
        inputCells += row.length;
        if (inputCells > DUAL_GRAIN_MEANING_LIMITS.sourceCells) throw new Error('meaning_resource_limit');
    }
    const origin = (row: number, column: number): CandidateCellOrigin => ({ kind: 'source', name: p.input.name, row, column });
    const read = (row: number, column: number) => {
        if (!raw[row] || !Object.hasOwn(raw[row], column)) throw new Error('meaning_mapping_invalid');
        return raw[row][column];
    };
    const excluded = new Map(p.exclusions.map(e => [e.row, e]));
    if (excluded.size !== p.exclusions.length || p.exclusions.some(e => e.row >= raw.length)) throw new Error('meaning_row_scope_invalid');
    const contract: CandidateValidationContract = { version: 1, ambiguities: [], completeSourceCells: true, tables: [], relationships: [], exclusions: [] };
    const reference: CandidateOutput = { schemaVersion: 1, complete: true, tables: [], relationships: p.relationships, excludedRows: [] };
    let outputRows = 0, outputCells = 0;
    for (const spec of p.tables) {
        const columns = spec.columns.map(c => c.name);
        if (new Set(columns).size !== columns.length || [...spec.grain, ...spec.groupBy].some(k => !columns.includes(k))
            || spec.grain.some(k => !spec.columns.some(c => c.name === k && ['string', 'date'].includes(c.dataType)))) throw new Error('meaning_grain_unresolved');
        for (const c of spec.columns) {
            if (excluded.get(c.header.row)?.role !== 'header' || read(c.header.row, c.header.column) !== c.name) throw new Error('meaning_header_unverified');
            if (c.dataType === 'number' && (!c.unit || !c.name.includes(`[${c.unit}]`) || !['decimal', 'decimal_or_null'].includes(c.conversion)
                || c.scale === undefined || c.conversion === 'decimal_or_null' && !c.nullable)
                || c.dataType !== 'number' && (c.unit !== undefined || c.scale !== undefined || ['decimal', 'decimal_or_null'].includes(c.conversion))) throw new Error('meaning_unit_or_type_unresolved');
        }
        const sourceRows: number[] = [];
        for (const range of spec.detailRanges) {
            if (range.end >= raw.length || sourceRows.length && range.start <= sourceRows[sourceRows.length - 1]) throw new Error('meaning_row_scope_invalid');
            const size = range.end - range.start + 1;
            // Reserve before expanding rows or projections; large declarations cannot allocate first.
            outputRows += size * spec.projections.length;
            outputCells += size * spec.projections.length * columns.length;
            if (outputRows > DUAL_GRAIN_MEANING_LIMITS.outputRows || outputCells > DUAL_GRAIN_MEANING_LIMITS.outputCells) throw new Error('meaning_resource_limit');
            for (let row = range.start; row <= range.end; row++) {
                if (excluded.has(row)) throw new Error('meaning_row_scope_invalid');
                sourceRows.push(row);
            }
        }
        const schema = spec.columns.map(({ name, dataType, nullable }) => ({ name, dataType, nullable }));
        const table: CandidateValidationContract['tables'][number] = { name: spec.name, role: 'fact', schema, grain: spec.grain, groupBy: spec.groupBy,
            metrics: spec.columns.filter(c => c.dataType === 'number').map(c => ({ column: c.name, scale: c.scale!, toleranceMinor: 0, unit: c.unit! })),
            mutableColumns: spec.columns.filter(c => c.conversion !== 'identity').map(c => c.name), rows: [] };
        const rows: CsvRow[] = [];
        for (const row of sourceRows) for (const projection of spec.projections) {
            if (new Set(projection.map(c => c.column)).size !== columns.length || projection.some(c => !columns.includes(c.column))) throw new Error('meaning_mapping_invalid');
            const cells = spec.columns.map(c => {
                const mapping = projection.find(m => m.column === c.name)!;
                if (mapping.sourceRow !== undefined && (excluded.get(mapping.sourceRow)?.role !== 'header' || c.dataType === 'number')) throw new Error('meaning_header_unverified');
                return { column: c.name, origin: origin(mapping.sourceRow ?? row, mapping.sourceColumn), conversion: c.conversion, scale: c.scale };
            });
            table.rows.push({ cells });
            rows.push(Object.fromEntries(cells.map(c => [c.column, convertValidationCell(read(c.origin.row, Number(c.origin.column)), c)])));
        }
        contract.tables.push(table);
        reference.tables.push({ name: spec.name, role: 'fact', schema, rowCount: rows.length, rows,
            lineage: table.rows.flatMap((r, row) => r.cells.map(c => ({ row, column: c.column, origins: [c.origin] }))) });
    }
    const [primary, detail] = contract.tables;
    const relationship = p.relationships[0];
    if (relationship.fromTable !== detail.name || relationship.toTable !== primary.name
        || JSON.stringify(relationship.toKeys) !== JSON.stringify(primary.grain)) throw new Error('meaning_relationship_unresolved');
    contract.relationships = [{ ...relationship, maxAmplification: 1, requireCoverage: true }];
    for (const e of p.exclusions) {
        if (e.role === 'note' && raw[e.row].some(v => v.trim() !== '')) throw new Error('meaning_note_contains_unverified_cells');
        // Footer roles/scopes need their own source-bound semantic decision and alignment.
        // Never use a matching total, label heuristic, or padding to silently establish either.
        if (e.role === 'subtotal' || e.role === 'grand_total') throw new Error('meaning_dual_grain_footer_alignment_unsupported');
        contract.exclusions.push({ origin: { kind: 'source', name: p.input.name, row: e.row }, role: e.role, checks: [],
            ...(e.duplicateOf === undefined ? {} : { duplicateOf: { kind: 'source' as const, name: p.input.name, row: e.duplicateOf } }) });
        reference.excludedRows.push({ origin: { kind: 'source', name: p.input.name, row: e.row }, reason: e.role });
    }
    const verdict = validateCandidateSemantics(reference, contract, inputs);
    if (verdict.decision !== 'validated') throw new Error(verdict.reasonCodes.join(',') || 'meaning_reference_invalid');
    // This unresolved gate is intentional until normal Pi's exact A/B meaning selection can
    // bind this entire proposal. It is distinct from later exact Dataset Commit approval.
    contract.ambiguities = ['dual_grain_business_roles_require_source_bound_confirmation'];
    return { contract, reference, structuralVerdict: verdict, assumptions: p.assumptions };
};
