import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectCsvDialect, dropTrailingEmptyColumns, parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { processCsvWithIntakeIr } from '../services/data/csvParser';
import { robustParseFloat } from '../services/data/dataProfiler';

const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/weird-reports');
const truth = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'truth.json'), 'utf8')) as {
    f4: { rows: number; total: number };
};
const asCsvFile = (name: string, text: string) =>
    ({ name, size: text.length, text: async () => text }) as unknown as File;

const header = 'Auftrag;Datum;Kunde;Beschreibung;Menge;Preis;Betrag';
const plainRow = (index: number) => `A${index};01.02.2026;Kunde ${index};Teil;${index};12,50;${index}.234,56`;
const multilineRow = (index: number) => `A${index};01.02.2026;Kunde ${index};"Zeile eins\nZeile zwei";${index};12,50;${index}.234,56`;
const roundCents = (value: number) => Math.round(value * 100) / 100;

describe('w4 European semicolon fixture', () => {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, 'w4_european_semicolon.csv'), 'utf8');

    it('keeps the BOM-prefixed fixture as a semicolon CSV with confidence', () => {
        expect(text.charCodeAt(0)).toBe(0xFEFF);
        const { detection } = parseCsvTextWithDetection(text);
        expect(detection.delimiter).toBe(';');
        expect(detection.quoteChar).toBe('"');
        expect(detection.confidence).toBe('high');
        expect(detection.warnings).toEqual([]);
    });

    it('imports 7 columns and every record, including the embedded-newline ones', async () => {
        const { csvData } = await processCsvWithIntakeIr(asCsvFile('w4_european_semicolon.csv', text));

        expect(Object.keys(csvData.data[0] ?? {})).toEqual(['Auftrag', 'Datum', 'Kunde', 'Beschreibung', 'Menge', 'Preis', 'Betrag']);
        expect(csvData.data).toHaveLength(truth.f4.rows);
        expect(csvData.data.every(row => Object.keys(row).length === 7)).toBe(true);

        const multiline = csvData.data.filter(row => String(row.Beschreibung).includes('\n'));
        expect(multiline.length).toBeGreaterThan(0);
        multiline.forEach(row => expect(row.Beschreibung).toBe('Multi-line\nnote: handle with care'));
        expect(csvData.data.some(row => row.Beschreibung === 'Part "X-2"; reinforced')).toBe(true);
        expect(csvData.data.some(row => row.Beschreibung === 'Spare; kit')).toBe(true);
        expect(csvData.data.every(row => /^A\d{5}$/.test(String(row.Auftrag)))).toBe(true);
    });

    it('sums the decimal-comma Betrag column to the ground-truth total', async () => {
        const { csvData } = await processCsvWithIntakeIr(asCsvFile('w4_european_semicolon.csv', text));
        const values = csvData.data.map(row => robustParseFloat(row.Betrag));
        expect(values.every(value => value !== null)).toBe(true);
        expect(roundCents(values.reduce<number>((sum, value) => sum + (value ?? 0), 0))).toBe(truth.f4.total);
    });
});

describe('semicolon dialect with decimal commas, one feature at a time', () => {
    it('is not torn apart by a valid quoted field with an embedded newline', () => {
        const lines = [header, plainRow(1), multilineRow(2), plainRow(3), plainRow(4)];
        const { rawRows, detection } = parseCsvTextWithDetection(lines.join('\n'));
        expect(detection.delimiter).toBe(';');
        expect(detection.warnings.map(warning => warning.code)).not.toContain('malformed_quote');
        expect(rawRows.filter(row => row.length > 1)).toHaveLength(5);
        expect(rawRows[2][3]).toBe('Zeile eins\nZeile zwei');
    });

    it('prefers the semicolon over decimal commas even when every record is regular', () => {
        const lines = [header, ...Array.from({ length: 30 }, (_, index) => plainRow(index + 1))];
        const detection = detectCsvDialect(lines.join('\n'));
        expect(detection.delimiter).toBe(';');
        expect(detection.confidence).toBe('high');
        expect(detection.warnings.map(warning => warning.code)).not.toContain('mixed_delimiter');
    });

    it('does not call the sample malformed when it is cut inside a multi-line quoted field', () => {
        // The detection sample stops after 200 non-empty lines; make line 200 the
        // first half of a quoted multi-line field.
        const rows: string[] = [header];
        while (rows.join('\n').split('\n').length < 199) rows.push(plainRow(rows.length));
        rows.push(multilineRow(999), plainRow(1000), plainRow(1001));
        const { rawRows, detection } = parseCsvTextWithDetection(rows.join('\n'));
        expect(detection.delimiter).toBe(';');
        expect(detection.confidence).toBe('high');
        expect(detection.warnings).toEqual([]);
        expect(rawRows.some(row => row[3] === 'Zeile eins\nZeile zwei')).toBe(true);
    });

    it('detects a quoted first header cell behind a BOM', () => {
        const text = `﻿"Auftrag";"Datum";"Betrag"\n"A1";"01.02.2026";"1.234,56"\n"A2";"02.02.2026";"2.345,67"\n`;
        const { rawRows, detection } = parseCsvTextWithDetection(text);
        expect(detection.delimiter).toBe(';');
        expect(detection.quoteChar).toBe('"');
        expect(rawRows[0]).toEqual(['Auftrag', 'Datum', 'Betrag']);
    });

    it('drops a trailing empty column but keeps interior and populated ones', () => {
        const trailing = parseCsvTextWithDetection('a;b;c;\n1;2;3;\n4;5;6;\n');
        expect(trailing.rawRows.filter(row => row.length > 1).every(row => row.length === 3)).toBe(true);

        expect(dropTrailingEmptyColumns([['a', '', 'c'], ['1', '', '3']])).toEqual([['a', '', 'c'], ['1', '', '3']]);
        expect(dropTrailingEmptyColumns([['a', 'b', ''], ['1', '2', '3']])).toEqual([['a', 'b', ''], ['1', '2', '3']]);
        expect(dropTrailingEmptyColumns([['t', ''], ['a', 'b', '', '']])).toEqual([['t', ''], ['a', 'b']]);
    });

    it('still flags a stray quote that swallows following rows', () => {
        const text = [header, plainRow(1), 'A2;01.02.2026;"Kunde 2;Teil;2;12,50;2.234,56', plainRow(3), plainRow(4)].join('\n');
        const { detection } = parseCsvTextWithDetection(text);
        expect(detection.warnings.map(warning => warning.code)).toContain('malformed_quote');
        expect(detection.confidence).toBe('low');
    });

    it('keeps comma delimited US files with thousands separators on the comma', () => {
        const text = ['Name,Amount', ...Array.from({ length: 20 }, (_, index) => `Row ${index},"1,234.56"`)].join('\n');
        const detection = detectCsvDialect(text);
        expect(detection.delimiter).toBe(',');
        expect(detection.confidence).toBe('high');
    });
});
