// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { qualifySourceStream } from '../services/agent/execution/codeSourceStreamQualification';
import { createSourceRecordStream } from '../services/agent/execution/codeSourceRecordStream';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import type { CandidateStagingPort } from '../services/data/candidateStaging';
import { syntheticStreamedDualSource } from '../services/agent/runtime/pi/piDualGrainQualification';
import { createDualScan, dualProjectedRow, dualSourceRow } from '../services/data/streamedDualGrain';

const scan = (fixture = syntheticStreamedDualSource(8)) => {
    const s = createDualScan(fixture.proposal.interpretations[0].meaning, fixture.raw.length);
    fixture.raw.forEach((row, i) => s.visit(i, row));
    return { ...s, fixture, verdict: s.finish() };
};
describe('bounded ordered dual-grain complete original validation', () => {
    it('does not impose candidate.read permission on the established structural code.run lane',async()=>{
        const factory=async()=>{const values=new Map<string,string>();return {async put(n:string,t:string){values.set(n,t);},async get(n:string){return values.get(n)!;},async remove(){values.clear();}};};
        const f=await qualifySourceStream(2,undefined,factory),readPolicy=vi.fn(()=>{throw new Error('capability_unavailable');});
        f.store.candidateStaging={validationRequirements:readPolicy,useCompactSourceRecords:()=>false} as unknown as CandidateStagingPort;
        const stream=await createSourceRecordStream(f.store,f.request.sourceRecords!,{},()=>{},factory);
        try{
            const manifest=await stream.execute(async json=>{const input=JSON.parse(json);return {generation:1,status:'completed',code:'guest_completed',outputJson:JSON.stringify({state:{},rows:input.records.map((r:{sourceRow:number;cells:string[]})=>({sourceRow:r.sourceRow,cells:r.cells.slice(0,3)}))})};},()=>{});
            expect(manifest.sourceRows).toBe(3);expect(manifest.commitAllowed).toBe(false);expect(readPolicy).not.toHaveBeenCalled();
        }finally{await stream.dispose();beginSessionTransition(f.root);}
    });
    it.each([42, 60, 90])('validates meaningful compressed %i shape, exact null/zero/negative and complete counts', width => {
        const f = scan(syntheticStreamedDualSource(8, width));
        expect(f.verdict.decision).toBe('validated');
        expect(f.meaning.counts).toEqual([8, 8 * f.fixture.measures]);
        expect(dualProjectedRow(f.meaning, 1, 0, 2, f.fixture.raw[2])['Value [USD]']).toBeNull();
        expect(dualProjectedRow(f.meaning, 1, 1, 2, f.fixture.raw[2])['Value [USD]']).toBe(0);
        expect(dualProjectedRow(f.meaning, 1, 2, 2, f.fixture.raw[2])['Value [USD]']).toBe(-1.25);
        expect(dualSourceRow(f.meaning.proposal.tables[1], 2 * f.fixture.measures + 3)).toBe(4);
        expect(f.verdict.groups.find(g => g.table === 'entities' && g.metric === 'Cost [USD]')?.actualMinor).toBe('1000');
    });
    it.each(['missing', 'duplicate', 'relationship', 'unit', 'duplicate-grain', 'key', 'summary', 'numeric-label', 'role-overlap', 'irregular', 'unknown-role'])('rejects independently invalid %s', fault => {
        const f = syntheticStreamedDualSource(8), p = f.proposal.interpretations[0].meaning;
        if (fault === 'missing') p.tables[0].projections[0].pop();
        if (fault === 'duplicate') p.tables[1].projections[3][2].sourceColumn = p.tables[1].projections[2][2].sourceColumn;
        if (fault === 'relationship') p.tables[1].projections[0][0].sourceColumn = 1;
        if (fault === 'unit') p.tables[1].columns[2].unit = 'EUR';
        if (fault === 'duplicate-grain') p.tables[1].projections[1][1].sourceColumn = 0;
        if (fault === 'key') f.raw[3][0] = f.raw[2][0];
        if (fault === 'summary') f.raw.at(-1)![1] = '900.00';
        if (fault === 'numeric-label') f.raw.at(-1)![0] = '$125.00';
        if (fault === 'role-overlap') p.exclusions.push({ row: 2, role: 'note' });
        if (fault === 'irregular') f.raw[3].pop();
        if (fault === 'unknown-role') p.tables.forEach(t => { t.detailRanges[0].end--; });
        expect(() => { const s = createDualScan(p, f.raw.length); f.raw.forEach((row, i) => s.visit(i, row)); s.finish(); }).toThrow(/validation_dual_/);
    });
});
