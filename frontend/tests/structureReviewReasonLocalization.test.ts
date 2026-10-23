import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    STRUCTURE_REVIEW_REASON_CODES,
    getStructureReviewReasonText,
    getTranslationEntries,
} from '../utils/localization';

const LANGUAGES = ['English', 'Mandarin', 'Japanese', 'Malay'] as const;
const readSource = (relativePath: string) => readFileSync(path.resolve(relativePath), 'utf8');

// Collect every code the structure review can surface straight from the
// sources, so a new blocking reason or failure signal cannot ship without an
// end-user explanation.
const collectEmittedReasonCodes = (): string[] => {
    const resolver = readSource('services/agent/reportStructureResolver.ts');
    const resolverCodes = [
        ...[...resolver.matchAll(/reasons\.push\('([a-z_]+)'\)/g)].map(match => match[1]!),
        ...[...resolver.matchAll(/\? \['([a-z_]+)'\] : \[\]/g)].map(match => match[1]!),
    ];

    const verification = readSource('services/agent/reportShapeVerification.ts');
    const failureSignalStart = verification.indexOf('export const getVerificationFailureSignal');
    const failureSignalList = verification.slice(failureSignalStart, verification.indexOf('.map(', failureSignalStart));
    const prioritizedSignals = [...failureSignalList.matchAll(/'([a-z_]+)'/g)].map(match => match[1]!);
    // getVerificationFailureSignal also falls back to any failing signal
    // outside the advisory list.
    const builtSignals = [...verification.matchAll(/buildSignal\(\s*'([a-z_]+)'/g)].map(match => match[1]!);
    const advisoryStart = verification.indexOf('const NON_BLOCKING_ADVISORY_SIGNAL_KEYS');
    const advisoryList = verification.slice(advisoryStart, verification.indexOf('];', advisoryStart));
    const advisorySignals = new Set([...advisoryList.matchAll(/'([a-z_]+)'/g)].map(match => match[1]!));

    return Array.from(new Set([
        ...resolverCodes,
        ...prioritizedSignals,
        ...builtSignals.filter(signal => !advisorySignals.has(signal)),
    ])).sort();
};

describe('structure review reason localization', () => {
    it('covers every reason code the structure review can emit', () => {
        const emitted = collectEmittedReasonCodes();

        expect(emitted).toEqual(expect.arrayContaining([
            'boundary_incomplete',
            'complex_report_requires_confirmation',
            'detail_series_coverage_rate',
            'dominant_block_resolved',
            'hierarchy_depth_retention_rate',
            'structure_proposal_verification_failed',
        ]));
        expect(emitted.filter(code => !(STRUCTURE_REVIEW_REASON_CODES as readonly string[]).includes(code))).toEqual([]);
    });

    it('has a plain-language explanation in all four languages for each code', () => {
        const entries = new Map(getTranslationEntries());
        for (const code of STRUCTURE_REVIEW_REASON_CODES) {
            const entry = entries.get(`structure_review_reason_${code}`);
            expect(entry, code).toBeDefined();
            for (const language of LANGUAGES) {
                const text = entry?.[language] ?? '';
                expect(text.trim(), `${code} ${language}`).not.toBe('');
                // A snake_case token in the copy means a code leaked through.
                expect(text, `${code} ${language}`).not.toMatch(/[a-z]+_[a-z]+/);
            }
        }
    });

    it('maps the codes seen in end-user runs and falls back for unknown ones', () => {
        expect(getStructureReviewReasonText('detail_series_coverage_rate', 'English'))
            .toBe('The table still looks wide, for example one column per month, so it may need reshaping.');
        expect(getStructureReviewReasonText('dominant_block_resolved', 'Mandarin')).toBe('文件包含多个区块，尚未分离出主数据表。');
        expect(getStructureReviewReasonText('hierarchy_depth_retention_rate', 'Japanese'))
            .toBe('行がセクションと明細などの階層に分かれているように見え、その階層が失われます。');
        expect(getStructureReviewReasonText('complex_report_requires_confirmation', 'Malay'))
            .toBe('Ini kelihatan seperti susun atur laporan yang kompleks, jadi sila sahkan sebelum analisis.');
        expect(getStructureReviewReasonText('some_future_signal', 'English'))
            .toBe('The data structure did not pass an automatic check.');
    });
});
