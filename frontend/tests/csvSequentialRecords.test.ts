// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createCsvSequentialRecords } from '../services/data/csvSequentialRecords';
import { CsvStreamScanner } from '../services/data/csvStreamScanner';
import type { CsvSourceMetadata } from '../types/intake';

afterEach(() => vi.restoreAllMocks());
const setup = async (text: string, chunkBytes = 7) => {
    const blob = new Blob([text]);
    const spans: Array<{ row: number; start: number; end: number; startLine: number; endLine: number }> = [];
    const scan = await new CsvStreamScanner(blob, { delimiter: ',', onRecord: span => spans.push(span) }).run();
    const source: CsvSourceMetadata = { sourceId: 'source', sha256: scan.sha256!, byteSize: blob.size, fileName: 'synthetic.csv', recordCount: scan.rows, dialect: { delimiter: ',', quoteChar: '"' }, diagnostics: [] };
    let revoked = false, charged = 0, calls = 0;
    const reader = createCsvSequentialRecords(blob, source, () => { if (revoked) throw new Error('scope_revoked'); }, bytes => { charged += bytes; calls++; }, chunkBytes);
    return { reader, blob, spans, setRevoked: (value: boolean) => { revoked = value; }, stats: () => ({ charged, calls }) };
};
it.each([3, 7, 65536])('preserves exact multiline/escaped quote/UTF8/BOM/CRLF and EOF framing at chunk size %i with irregular acknowledged batches', async chunk => {
    const text = '\ufeffkey,payload,value\r\n0,"α\r\n末尾 and ""quote""",1\r\n1,普通,2\r2,"x\ny",3\n3,EOF,4';
    const s = await setup(text, chunk);
    const records = [];
    for (const count of [1, 2, 1, 50]) {
        const batch = await s.reader.read(count);
        expect(await s.reader.read(count)).toEqual(batch);
        records.push(...batch.records); s.reader.commit();
    }
    expect(records.map(r => ({ row: r.row, start: r.byteStart, end: r.byteEnd, startLine: r.startLine, endLine: r.endLine }))).toEqual(s.spans);
    expect(records[1].cells.map(c => c.value)).toEqual(['0', 'α\r\n末尾 and "quote"', '1']);
    expect(records.at(-1)!.cells.map(c => c.value)).toEqual(['3', 'EOF', '4']);
    expect(s.stats().charged).toBe(s.blob.size);
    expect(s.reader.retainedBytes).toBeLessThanOrEqual(2 * 65536);
});
it('handles a long quoted UTF8/multiline record straddling physical chunks with irregular batch sizes', async () => {
    const payload = 'x'.repeat(20000) + 'α\r\n末尾';
    const text = 'key,value\r\n' + Array.from({ length: 50 }, (_, i) => `${i},${'x'.repeat(1000)}\r\n`).join('') + `50,"${payload}"\r\n51,EOF`;
    const s = await setup(text, 65536), records = [];
    let i = 0;
    while (true) {
        const batch = await s.reader.read([1, 7, 50, 2][i++ % 4]); records.push(...batch.records); s.reader.commit();
        if (batch.complete) break;
    }
    expect(records.map(r => ({ row: r.row, start: r.byteStart, end: r.byteEnd, startLine: r.startLine, endLine: r.endLine }))).toEqual(s.spans);
    expect(records.at(-2)!.cells[1].value).toBe(payload);
    expect(s.stats().charged).toBe(s.blob.size);
});
it('retains a completed record when cancellation lands between parser resolution and batch acknowledgement', async () => {
    const blob = new Blob(['key,value\n1,2\n']); let checks = 0;
    const source: CsvSourceMetadata = { sourceId: 'id', sha256: 'a'.repeat(64), byteSize: blob.size, fileName: 'x', recordCount: 2, dialect: { delimiter: ',', quoteChar: '"' }, diagnostics: [] };
    const reader = createCsvSequentialRecords(blob, source, () => { if (++checks === 4) throw new Error('scope_revoked'); }, () => {});
    await expect(reader.read(50)).rejects.toThrow('scope_revoked');
    const resumed = await reader.read(50);
    expect(resumed.records.map(record => record.row)).toEqual([0, 1]);
    expect(resumed.records[0].byteStart).toBe(0); expect(resumed.complete).toBe(true);
});
it.each(['mid-quote', 'EOF'] as const)('retains parser/frontier across cancellation during %s native read and counts the reread', async point => {
    const s = await setup('key,value\r\n1,"α\r\n末尾"\r\n2,EOF', 7);
    const original = Blob.prototype.arrayBuffer; let calls = 0, cancelledSize = 0;
    const spy = vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function(this: Blob) {
        calls++;
        if (calls === (point === 'EOF' ? Math.ceil(s.blob.size / 7) : 3)) { s.setRevoked(true); cancelledSize = this.size; }
        return original.call(this);
    });
    await expect(s.reader.read(50)).rejects.toThrow('scope_revoked');
    spy.mockRestore(); s.setRevoked(false);
    const batch = await s.reader.read(50);
    expect(batch.records.map(r => r.row)).toEqual([0, 1, 2]); expect(batch.complete).toBe(true);
    expect(batch.records[1].cells[1].value).toBe('α\r\n末尾');
    expect(s.stats().charged).toBe(s.blob.size + cancelledSize);
});
it('charges failed native reads, retains the partial record, and fails closed on unavailable bytes', async () => {
    const s = await setup('key,value\n1,"α\n末尾"\n2,EOF');
    const spy = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new DOMException('unavailable', 'NotReadableError'));
    await expect(s.reader.read(50)).rejects.toThrow('source_record_scan_failed');
    expect(s.stats()).toEqual({ charged: 7, calls: 1 });
    spy.mockRestore();
    expect((await s.reader.read(50)).records.map(r => r.row)).toEqual([0, 1, 2]);
    expect(s.stats().charged).toBe(s.blob.size + 7);
});
it('rejects oversized raw/serialized records without skipping their source coverage', async () => {
    const s = await setup('key\n' + 'x'.repeat(70000) + '\nlast\n', 65536);
    const first = await s.reader.read(1); expect(first.nextRow).toBe(1); s.reader.commit();
    await expect(s.reader.read(50)).rejects.toThrow('source_stream_record_capacity');
});
it('reserves a cumulative quota before native reads and preserves prior charges across denied resumes', async () => {
    const blob = new Blob(['key,value\n1,2\n']); let charged = 0, nativeCalls = 0;
    const source: CsvSourceMetadata = { sourceId: 'id', sha256: 'a'.repeat(64), byteSize: blob.size, fileName: 'x', recordCount: 2, dialect: { delimiter: ',', quoteChar: '"' }, diagnostics: [] };
    const reader = createCsvSequentialRecords(blob, source, () => {}, bytes => {
        if (charged + bytes > 10) throw new Error('source_stream_budget_exhausted'); charged += bytes;
    }, 7);
    const original = Blob.prototype.arrayBuffer;
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(function(this: Blob) { nativeCalls++; return original.call(this); });
    for (let i = 0; i < 4; i++) await expect(reader.read(50)).rejects.toThrow('source_stream_budget_exhausted');
    expect({ charged, nativeCalls }).toEqual({ charged: 7, nativeCalls: 1 });
});
