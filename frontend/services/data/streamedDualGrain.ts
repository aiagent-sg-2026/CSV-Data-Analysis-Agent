import type { CsvRow } from '../../types';
import type { StoreApi } from '../agent/types';
import type { DualGrainCandidateMeaning } from './dualGrainCandidateMeaning';
import { isDualGrainCandidateMeaning } from './dualGrainCandidateMeaning';
import { convertValidationCell, type CandidateSemanticVerdict } from './candidateValidation';
import { inspectSourceMeaning } from '../agent/execution/codeSourceRecordStream';
import type { SourceSpillCapability } from './spillCandidateValidation';
import { codeDigest } from '../agent/execution/codeTableInputs';

/** Same-record entity/metric projections only. Strict ordered source keys prove global
 * uniqueness without retaining a source-sized key map. Arbitrary joins/document groups
 * need an external index and are deliberately not admitted by this streaming lane. */
export interface StreamedDualMeaning {
    version: 1; kind: 'ordered-dual-projections'; proposal: DualGrainCandidateMeaning;
    width: number; headers: Record<string, string[]>; counts: number[];
}
const fail = (reason: string): never => { throw new Error(`validation_dual_${reason}`); };
export const dualSchema = (t: DualGrainCandidateMeaning['tables'][number]) => t.columns.map(({ name, dataType, nullable }) => ({ name, dataType, nullable }));
export const dualMetrics = (t: DualGrainCandidateMeaning['tables'][number]) => t.columns.filter(c => c.dataType === 'number').map(c => ({ column: c.name, scale: c.scale!, unit: c.unit!, toleranceMinor: 0 }));
export const dualSourceRows = (t: DualGrainCandidateMeaning['tables'][number]) => t.detailRanges.reduce((n, r) => n + r.end - r.start + 1, 0);
export const dualSourceRow = (t: DualGrainCandidateMeaning['tables'][number], ordinal: number) => {
    let n = Math.floor(ordinal / t.projections.length);
    for (const r of t.detailRanges) { if (n <= r.end - r.start) return r.start + n; n -= r.end - r.start + 1; }
    return fail('page_bounds');
};
export const dualOrdinal = (t: DualGrainCandidateMeaning['tables'][number], row: number) => {
    let n = 0;
    for (const r of t.detailRanges) { if (row >= r.start && row <= r.end) return (n + row - r.start) * t.projections.length; n += r.end - r.start + 1; }
    return -1;
};
export const dualProjectedRow = (m: StreamedDualMeaning, table: number, projection: number, sourceRow: number, cells: string[]): CsvRow => {
    const spec = m.proposal.tables[table], mapping = spec.projections[projection];
    return Object.fromEntries(spec.columns.map(c => {
        const p = mapping.find(x => x.column === c.name)!;
        const raw = (p.sourceRow === undefined ? cells : m.headers[p.sourceRow])?.[p.sourceColumn];
        if (raw === undefined) return fail('mapping_missing');
        const value = convertValidationCell(raw, { column: c.name, conversion: c.conversion, scale: c.scale,
            origin: { kind: 'source', name: m.proposal.input.name, row: p.sourceRow ?? sourceRow, column: p.sourceColumn } });
        if (c.dataType === 'number' && value !== null && decimalMinor(raw, c.scale!) !== decimalMinor(String(value), c.scale!)) fail('decimal_precision');
        return [c.name, value];
    }));
};
export const decimalMinor = (raw: string, scale: number): bigint => {
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return fail('numeric_invalid');
    const [whole, fraction = ''] = raw.replace(/^-/, '').split('.');
    if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return fail('decimal_precision');
    return (raw.startsWith('-') ? -1n : 1n) * BigInt(whole + fraction.slice(0, scale).padEnd(scale, '0'));
};
const numeric = (v: string) => /^(?:(?:[-+(]|\p{Sc}|USD|EUR|GBP|JPY|CNY|RMB|SGD|MYR)\s*)*(?:\d|\.\d)/u.test(v.trim());

export const createDualScan = (proposal: DualGrainCandidateMeaning, recordCount: number) => {
    if (!isDualGrainCandidateMeaning(proposal) || proposal.input.name !== 'original' || new TextEncoder().encode(JSON.stringify(proposal)).length > 65536) fail('proposal');
    const p = structuredClone(proposal), [primary, detail] = p.tables, r = p.relationships[0];
    if (primary.projections.length !== 1 || primary.grain.length !== 1 || detail.grain.length !== 2
        || JSON.stringify(primary.detailRanges) !== JSON.stringify(detail.detailRanges)
        || r.fromTable !== detail.name || r.toTable !== primary.name || r.cardinality !== 'many_to_one'
        || JSON.stringify(r.toKeys) !== JSON.stringify(primary.grain) || r.fromKeys.length !== 1 || detail.grain[0] !== r.fromKeys[0]) fail('unsupported_key_or_join');
    const excluded = new Map(p.exclusions.map(e => [e.row, e]));
    if (excluded.size !== p.exclusions.length || p.exclusions.some(e => e.row >= recordCount || !['header', 'note', 'grand_total'].includes(e.role))) fail('exclusion');
    let last = -1;
    for (const range of primary.detailRanges) { if (range.start <= last || range.end >= recordCount) fail('ranges'); last = range.end; }
    const key = primary.columns.find(c => c.name === primary.grain[0]);
    const keyMapping = primary.projections[0].find(c => c.column === primary.grain[0]);
    if (!key || key.dataType !== 'string' || key.nullable || key.conversion !== 'identity' || !keyMapping || keyMapping.sourceRow !== undefined) fail('unsupported_key_or_join');
    const headers: Record<string, string[]> = {}, counts = p.tables.map(t => dualSourceRows(t) * t.projections.length);
    const headerRows = new Set(p.tables.flatMap(t => [...t.columns.map(c => c.header.row), ...t.projections.flatMap(proj => proj.flatMap(c => c.sourceRow === undefined ? [] : [c.sourceRow]))]));
    const dynamic = new Set<number>(), owners = new Map<number, string>();
    for (const t of p.tables) {
        if (new Set(t.columns.map(c => c.name)).size !== t.columns.length || [...t.grain, ...t.groupBy].some(k => !t.columns.some(c => c.name === k))) fail('schema');
        for (const c of t.columns) {
            if (excluded.get(c.header.row)?.role !== 'header' || c.header.row >= primary.detailRanges[0].start) fail('header');
            if (c.dataType === 'number' ? !c.unit || !c.name.includes(`[${c.unit}]`) || c.scale === undefined || !['decimal', 'decimal_or_null'].includes(c.conversion) || c.conversion === 'decimal_or_null' && !c.nullable
                : c.dataType !== 'string' || c.scale !== undefined || c.unit !== undefined || !['identity', 'trim'].includes(c.conversion)) fail('unit_or_type');
        }
        for (const proj of t.projections) {
            if (new Set(proj.map(c => c.column)).size !== t.columns.length || proj.some(c => !t.columns.some(col => col.name === c.column))) fail('mapping');
            for (const c of t.columns) {
                const map = proj.find(m => m.column === c.name)!;
                if (map.sourceRow !== undefined) {
                    if (excluded.get(map.sourceRow)?.role !== 'header' || map.sourceRow >= primary.detailRanges[0].start || c.dataType === 'number') fail('header');
                } else {
                    dynamic.add(map.sourceColumn);
                    if (c.dataType === 'number') {
                        if (owners.has(map.sourceColumn)) fail('duplicate_cell_coverage');
                        owners.set(map.sourceColumn, `${t.name}:${c.name}`);
                    }
                }
            }
        }
    }
    for (const proj of detail.projections) {
        const fk = proj.find(c => c.column === r.fromKeys[0]), dim = proj.find(c => c.column === detail.grain[1]);
        if (!fk || fk.sourceRow !== undefined || fk.sourceColumn !== keyMapping!.sourceColumn
            || detail.columns.find(c => c.name === fk.column)?.conversion !== 'identity'
            || !dim || dim.sourceRow === undefined || detail.columns.find(c => c.name === dim.column)?.dataType !== 'string') fail('relationship');
    }
    const width = Math.max(...dynamic) + 1;
    if (width > 256 || dynamic.size !== width) fail('missing_cell_coverage');
    const m: StreamedDualMeaning = { version: 1, kind: 'ordered-dual-projections', proposal: p, width, headers, counts };
    const totals = p.tables.map(t => new Map(dualMetrics(t).map(c => [c.column, 0n])));
    let next = 0, previousKey: string | undefined, dimensionsChecked = false;
    const visit = (row: number, cells: string[]) => {
        if (row !== next++) fail('record_coverage');
        const e = excluded.get(row), ordinal = dualOrdinal(primary, row);
        if (e) {
            if (ordinal !== -1) fail('row_role_overlap');
            if (e.role === 'header') {
                if (cells.some(numeric)) fail('numeric_header');
                if (headerRows.has(row)) { headers[row] = [...cells]; if (new TextEncoder().encode(JSON.stringify(headers)).length > 65536) fail('header_capacity'); }
                else if (!Object.values(headers).some(h => JSON.stringify(h) === JSON.stringify(cells))) fail('repeated_header');
            } else if (e.role === 'note') { if (cells.some(c => c.trim())) fail('note'); }
            else {
                if (row <= last || !e.cells || e.cells.length !== cells.length || new Set(e.cells.map(c => c.column)).size !== cells.length) fail('footer_coverage');
                for (const c of e.cells) {
                    const raw = cells[c.column];
                    if (raw === undefined) fail('footer_coverage');
                    if (c.kind === 'label') { if (numeric(raw)) fail('numeric_footer_label'); }
                    else {
                        const ti = p.tables.findIndex(t => t.name === c.table), metric = ti < 0 ? undefined : dualMetrics(p.tables[ti]).find(x => x.column === c.metric);
                        if (!metric || decimalMinor(raw, metric.scale) !== totals[ti].get(c.metric)) fail('summary_reconciliation');
                    }
                }
            }
            return;
        }
        if (ordinal < 0 || cells.length !== width) fail('record_or_cell_coverage');
        if (!dimensionsChecked) {
            for (const t of p.tables) for (const c of t.columns) if (headers[c.header.row]?.[c.header.column] !== c.name) fail('header_evidence');
            const dims = detail.projections.map((_, i) => dualProjectedRow(m, 1, i, row, cells)[detail.grain[1]]);
            if (dims.some(v => typeof v !== 'string' || !v.trim()) || new Set(dims).size !== dims.length) fail('duplicate_grain');
            dimensionsChecked = true;
        }
        const id = cells[keyMapping!.sourceColumn];
        if (!id?.trim() || previousKey !== undefined && id <= previousKey) fail('key_not_strictly_ordered');
        previousKey = id;
        for (let ti = 0; ti < 2; ti++) for (let pi = 0; pi < p.tables[ti].projections.length; pi++) {
            const projected = dualProjectedRow(m, ti, pi, row, cells);
            for (const metric of dualMetrics(p.tables[ti])) if (projected[metric.column] !== null) totals[ti].set(metric.column, totals[ti].get(metric.column)! + decimalMinor(String(projected[metric.column]), metric.scale));
        }
    };
    return { meaning: m, visit, finish: (): CandidateSemanticVerdict => {
        if (next !== recordCount || !dimensionsChecked) fail('incomplete');
        return { decision: 'validated', reasonCodes: [], checks: ['complete-source-cell-coverage', 'strict-ordered-primary-key', 'unique-header-dimension', 'same-record-many-to-one', 'exact-decimal-null-unit', 'explicit-row-role-exclusions'],
            groups: p.tables.flatMap((t, i) => [...totals[i]].map(([metric, sum]) => ({ table: t.name, group: '[]', metric, expectedMinor: String(sum), actualMinor: String(sum) }))) };
    } };
};
export const compileStreamedDual = async (store: StoreApi, proposals: DualGrainCandidateMeaning[], current: () => void) => {
    const source = store.getState().datasetBundle!.source.inspection!, scans = proposals.map(p => createDualScan(p, source.recordCount));
    await inspectSourceMeaning(store, current, records => { for (const record of records) {
        if (record.diagnostics.length) fail('source_parse');
        for (const scan of scans) scan.visit(record.row, record.cells.map(c => c.value));
    } }, true); current(); scans.forEach(s => s.finish());
    return Promise.all(scans.map(async s => ({ meaning: s.meaning, digest: await codeDigest(s.meaning) })));
};
export const validateStreamedDual = async (cap: SourceSpillCapability, meaning: StreamedDualMeaning, current: () => void) => {
    const scan = createDualScan(meaning.proposal, cap.manifest.sourceRows);
    for await (const { records } of cap.inspectRows(current)) { current(); for (const r of records) scan.visit(r.row, r.cells.map(c => c.value)); }
    current(); const verdict = scan.finish();
    if (JSON.stringify(scan.meaning) !== JSON.stringify(meaning)) fail('meaning_changed');
    return verdict;
};
