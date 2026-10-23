import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReportHeader } from '../components/dashboard/ReportHeader';
import { buildDataQualityNotes, summarizeDataQualityForEndUser } from '../services/data/dataQualityNotes';
import { summarizeDataQualityIssues } from '../services/data/dataProfiler';
import type { ResolvedReportContext } from '../types';

const LANGUAGES = ['English', 'Mandarin', 'Japanese', 'Malay'] as const;
const DEVELOPER_TEXT = /replace_values|cast_column|SQL|low-priority|AI will treat|strip commas/i;

const issues = [
    "Column 'Amount' contains comma-formatted numbers (e.g. '1,234.56'). Strip commas with replace_values before casting to avoid SQL type errors.",
    "Column 'Balance' contains comma-formatted numbers (e.g. '1,234.56'). Strip commas with replace_values before casting to avoid SQL type errors.",
    "Column 'Remark' has a high percentage of missing values (94%).",
    "Column 'Note' has a high percentage of missing values (100%).",
    "Column 'Qty' uses decimal commas (e.g. '1.234,56'); values are read as 1234.56.",
    "Column 'Ref' contains apostrophe-prefixed numbers (e.g. \"'-852.81\"). Strip leading apostrophes with replace_values before casting to avoid SQL type errors.",
    'Lightweight profiler used a stratified sample of 1000 rows (head/middle/tail) from 3200 total rows.',
];

afterEach(cleanup);

describe('data quality notes for the person reading them', () => {
    it('keeps the model-facing summary for the model and gives the person plain sentences', () => {
        // The model still gets its instruction.
        expect(summarizeDataQualityIssues(issues.slice(0, 2))).toContain('replace_values');

        const summary = summarizeDataQualityForEndUser(issues, 'English')!;
        expect(summary.notes.map(note => note.kind)).toEqual(['mostly_empty', 'thousands_separators', 'decimal_comma', 'apostrophe_numbers', 'other']);
        expect(summary.notes.map(note => note.sentence)).toEqual([
            '2 columns are mostly empty and will be ignored unless needed.',
            'Some numbers contain thousands separators; we read them correctly.',
            'Some numbers use a decimal comma (such as 1.234,56); we read them correctly.',
            'Some numbers start with an apostrophe (a spreadsheet text marker); we read them correctly.',
            '1 other data quality issue was found; the analysis takes it into account.',
        ]);
        expect(summary.notes[0].columns).toEqual(['Remark (94%)', 'Note (100%)']);
        expect(summary.userSummary).not.toMatch(DEVELOPER_TEXT);
        // Only a diagnostic no sentence covers stays raw, behind the details toggle.
        expect(summary.technicalDetail).toContain('stratified sample');
    });

    it('writes every note in all four languages without developer text', () => {
        for (const language of LANGUAGES) {
            const notes = buildDataQualityNotes(issues, language);
            expect(notes).toHaveLength(5);
            notes.forEach(note => {
                expect(note.sentence, `${language} ${note.kind}`).not.toMatch(DEVELOPER_TEXT);
                expect(note.sentence, `${language} ${note.kind}`).not.toMatch(/\{\w+\}/);
                expect(note.sentence.length).toBeGreaterThan(8);
            });
        }
        expect(buildDataQualityNotes(issues, 'Mandarin')[1].sentence).toContain('千位分隔符');
        expect(buildDataQualityNotes(issues, 'Japanese')[0].sentence).toContain('2 列');
        expect(buildDataQualityNotes(issues, 'Malay')[1].sentence).toContain('pemisah ribuan');
    });

    it('says "1 column is mostly empty" for a single column', () => {
        const [note] = buildDataQualityNotes(["Column 'Remark' has a high percentage of missing values (94%)."], 'English');
        expect(note.sentence).toBe('1 column is mostly empty and will be ignored unless needed.');
    });
});

describe('report header titles', () => {
    const context = (overrides: Partial<ResolvedReportContext>): ResolvedReportContext => ({
        sourceFile: null,
        reportTitle: null,
        reportDescription: null,
        parameterLines: [],
        footerLines: [],
        candidateHeaderLine: null,
        notes: [],
        source: 'fallback',
        confidence: null,
        ...overrides,
    });

    it('shows the file name with the period as subtitle when the stored title is a period', () => {
        render(<ReportHeader
            reportContextResolution={null}
            effectiveReportContext={context({ reportTitle: 'As At | 30-06-2026', parameterLines: ['As At | 30-06-2026'] })}
            fileName="w5_aging_meta_footnotes.csv"
            preparedRowCount={3200}
            headerDepth={1}
            summaryRowCount={0}
            language="English"
        />);
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('w5_aging_meta_footnotes.csv');
        expect(screen.getByText('As At 30-06-2026')).toBeInTheDocument();
    });

    it('keeps a real report name as the title and the period under it', () => {
        render(<ReportHeader
            reportContextResolution={null}
            effectiveReportContext={context({
                reportTitle: 'SALES ORDER OUTSTANDING REPORT',
                parameterLines: ['From 01-01-2026 To 30-06-2026'],
            })}
            fileName="w1.csv"
            preparedRowCount={3119}
            headerDepth={2}
            summaryRowCount={0}
            language="English"
        />);
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('SALES ORDER OUTSTANDING REPORT');
        // The period sits right under the title and is not repeated as a tag.
        expect(screen.getAllByText('From 01-01-2026 To 30-06-2026')).toHaveLength(1);
        expect(screen.getByText('From 01-01-2026 To 30-06-2026').tagName).toBe('P');
    });
});
