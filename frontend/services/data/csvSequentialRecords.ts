import * as Papa from 'papaparse';
import type { CsvSourceMetadata } from '../../types/intake';
import { readCsvBlobSlice } from './csvStreamScanner';

const CHUNK_BYTES = 64 * 1024;
const encoder = new TextEncoder();
export interface SequentialRecord {
    rowId: string; row: number; byteStart: number; byteEnd: number; startLine: number; endLine: number;
    rawText: string; cells: Array<{ cellId: string; column: number; value: string }>; diagnostics: string[];
}

/** Private forward-only parser. A batch is acknowledged only after its durable write/validation.
 * Cancellation preserves partial framing and the unacknowledged batch, never a caller checkpoint.
 * No hash pass here: the registry already verified this exact retained original at intake.
 */
export const createCsvSequentialRecords = (blob: Blob, source: CsvSourceMetadata,
    current: () => void, charge: (bytes: number) => void, chunkBytes = CHUNK_BYTES) => {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 3 || chunkBytes > CHUNK_BYTES) throw new Error('source_range_invalid');
    const delimiter = source.dialect.delimiter ?? ',', quote = source.dialect.quoteChar ?? '"';
    if (delimiter.length !== 1 || delimiter.charCodeAt(0) > 127 || /[\r\n\0]/.test(delimiter)
        || quote.length > 1 || quote && (quote.charCodeAt(0) > 127 || /[\r\n\0]/.test(quote) || quote === delimiter)) throw new Error('source_stream_binding_invalid');
    let buffer = new Uint8Array(0), index = 0, offset = 0, row = 0, start = 0, line = 1, startLine = 1;
    let mode: 'start' | 'plain' | 'quoted' | 'after' = 'start', lastCR = false, pendingCR = false;
    const raw = new Uint8Array(CHUNK_BYTES);
    let rawLength = 0, pending: SequentialRecord | undefined, requested = 0, outputBytes = 0, batchRaw = 0;
    let records: SequentialRecord[] = [], ready = false;
    const peek = async (): Promise<number | undefined> => {
        current();
        if (index === buffer.length && offset < blob.size) {
            const end = Math.min(offset + chunkBytes, blob.size);
            // Reserve the entire requested read before invoking native I/O. Rejections/cancellations
            // still consume that physical work; a denied reservation never starts a read.
            charge(end - offset);
            let bytes: Uint8Array;
            try { bytes = await readCsvBlobSlice(blob.slice(offset, end)); }
            catch (error) { current(); throw new Error('source_record_scan_failed', { cause: error }); }
            current();
            if (bytes.length !== end - offset) throw new Error('source_record_scan_failed');
            buffer = bytes; index = 0;
        }
        return buffer[index];
    };
    const take = (byte: number) => {
        if (rawLength === raw.length) throw new Error('source_stream_record_capacity');
        raw[rawLength++] = byte; index++; offset++;
    };
    const finish = (): SequentialRecord => {
        let rawText: string;
        try { rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: start !== 0 }).decode(raw.subarray(0, rawLength)); }
        catch { throw new Error('source_record_scan_failed'); }
        const text = rawText.replace(/(?:\r\n|\n|\r)$/, '');
        const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: false, delimiter, quoteChar: quote });
        const result = { rowId: `${source.sha256}:r${row}`, row, byteStart: start, byteEnd: offset,
            startLine, endLine: pendingCR || raw[rawLength - 1] === 10 ? line - 1 : line, rawText,
            cells: (parsed.data[0] ?? (text === '' ? [''] : [])).map((value, column) => ({ cellId: `${source.sha256}:r${row}:c${column}`, column, value })),
            diagnostics: parsed.errors.map(error => error.code) };
        row++; start = offset; startLine = line; rawLength = 0; mode = 'start'; pendingCR = false;
        return result;
    };
    const next = async (): Promise<SequentialRecord | undefined> => {
        while (true) {
            const byte = index < buffer.length ? buffer[index] : await peek();
            if (pendingCR) {
                if (byte === 10) { take(byte); lastCR = false; }
                return finish();
            }
            if (byte === undefined) {
                if (!rawLength) return undefined;
                if (mode === 'quoted') throw new Error('source_record_scan_failed');
                return finish();
            }
            const position = offset; take(byte);
            if (position < 3 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191) continue;
            if (byte === 13 || byte === 10 && !lastCR) line++;
            lastCR = byte === 13;
            if (mode === 'quoted') { if (byte === quote.charCodeAt(0)) mode = 'after'; continue; }
            if (mode === 'after' && byte === quote.charCodeAt(0)) { mode = 'quoted'; continue; }
            if (byte === delimiter.charCodeAt(0)) { mode = 'start'; continue; }
            if (byte === 13) { pendingCR = true; continue; }
            if (byte === 10) return finish();
            if (mode === 'start' && byte === quote.charCodeAt(0)) mode = 'quoted';
            else mode = 'plain';
        }
    };
    return {
        async read(count: number) {
            current();
            if (!Number.isSafeInteger(count) || count < 1 || count > 50 || requested && count !== requested) throw new Error('source_range_invalid');
            requested = count;
            if (!ready) {
                while (records.length < count) {
                    const record = pending ?? await next();
                    // Keep the completed private record before the post-await fence can cancel;
                    // its parser position has advanced, but the batch has not acknowledged it yet.
                    pending = record; current();
                    if (!record) { ready = true; break; }
                    const size = encoder.encode(JSON.stringify(record)).byteLength;
                    if (outputBytes + size > CHUNK_BYTES || batchRaw + record.byteEnd - record.byteStart > CHUNK_BYTES) {
                        if (!records.length) throw new Error('source_stream_record_capacity');
                        break;
                    }
                    records.push(record); outputBytes += size; batchRaw += record.byteEnd - record.byteStart; pending = undefined;
                }
                ready = true;
            }
            const startRow = records[0]?.row ?? row;
            const nextRow = startRow + records.length;
            if (nextRow > source.recordCount || nextRow === source.recordCount && records.at(-1)?.byteEnd !== source.byteSize
                || !records.length && startRow < source.recordCount) throw new Error('source_stream_incomplete');
            return { source, startRow, nextRow, records, complete: nextRow === source.recordCount };
        },
        commit() { if (!ready) throw new Error('source_stream_cursor_invalid'); records = []; requested = outputBytes = batchRaw = 0; ready = false; },
        get retainedBytes() { return raw.byteLength + buffer.byteLength + outputBytes + (pending ? encoder.encode(JSON.stringify(pending)).byteLength : 0); },
    };
};
