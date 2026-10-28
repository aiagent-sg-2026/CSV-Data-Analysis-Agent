// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compileDualGrainCandidateMeaning, isDualGrainCandidateMeaning, type DualGrainCandidateMeaning } from '../services/data/dualGrainCandidateMeaning';
import { convertValidationCell, validateCandidateSemantics, type ValidationInputs } from '../services/data/candidateValidation';
import { parseCandidateOutput } from '../services/data/candidateContract';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';

// Fictional coordinate-shaped ERP; no customer names or external business truth.
const fixture = (width = 90, count = 3) => {
    const measureCount = width === 90 ? 60 : width === 60 ? 30 : 12;
    const primaryCount = width - measureCount;
    const header = ['Id', 'Metric', 'Cost [USD]', 'Net [USD]', ...Array.from({ length: primaryCount - 4 }, (_, i) => `Descriptor${i}`), ...Array(12).fill('Value [USD]')];
    const inner = Array.from({ length: measureCount }, (_, i) => `Period${Math.floor(i / 5) + 1}:Category${i % 5 + 1}`);
    const raw = [header, inner, ...Array.from({ length: count }, (_, i) => [
        `E${i + 1}`, `Label,\n${i + 1}`, ['250.00', '30.00', '120.00'][i % 3], ['-250.00', '-30.00', '-120.00'][i % 3],
        ...Array.from({ length: primaryCount - 4 }, (_, j) => `D${j}`),
        ...Array.from({ length: measureCount }, (_, j) => j === 0 ? '' : j === 1 ? '0.00' : j === 2 ? '-1.25' : `${i + 1}.01`),
    ])];
    const primaryColumns: DualGrainCandidateMeaning['tables'][number]['columns'] = header.slice(0, primaryCount).map((name, i) => ({ name,
        dataType: i === 2 || i === 3 ? 'number' : 'string', nullable: false, conversion: i === 2 || i === 3 ? 'decimal' : 'identity',
        ...(i === 2 || i === 3 ? { scale: 2, unit: 'USD' } : {}), header: { row: 0, column: i } }));
    const p: DualGrainCandidateMeaning = { input: { kind: 'source', name: 'original' }, tables: [
        { name: 'entities', grain: ['Id'], groupBy: [], columns: primaryColumns, detailRanges: [{ start: 2, end: raw.length - 1 }],
            projections: [primaryColumns.map((c, sourceColumn) => ({ column: c.name, sourceColumn }))] },
        { name: 'metrics', grain: ['Id', 'Metric'], groupBy: ['Metric'], columns: [primaryColumns[0], primaryColumns[1],
            { name: 'Value [USD]', dataType: 'number', nullable: true, conversion: 'decimal_or_null', scale: 2, unit: 'USD', header: { row: 0, column: primaryCount } }],
            detailRanges: [{ start: 2, end: raw.length - 1 }], projections: inner.map((_, i) => [
                { column: 'Id', sourceColumn: 0 }, { column: 'Metric', sourceRow: 1, sourceColumn: i }, { column: 'Value [USD]', sourceColumn: primaryCount + i },
            ]) },
    ], relationships: [{ fromTable: 'metrics', toTable: 'entities', fromKeys: ['Id'], toKeys: ['Id'], cardinality: 'many_to_one' }],
    exclusions: [{ row: 0, role: 'header' }, { row: 1, role: 'header' }], assumptions: ['Proposed entity and metric roles require a source-bound human semantic choice.'] };
    return { p, raw, inputs: { tables: {}, sources: { original: raw } } satisfies ValidationInputs, measureCount };
};
const structurallyResolved = (f = fixture()) => {
    const compiled = compileDualGrainCandidateMeaning(f.p, f.inputs);
    // Test only: independently exercise structural/numeric gates, NOT a host semantic selection.
    return { ...compiled, contract: { ...compiled.contract, ambiguities: [] }, ...f };
};
describe('bounded dual-grain host compilation foundation (not active Pi support)', () => {
    it.each([42, 60, 90])('accounts every physical cell at width %i without confusing entity and metric grain', width => {
        const f = fixture(width), c = compileDualGrainCandidateMeaning(f.p, f.inputs);
        expect(isDualGrainCandidateMeaning(f.p)).toBe(true);
        expect(c.structuralVerdict.decision).toBe('validated');
        expect(c.reference.tables.map(t => t.rowCount)).toEqual([3, 3 * f.measureCount]);
        expect(c.reference.tables[0].rows.reduce((sum, r) => sum + Number(r['Cost [USD]']), 0)).toBe(400);
        expect(c.reference.tables[0].rows.reduce((sum, r) => sum + Number(r['Net [USD]']), 0)).toBe(-400);
        expect(c.reference.tables[1].rows.slice(0, 3).map(r => r['Value [USD]'])).toEqual([null, 0, -1.25]);
        expect(c.reference.tables[0].rows[0].Metric).toBe('Label,\n1');
        expect(parseCandidateOutput(JSON.stringify(c.reference))).toEqual(c.reference);
        expect(validateCandidateSemantics(c.reference, c.contract, f.inputs).decision).toBe('clarification');
    });
    it.each([42, 60, 90])('executes actual QuickJS on quoted multiline width %i and independently validates both output tables', async width => {
        const f = fixture(width), c = structurallyResolved(f);
        const csv = f.raw.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const program = `
            const records = []; let row = [], value = '', quoted = false;
            for(let i=0;i<input.csv.length;i++){
                const ch=input.csv[i];
                if(ch==='"'){if(quoted&&input.csv[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
                else if(ch===','&&!quoted){row.push(value);value='';}
                else if((ch==='\\r'||ch==='\\n')&&!quoted){if(ch==='\\r'&&input.csv[i+1]==='\\n')i++;row.push(value);records.push(row);row=[];value='';}
                else value+=ch;
            }
            if(quoted)throw new Error('unclosed quote');row.push(value);records.push(row);
            const p=input.proposal;
            const tables=p.tables.map(t=>{
                const rows=[],lineage=[];
                for(const range of t.detailRanges)for(let sourceRow=range.start;sourceRow<=range.end;sourceRow++)for(const projection of t.projections){
                    const out={},outRow=rows.length;
                    for(const column of t.columns){
                        const m=projection.find(m=>m.column===column.name),r=m.sourceRow===undefined?sourceRow:m.sourceRow,raw=records[r][m.sourceColumn];
                        out[column.name]=column.conversion==='decimal_or_null'&&raw===''?null:column.dataType==='number'?Number(raw):raw;
                        lineage.push({row:outRow,column:column.name,origins:[{kind:'source',name:p.input.name,row:r,column:m.sourceColumn}]});
                    }
                    rows.push(out);
                }
                return {name:t.name,role:'fact',schema:t.columns.map(({name,dataType,nullable})=>({name,dataType,nullable})),rowCount:rows.length,rows,lineage};
            });
            return {schemaVersion:1,complete:true,tables,relationships:p.relationships,excludedRows:p.exclusions.map(e=>({origin:{kind:'source',name:p.input.name,row:e.row},reason:e.role}))};`;
        const wasm = newQuickJSWASMModuleFromVariant(variant);
        const guest = await executeQuickJsGuest({ generation: 1, code: program, inputJson: JSON.stringify({ csv, proposal: f.p }), limits: resolveGuestLimits() }, () => wasm);
        expect(guest.status).toBe('completed');
        const candidate = parseCandidateOutput(guest.outputJson!);
        expect(candidate).toEqual(c.reference);
        expect(validateCandidateSemantics(candidate, c.contract, f.inputs).decision).toBe('validated');
        // The compiler's real unresolved contract still refuses any draft/acceptance authority.
        const unresolved = compileDualGrainCandidateMeaning(f.p, f.inputs).contract;
        expect(validateCandidateSemantics(candidate, unresolved, f.inputs).decision).toBe('clarification');
    });
    it('retains physical 42/60/90 compressed shape and per-cell lineage', () => {
        const f = fixture(), c = compileDualGrainCandidateMeaning(f.p, f.inputs);
        expect(f.raw.map(r => r.length)).toEqual([42, 60, 90, 90, 90]);
        expect(c.reference.tables[1].lineage.find(l => l.row === 59 && l.column === 'Value [USD]')?.origins).toEqual([{ kind: 'source', name: 'original', row: 2, column: 89 }]);
    });
    it.each(['missing_cell', 'duplicate_projection', 'duplicate_key', 'mixed_unit', 'header_mutation', 'relationship_mutation', 'range_overlap', 'populated_note', 'footer', 'irregular_width'] as const)('rejects %s independently', fault => {
        const f = fixture();
        if (fault === 'missing_cell') { f.p.tables[1].projections.pop(); }
        if (fault === 'duplicate_projection') f.p.tables[1].projections[1] = structuredClone(f.p.tables[1].projections[0]);
        if (fault === 'duplicate_key') f.raw[3][0] = f.raw[2][0];
        if (fault === 'mixed_unit') f.p.tables[1].columns[2].unit = 'EUR';
        if (fault === 'header_mutation') f.raw[0][2] = 'Different [USD]';
        if (fault === 'relationship_mutation') f.p.relationships[0].toKeys = ['Metric'];
        if (fault === 'range_overlap') f.p.tables[0].detailRanges.push({ start: 2, end: 2 });
        if (fault === 'populated_note') { f.raw.push(['0.00']); f.p.exclusions.push({ row: 5, role: 'note' }); }
        if (fault === 'footer') { f.raw.push(Array(87).fill('0.00')); f.p.exclusions.push({ row: 5, role: 'grand_total' }); }
        if (fault === 'irregular_width') f.raw[4].push('unmapped');
        expect(() => compileDualGrainCandidateMeaning(f.p, f.inputs)).toThrow();
    });
    it('rejects repeated additive ownership even across tables and aliased source identities', () => {
        const c = structurallyResolved();
        const row = c.contract.tables[1].rows[0].cells.find(cell => cell.column === 'Value [USD]')!;
        row.origin = { kind: 'source', name: 'alias', row: 2, column: 2 };
        const inputs = { ...c.inputs, sources: { ...c.inputs.sources, alias: c.raw }, sourceIdentities: { original: 'same-bytes', alias: 'same-bytes' } };
        expect(validateCandidateSemantics(c.reference, c.contract, inputs).reasonCodes).toContain('validation_additive_source_ownership_overlap');
    });
    it.each(['value', 'lineage', 'relationship', 'missing_row', 'duplicate_row', 'missing_source_cell', 'exclusion_reason'] as const)('independent validator rejects guest %s tampering', fault => {
        const c = structurallyResolved(), t = c.reference.tables[1];
        if (fault === 'value') t.rows[2]['Value [USD]'] = 1.25;
        if (fault === 'lineage') t.lineage[0].origins[0].row = 3;
        if (fault === 'relationship') c.reference.relationships[0].cardinality = 'one_to_one';
        if (fault === 'missing_row') { t.rows.pop(); t.rowCount--; }
        if (fault === 'duplicate_row') t.rows[2] = structuredClone(t.rows[1]);
        if (fault === 'missing_source_cell') c.contract.tables[0].rows[0].cells[4].origin.column = 5;
        if (fault === 'exclusion_reason') c.reference.excludedRows[0].reason = 'not the declared source role';
        expect(validateCandidateSemantics(c.reference, c.contract, c.inputs).decision).not.toBe('validated');
    });
    it('denies oversized expansion before allocating a reference', () => {
        const f = fixture(90, 500);
        expect(() => compileDualGrainCandidateMeaning(f.p, f.inputs)).toThrow('meaning_resource_limit');
    });
    it('has no model confirmation or extra-field escape hatch', () => {
        const f = fixture();
        expect(isDualGrainCandidateMeaning({ ...f.p, confirmed: true })).toBe(false);
        expect(isDualGrainCandidateMeaning({ ...f.p, tables: [f.p.tables[0]] })).toBe(false);
        expect(isDualGrainCandidateMeaning({ ...f.p, relationships: [] })).toBe(false);
    });
    it('distinguishes exact blank null, zero, negative and unsupported missing markers', () => {
        const rule = { column: 'Value', conversion: 'decimal_or_null' as const, scale: 2, origin: { kind: 'source' as const, name: 'original', row: 2, column: 0 } };
        expect(['', '0.00', '-1.25'].map(v => convertValidationCell(v, rule))).toEqual([null, 0, -1.25]);
        for (const value of ['N/A', '-', '  ', 'USD1.00', '0.001']) expect(() => convertValidationCell(value, rule)).toThrow();
        expect(() => convertValidationCell('90071992547409.91', rule)).toThrow('validation_decimal_precision');
    });
});
