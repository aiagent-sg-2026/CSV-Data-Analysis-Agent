import { describe, expect, it } from 'vitest';
import type { ReportIntakeIr } from '../types';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { buildCsvDataFromIntakeIr, buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { solveHeaderAlignment, validateHeaderAlignment } from '../services/agent/headerAlignment';
import { buildIntakeDiagnosticsSnapshot, evaluateIntakeDiagnostics } from '../services/agent/intakeDiagnosticsPolicy';
import { resolveReportStructure } from '../services/agent/reportStructureResolver';

// These are entirely fictional labels and values. The header rows deliberately
// retain their original, unequal widths; padding them would destroy evidence.
const repeatedReport = (bands = 2, rename = false): ReportIntakeIr => {
    const prefix = Array.from({ length: 14 }, (_, i) => `Descriptor ${i}`);
    const groups = Array.from({ length: 12 }, (_, i) => `${rename ? 'Division' : 'Group'} ${i}`);
    const suffix = Array.from({ length: 4 }, (_, i) => `Tail ${i}`);
    const measures = Array.from({ length: 5 }, (_, i) => `${rename ? 'Reading' : 'Metric'} ${i}`);
    const top = [...prefix, ...Array.from({ length: bands }, () => groups).flat(), ...suffix];
    const leaf = Array.from({ length: 12 }, () => measures).flat();
    const body = Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 90 + (bands - 2) * 12 }, (_, col) => String((row + 1) * 100 + col)));
    const rawRows = [['Fictional report'], top, leaf, ...body];
    const parsed = parseCsvTextWithDetection(rawRows.map(row => row.join(',')).join('\n'));
    return buildReportIntakeIr('synthetic.csv', rawRows, parsed.detection);
};

const requireCandidates = async (intake: ReportIntakeIr, count = 2) => {
    const result = await solveHeaderAlignment(intake);
    expect(result.status).toBe('semantic_review_required');
    expect(result.candidates).toHaveLength(count);
    return result;
};

