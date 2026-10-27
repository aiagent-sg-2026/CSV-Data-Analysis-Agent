import { Blob as NodeBlob } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CsvStreamScanner, CSV_SCAN_LIMITS } from '../services/data/csvStreamScanner';

const blob = (text: string | Uint8Array) => new NodeBlob([text]) as unknown as Blob;
const run = async (text: string, chunkBytes = 65536) => {
    const source = blob(text), scanner = new CsvStreamScanner(source, { delimiter: ',', chunkBytes });
    return scanner.run();
};

describe('bounded full-source CSV scanner', () => {
    it('finds irregular rows after 128 and far beyond a preview, never a sampled clean negative', async () => {
        const text = 'key,value\n' + Array.from({ length: 20000 }, (_, i) => i === 18000 ? `${i},x,extra\n` : `${i},x\n`).join('');
        const result = await run(text, 1024);
        expect(result).toMatchObject({ status: 'completed_anomalies', rows: 20001, bytesRead: blob(text).size, counts: { width_mismatch: 1 } });
        expect(result.examples[0]).toMatchObject({ kind: 'width_mismatch', row: 18001, startLine: 18002, width: 3 });
        expect(result.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    });
    it('scans a large valid source with bounded evidence/state', async () => {
        const text = 'key,value\n' + 'record,1\n'.repeat(150000);
        const result = await run(text);
        expect(result).toMatchObject({ status: 'completed_clean', rows: 150001, examples: [], expectedWidth: 2, headerRow: 0 });
        expect(result.peakRecordBytes).toBeLessThan(32);
        expect(result.peakRetainedRows).toBeLessThanOrEqual(3);
    });
    it.each([1, 2, 3, 7, 64])('preserves BOM, escaped quotes, CRLF, UTF-8 and multiline offsets at chunk size %i', async chunkBytes => {
        const text = '\ufeffkey,value\r\n"α\r\nβ","a""b"\r\nlast,2\r\n';
        const result = await run(text, chunkBytes);
        expect(result).toMatchObject({ status: 'completed_clean', rows: 3, physicalLines: 4, expectedWidth: 2 });
        expect(result.sha256).toBe(createHash('sha256').update(text).digest('hex'));
        const anomaly = await run(text + 'ragged\r\n', chunkBytes);
        expect(anomaly.examples[0]).toMatchObject({ row: 3, startLine: 5, endLine: 5, byteStart: new TextEncoder().encode(text).length });
    });
    it('detects repeated headers, blanks and quote errors without keeping unbounded evidence', async () => {
        const result = await run('key,value\n' + 'key,value\n'.repeat(500) + '\nragged\n"bad\n');
        expect(result.status).toBe('completed_anomalies');
        expect(result.counts.repeated_header).toBe(500);
        expect(result.counts.unclosed_quote).toBe(1);
        expect(result.examples.length).toBe(CSV_SCAN_LIMITS.maxExamples);
        expect(result.examplesTruncated).toBe(true);
        expect(result.sha256).toBeTruthy();
    });
    it('cancel/resume preserves exact parser and hash state, including an open multiline quote', async () => {
        const text = 'key,value\r\n"first\r\nsecond",1\r\nlast,2\r\n';
        const source = blob(text), scanner = new CsvStreamScanner(source, { delimiter: ',', chunkBytes: 3 });
        const cancelled = await scanner.run(progress => { if (progress.bytesRead >= 18) scanner.cancel(); });
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.sha256).toBeNull();
        const resumed = await scanner.run();
        expect(resumed).toEqual(await run(text, 3));
        await expect(scanner.run()).rejects.toThrow('scan_terminal');
    });
    it('claims concurrent runs before awaiting source bytes', async () => {
        const scanner = new CsvStreamScanner(blob('a,b\n1,2\n'), { delimiter: ',', chunkBytes: 1 });
        const first = scanner.run();
        await expect(scanner.run()).rejects.toThrow('scan_already_running');
        await first;
    });
    it.each([
        [new Uint8Array([0xff, 0xfe, 97, 0]), 'scan_unsupported_encoding'],
        [new Uint8Array([97, 44, 98, 10, 0xff]), 'scan_invalid_utf8'],
        [new Uint8Array([97, 44, 98, 10, 0]), 'scan_unsupported_encoding'],
    ])('never verifies unsupported/malformed encodings', async (bytes, reason) => {
        const scanner = new CsvStreamScanner(blob(bytes as Uint8Array), { delimiter: ',' });
        expect(await scanner.run()).toMatchObject({ status: 'failed', reason, sha256: null });
    });
    it('bounds fields, records, columns and total work, not just retained examples', async () => {
        expect(await run('a,b\n' + 'x'.repeat(CSV_SCAN_LIMITS.maxFieldBytes + 1))).toMatchObject({ status: 'failed', reason: 'scan_field_budget', sha256: null });
        expect(await run('a,b\n' + ','.repeat(CSV_SCAN_LIMITS.maxColumns))).toMatchObject({ status: 'failed', reason: 'scan_column_budget' });
        const scanner = new CsvStreamScanner(blob('a,b\n1,2\n'), { delimiter: ',', maxBytes: 4 });
        expect(await scanner.run()).toMatchObject({ status: 'failed', reason: 'scan_source_budget' });
        const rowBudget = new CsvStreamScanner(blob('a,b\n1,2\n'), { delimiter: ',', maxRows: 1 });
        expect(await rowBudget.run()).toMatchObject({ status: 'failed', reason: 'scan_row_budget' });
        expect(await run('a,b\n' + Array.from({ length: 6 }, () => 'x'.repeat(200000)).join(','))).toMatchObject({ status: 'failed', reason: 'scan_record_budget' });
    });
    it('does not mistake a sampled single-column dialect for proof about later delimiter bands', async () => {
        const result = await run('metadata\n'.repeat(200) + 'key;value\nx;1\ny;2\n');
        expect(result.status).toBe('completed_anomalies');
        expect(result.counts.ambiguous_delimiter).toBe(3);
        expect((await run('text\n"commas, semicolons; and pipes|"\n')).status).toBe('completed_clean');
    });
    it('locates later header-band hypotheses throughout a long preamble without customer names', async () => {
        const result = await run('metadata\n'.repeat(2000) + 'Identifier,Group A,Group B\nfirst,1,2\nsecond,3,4\n', 1024);
        expect(result.status).toBe('completed_anomalies');
        expect(result.headerCandidates).toContainEqual({ row: 2000, startLine: 2001, byteStart: 18000, width: 3 });
        expect(result.headerRow).toBe(2000);
        expect(result.headerCandidates.length).toBeLessThanOrEqual(CSV_SCAN_LIMITS.maxHeaderCandidates);
    });
    it('does not read a whole Blob or retain one row per source record', async () => {
        const source = blob('a,b\n' + 'x,1\n'.repeat(10000));
        source.arrayBuffer = () => { throw new Error('whole source read forbidden'); };
        const scanner = new CsvStreamScanner(source, { delimiter: ',', chunkBytes: 512 });
        const result = await scanner.run();
        expect(result.status).toBe('completed_clean');
        expect(result.peakRetainedRows).toBeLessThanOrEqual(3);
    });
});
