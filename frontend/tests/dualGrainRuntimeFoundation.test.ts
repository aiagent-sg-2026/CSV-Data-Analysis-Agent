// @vitest-environment node
import { expect, it } from 'vitest';
import { compileDualGrainCandidateMeaning } from '../services/data/dualGrainCandidateMeaning';
import { createCandidateMeaningManifest } from '../services/agent/tools/manifests/candidateMeaningManifest';
import { syntheticDualGrainSource, syntheticDocumentGrainSource } from '../services/agent/runtime/pi/piDualGrainQualification';

it('public tool admits complete bounded A/B proposals, not self-confirmed flags', () => {
    const { proposal } = syntheticDualGrainSource();
    expect(createCandidateMeaningManifest().validate!(proposal, {} as never)).toEqual([]);
    expect(createCandidateMeaningManifest().validate!({ ...proposal, confirmed: true }, {} as never)).not.toEqual([]);
});
it('numeric detail cannot be hidden by a proposed header exclusion', () => {
    const { raw, proposal } = syntheticDualGrainSource();
    raw.pop();
    const p = structuredClone(proposal.interpretations[0].meaning);
    p.exclusions = p.exclusions.filter(e => e.row !== 7);
    p.exclusions.push({ row: 6, role: 'header' });
    for (const table of p.tables) table.detailRanges = [{ start: 2, end: 3 }];
    expect(() => compileDualGrainCandidateMeaning(p, { tables: {}, sources: { original: raw } })).toThrow('meaning_header_role_unverified');
});
it('document detail cannot reference a different source group even if the FK exists globally', () => {
    const { raw, proposal } = syntheticDocumentGrainSource();
    raw[2][0] = 'D2';
    expect(() => compileDualGrainCandidateMeaning(proposal.interpretations[0].meaning, { tables: {}, sources: { original: raw } })).toThrow('meaning_document_group_boundary_invalid');
});
it.each(['missing_footer_cell', 'numeric_label', 'wrong_metric', 'mixed_unit', 'unknown_header', 'partial_scope'] as const)('fails closed for %s', fault => {
    const { raw, proposal } = syntheticDualGrainSource(), p = proposal.interpretations[0].meaning, footer = p.exclusions.at(-1)!;
    if (fault === 'missing_footer_cell') footer.cells!.pop();
    if (fault === 'numeric_label') footer.cells![1] = { column: 1, kind: 'label' };
    if (fault === 'wrong_metric') footer.cells![1] = { column: 1, kind: 'sum', table: 'metrics', metric: 'Cost [USD]' };
    if (fault === 'mixed_unit') p.tables[1].columns[2].unit = 'EUR';
    if (fault === 'unknown_header') raw[4][0] = 'not identical to the evidenced header';
    if (fault === 'partial_scope') p.tables[1].detailRanges = [{ start: 2, end: 3 }];
    expect(() => compileDualGrainCandidateMeaning(p, { tables: {}, sources: { original: raw } })).toThrow();
});
it('aligned ragged footer is fully checked, never padded or inferred from totals', () => {
    const { raw, proposal } = syntheticDualGrainSource();
    const p = proposal.interpretations[0].meaning;
    const compile = () => compileDualGrainCandidateMeaning(p, { tables: {}, sources: { original: raw } });
    expect(compile().contract.ambiguities).not.toEqual([]);
    raw[7][1] = '401.00';
    expect(compile).toThrow('validation_summary_reconciliation_failed');
});