describe('evidence-first header alignment', () => {
    it('keeps both 42/60/90 interpretations and original row/column coordinates', async () => {
        const intake = repeatedReport();
        const result = await requireCandidates(intake);
        expect(intake.rawRows.slice(1, 4).map(row => row.length)).toEqual([42, 60, 90]);
        expect(result.candidates.map(candidate => candidate.mainStartColumn).sort((a, b) => a - b)).toEqual([14, 26]);
        expect(JSON.stringify(result)).not.toContain('Descriptor 0');
        expect(JSON.stringify(result)).not.toContain('Group 0');
        for (const candidate of result.candidates) {
            expect(candidate).toMatchObject({
                version: 1, status: 'semantic_review_required', confidence: 'structural',
                headerSourceRows: [1, 2], bodySourceRows: { start: 3, endExclusive: 7 },
                summarySourceRows: { start: 7, endExclusive: 7 }, dataWidth: 90,
                groupCount: 12, groupWidth: 5,
            });
            expect(candidate.sourceWidths).toEqual(intake.rawRows.map(row => row.length));
            expect(candidate.mappings.map(mapping => mapping.targetColumn)).toEqual(Array.from({ length: 90 }, (_, i) => i));
            for (let group = 0; group < 12; group++) {
                const target = candidate.mainStartColumn + group * candidate.groupWidth;
                const sourceColumn = candidate.mainStartColumn + group;
                expect(candidate.mappings[target].headerPath).toEqual([
                    { rowIndex: 1, columnIndex: sourceColumn },
                    { rowIndex: 2, columnIndex: group * 5 },
                ]);
                for (let position = 0; position < candidate.groupWidth; position++) {
                    expect(candidate.mappings[target + position].headerPath).toEqual([
                        { rowIndex: 1, columnIndex: sourceColumn },
                        { rowIndex: 2, columnIndex: group * 5 + position },
                    ]);
                }
            }
            expect(candidate.mappings.slice(0, candidate.mainStartColumn).map(mapping => mapping.headerPath))
                .toEqual(Array.from({ length: candidate.mainStartColumn }, (_, columnIndex) => [{ rowIndex: 1, columnIndex }]));
            expect(candidate.mappings.slice(candidate.mainEndColumn).map(mapping => mapping.headerPath))
                .toEqual(Array.from({ length: 90 - candidate.mainEndColumn }, (_, i) =>
                    [{ rowIndex: 1, columnIndex: candidate.mainStartColumn + 12 + i }]));
            expect((await validateHeaderAlignment(intake, candidate, result.candidates.filter(other => other !== candidate))).valid).toBe(true);
        }
        expect(result.ambiguities.length).toBeGreaterThan(0);
    });

    it.each([2, 3, 4])('handles %i repeated main bands without relying on label vocabulary', async bands => {
        const original = await requireCandidates(repeatedReport(bands), bands);
        const renamed = await requireCandidates(repeatedReport(bands, true), bands);
        expect(original.candidates.map(c => c.mainStartColumn)).toEqual(renamed.candidates.map(c => c.mainStartColumn));
        expect(original.candidates.map(c => c.mainStartColumn).sort((a, b) => a - b))
            .toEqual(Array.from({ length: bands }, (_, i) => 14 + i * 12));
        for (const candidate of original.candidates) {
            expect(candidate.headerEvidence).toEqual({
                upperRowIndex: 1, leafRowIndex: 2, repeatedGroupCount: bands, leafPeriod: 5,
            });
            expect(candidate.groupWidth).toBe(5);
            expect(candidate.mainEndColumn).toBe(candidate.mainStartColumn + 60);
            expect(candidate.mappings[candidate.mainStartColumn].headerPath).toEqual([
                { rowIndex: 1, columnIndex: candidate.mainStartColumn },
                { rowIndex: 2, columnIndex: 0 },
            ]);
            expect(candidate.mappings[candidate.mainEndColumn].headerPath).toEqual([
                { rowIndex: 1, columnIndex: candidate.mainStartColumn + 12 },
            ]);
        }
    });

    it('leaves sparse headers unresolved rather than assuming compacted positions', async () => {
        const intake = repeatedReport();
        intake.rawRows[1].splice(1, 0, '');
        intake.rawRows[2].splice(0, 0, '');
        const result = await solveHeaderAlignment(intake);
        expect(result.candidates).toEqual([]);
        expect(result.status).not.toBe('semantic_review_required');
    });

    it('does not depend on body ordering or missing and quoted values', async () => {
        const intake = repeatedReport();
        const rows = intake.rawRows.map(row => [...row]);
        rows[1][0] = 'Descriptor, \"quoted\"';
        rows[3][3] = 'quoted, fictional value';
        rows[4][17] = '';
        rows[5][29] = 'NA';
        const csv = rows.map(row => row.map(value => `"${value.replace(/"/g, '""')}"`).join(',')).join('\n');
        const parsed = parseCsvTextWithDetection(csv);
        const changed = buildReportIntakeIr('synthetic.csv', parsed.rawRows, parsed.detection);
        const shuffled = { ...changed, rawRows: [...changed.rawRows.slice(0, 3), ...changed.rawRows.slice(3).reverse()] };
        const first = await requireCandidates(changed);
        const second = await requireCandidates(shuffled);
        expect(first.candidates.map(c => c.mappings)).toEqual(second.candidates.map(c => c.mappings));
        expect(changed.rawRows[1][0]).toBe('Descriptor, \"quoted\"');
        expect(changed.rawRows[3][3]).toBe('quoted, fictional value');
        expect(changed.rawRows[4][17]).toBe('');
    });

    it.each([
        { rows: [['id', 'name', 'amount'], ['1', 'A', '10'], ['2', 'B', '20']] },
        { rows: [['Account', 'Jan', 'Feb', 'Mar'], ['Sales', '10', '20', '30'], ['Costs', '3', '4', '5']] },
    ])('does not invent repeated-group ownership for ordinary flat or period tables', async ({ rows }) => {
        const result = await solveHeaderAlignment(buildReportIntakeIr('ordinary.csv', rows));
        expect(result.candidates).toEqual([]);
        expect(result.status).not.toBe('semantic_review_required');
    });

    it('rejects tampered candidates, fingerprints, and incomplete alternatives', async () => {
        const intake = repeatedReport();
        const result = await requireCandidates(intake);
        const candidate = result.candidates[0];
        const badFingerprint = { ...candidate, sourceFingerprint: '0'.repeat(64) };
        expect(await validateHeaderAlignment(intake, badFingerprint)).toMatchObject({
            valid: false, status: 'invalid', issues: ['candidate_mismatch'],
        });
        const badMapping = structuredClone(candidate);
        badMapping.mappings[0].targetColumn = badMapping.dataWidth + 1;
        expect((await validateHeaderAlignment(intake, badMapping, result.candidates)).valid).toBe(false);
        const badCoordinate = structuredClone(candidate);
        badCoordinate.mappings[0].headerPath[0].rowIndex = intake.rawRows.length;
        const invalidCoordinate = await validateHeaderAlignment(intake, badCoordinate);
        expect(invalidCoordinate).toMatchObject({ valid: false, status: 'invalid' });
        expect(invalidCoordinate.issues.length).toBeGreaterThan(0);
        expect(await validateHeaderAlignment(intake, candidate, [candidate])).toMatchObject({
            valid: false, status: 'invalid', issues: ['alternatives_mismatch'],
        });
        const changed = structuredClone(intake);
        changed.rawRows[1][0] = 'Changed descriptor';
        expect((await validateHeaderAlignment(changed, candidate, result.candidates)).valid).toBe(false);
    });

    it('fails closed when the original body widths do not establish a run', async () => {
        const intake = repeatedReport();
        intake.rawRows[4] = intake.rawRows[4].slice(0, -1);
        const result = await solveHeaderAlignment(intake);
        expect(result.candidates).toEqual([]);
        expect(result.status).not.toBe('semantic_review_required');
    });

    it('leaves the header drift guard and structure review unchanged', async () => {
        const intake = repeatedReport();
        const before = structuredClone(intake);
        const csvData = buildCsvDataFromIntakeIr(intake);
        const snapshot = buildIntakeDiagnosticsSnapshot(csvData, csvData, intake);
        const guardBefore = evaluateIntakeDiagnostics(snapshot);
        await requireCandidates(intake);
        expect(intake).toEqual(before);
        expect(evaluateIntakeDiagnostics(snapshot)).toEqual(guardBefore);
        expect(guardBefore).toMatchObject({ severity: 'blocked', blockingReasonCode: 'header_shape_drift', shouldBlockAutomaticAnalysis: true });
        const structure = resolveReportStructure({ rawCsvData: csvData, csvData, rawIntakeIr: intake });
        expect(structure.requiresHumanReview).toBe(true);
        expect(structure.blockingReasons).toContain('header_shape_drift');
    });
});
