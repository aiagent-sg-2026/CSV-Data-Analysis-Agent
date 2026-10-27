// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { captureCsvSource, readSourceBytes, readSourceRecords, registerScannedCsvBlob } from '../services/data/immutableCsvSource';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import type { AppStore } from '../store/useAppStore';
const store = () => ({ getState: () => ({ sessionId: 'source-session' } as AppStore), setState: () => {} });
describe('immutable positional CSV source', () => {
    it('restores synchronous bytes for a Blob-only original and reuses the restored capture', async () => {
        const app = store(), file = new File(['Key,Amount\na,1\n'], 'synthetic-blob.csv');
        try {
            const original = await captureCsvSource(app, file);
            registerScannedCsvBlob(app, file, original, []);
            expect(() => readSourceBytes(app, original.sourceId, 0, original.byteSize)).toThrow('source_requires_bounded_async_read');
            const restored = await captureCsvSource(app, file), repeated = await captureCsvSource(app, file);
            expect(readSourceBytes(app, restored.sourceId, 0, restored.byteSize).bytes).toEqual(Array.from(new TextEncoder().encode(await file.text())));
            expect(repeated).toEqual(restored);
        } finally { beginSessionTransition(app); }
    });
    it('preserves BOM, CRLF, duplicate headers, quoted newlines, blanks and ragged cells', async () => {
        const app = store();
        const text = '\uFEFFname,amount,amount\r\n"Total Solutions\nLtd",0,-2\r\nshort,4\r\nlong,5,6,extra\r\n\r\n';
        const bytes = new TextEncoder().encode(text);
        const source = await captureCsvSource(app, new File([bytes], 'ragged.csv'));
        const result = readSourceRecords(app, source.sourceId, 0, 50);
        expect(result.records.map(row => row.cells.map(cell => cell.value))).toEqual([
            ['name', 'amount', 'amount'], ['Total Solutions\nLtd', '0', '-2'], ['short', '4'], ['long', '5', '6', 'extra'], [''],
        ]);
        const returned = readSourceBytes(app, source.sourceId, 0, bytes.length);
        expect(returned.bytes).toEqual(Array.from(bytes));
        returned.bytes[0] = 0;
        expect(readSourceBytes(app, source.sourceId, 0, 1).bytes[0]).toBe(bytes[0]);
        expect(result.records[2].cells[1].cellId).toBe(`${source.sha256}:r2:c1`);
        expect(result.records[1].startLine).toBe(2);
        expect(result.records[1].endLine).toBe(3);
        expect(result.complete).toBe(true);
        beginSessionTransition(app);
        expect(() => readSourceRecords(app, source.sourceId, 0, 1)).toThrow('source_unavailable');
    });
});

describe('source bounds and malformed records', () => {
    it('keeps literal quotes, semicolon dialect and raw excluded summary records', async () => {
        const app = store();
        const source = await captureCsvSource(app, new File(['name;amount\n"quoted; name";-5\nTotal Solutions;0\nGrand total;-5'], 'semicolons.csv'));
        const result = readSourceRecords(app, source.sourceId, 0, 50);
        expect(result.records).toHaveLength(4);
        expect(result.records[1].cells[0].value).toBe('quoted; name');
        expect(result.records[2].cells[0].value).toBe('Total Solutions');
        expect(() => readSourceRecords(app, source.sourceId, 0, 51)).toThrow('source_range_invalid');
        expect(() => readSourceBytes(app, source.sourceId, 0, 65537)).toThrow('source_range_invalid');
    });
    it('refuses a huge record as a positional response and keeps bounded byte access', async () => {
        const app = store();
        const source = await captureCsvSource(app, new File(['name\n' + 'x'.repeat(65536)], 'big-cell.csv'));
        expect(readSourceRecords(app, source.sourceId, 1, 1)).toMatchObject({ complete: false, records: [], blockedReason: 'record_exceeds_read_quota_use_byte_ranges' });
        expect(readSourceBytes(app, source.sourceId, 5, 10).bytes).toHaveLength(10);
        const oversized = new File(['x'], 'huge.csv');
        Object.defineProperty(oversized, 'size', { value: 100 * 1024 * 1024 + 1 });
        await expect(captureCsvSource(app, oversized)).rejects.toThrow('source_resource_limit');
    });
});
