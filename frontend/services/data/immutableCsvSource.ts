import * as Papa from 'papaparse';
import type { StoreApi } from '../agent/types';
import { assertSessionResourceActive, captureSessionScope, registerSessionResource, type SessionScope } from '../session/sessionOwnership';
import { parseCsvTextWithDetection } from './csvDialectDetector';
import { sha256Bytes } from './sourceDigest';
import { CsvStreamScanner, readCsvBlobSlice, type CsvRecordSpan } from './csvStreamScanner';

import type { CsvSourceMetadata } from '../../types/intake';
export type { CsvSourceMetadata } from '../../types/intake';

interface Source {
    metadata: CsvSourceMetadata; bytes: Uint8Array | null; blob: File;
    records: Array<{ start: number; end: number; startLine: number; endLine: number }>;
    checkpoints?: CsvRecordSpan[];
}
const sources = new WeakMap<SessionScope, Map<string, Source>>();
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_SESSION_BYTES = 200 * 1024 * 1024;
const MAX_RECORDS = 1_000_000;
const MAX_READ_BYTES = 64 * 1024;
export const SOURCE_RECORDS_PATH = '/intake/source-records.json';
export const SOURCE_BYTES_PATH = '/dataset/source.bytes';
export const SOURCE_METADATA_PATH = '/intake/source.json';
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const sourceFor = (store: StoreApi, id: string) => {
    const scope = captureSessionScope(store);
    assertSessionResourceActive(store, scope);
    const source = sources.get(scope)?.get(id);
    if (!source) throw new Error('source_unavailable');
    return source;
};
/** Register only a fully scanned immutable Blob. Sparse coordinates, not per-record indexes,
 * bound seek work without cloning the original. The scan owner revokes this handle on replacement.
 */
export const registerScannedCsvBlob = (store: StoreApi, blob: File, metadata: CsvSourceMetadata, checkpoints: CsvRecordSpan[]): (() => void) => {
    const scope = captureSessionScope(store);
    assertSessionResourceActive(store, scope);
    const entries = sources.get(scope) ?? new Map<string, Source>();
    if (blob.size !== metadata.byteSize || blob.size > MAX_SOURCE_BYTES || checkpoints.length > 20000
        || [...entries.values()].reduce((sum, entry) => sum + entry.metadata.byteSize, 0) + blob.size > MAX_SESSION_BYTES) throw new Error('source_resource_limit');
    const source: Source = { metadata, blob, bytes: null, records: [], checkpoints: checkpoints.map(span => ({ ...span })) };
    entries.set(metadata.sourceId, source); sources.set(scope, entries);
    const unregister = registerSessionResource(scope, () => { if (entries.get(metadata.sourceId) === source) entries.delete(metadata.sourceId); });
    return () => { unregister(); if (entries.get(metadata.sourceId) === source) entries.delete(metadata.sourceId); };
};

/** Snapshot bytes before any header mapping. Only metadata may enter saved History. */
export const captureCsvSource = async (store: StoreApi, file: File): Promise<CsvSourceMetadata> => {
    const scope = captureSessionScope(store);
    assertSessionResourceActive(store, scope);
    if (file.size > MAX_SOURCE_BYTES) throw new Error('source_resource_limit');
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertSessionResourceActive(store, scope);
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('source_resource_limit');
    const sha256 = await sha256Bytes(bytes);
    assertSessionResourceActive(store, scope);
    const existing = sources.get(scope) ?? new Map<string, Source>();
    const previous = [...existing.values()].find(source => source.metadata.sha256 === sha256 && source.metadata.fileName === file.name);
    if (previous) return previous.metadata;
    if ([...existing.values()].reduce((sum, source) => sum + source.metadata.byteSize, 0) + bytes.length > MAX_SESSION_BYTES) throw new Error('source_resource_limit');
    const decoder = new TextDecoder();
    const { detection } = parseCsvTextWithDetection(decoder.decode(bytes.subarray(0, 128 * 1024)));
    const dialect = { delimiter: detection.delimiter ?? ',', quoteChar: detection.quoteChar ?? '"' };
    const delimiter = dialect.delimiter.charCodeAt(0);
    const quote = dialect.quoteChar.charCodeAt(0);
    const records: Source['records'] = [];
    let start = 0; let startLine = 1; let line = 1; let quoted = false; let fieldStart = true;
    const bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 3 : 0;
    for (let index = bom; index < bytes.length; index += 1) {
        if (index > 0 && index % (1024 * 1024) === 0) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            assertSessionResourceActive(store, scope);
        }
        const byte = bytes[index];
        if (byte === quote) {
            if (quoted && bytes[index + 1] === quote) { index += 1; continue; }
            if (quoted || fieldStart) { quoted = !quoted; fieldStart = false; continue; }
        }
        const newline = byte === 10 || byte === 13;
        if (newline) {
            const end = byte === 13 && bytes[index + 1] === 10 ? index + 2 : index + 1;
            if (!quoted) {
                records.push({ start, end, startLine, endLine: line });
                if (records.length > MAX_RECORDS) throw new Error('source_resource_limit');
                start = end; startLine = line + 1; fieldStart = true;
            }
            line += 1;
            if (end === index + 2) index += 1;
        } else if (!quoted) fieldStart = byte === delimiter;
    }
    if (start < bytes.length) records.push({ start, end: bytes.length, startLine, endLine: line });
    if (records.length > MAX_RECORDS) throw new Error('source_resource_limit');
    const diagnostics = quoted ? ['unclosed_quote'] : [];
    if (detection.delimiter === null || detection.quoteChar === null) diagnostics.push('dialect_fallback_standard_csv');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { diagnostics.push('invalid_utf8'); }
    const metadata: CsvSourceMetadata = Object.freeze({ sourceId: crypto.randomUUID(), sha256, byteSize: bytes.length,
        fileName: file.name, recordCount: records.length,
        dialect: Object.freeze(dialect), diagnostics: Object.freeze(diagnostics) });
    assertSessionResourceActive(store, scope);
    // Another capture can finish during hashing/indexing. Recheck quotas at publication.
    const current = sources.get(scope) ?? existing;
    if ([...current.values()].reduce((sum, source) => sum + source.metadata.byteSize, 0) + bytes.length > MAX_SESSION_BYTES) throw new Error('source_resource_limit');
    current.set(metadata.sourceId, { metadata, bytes, records, blob: file }); sources.set(scope, current);
    registerSessionResource(scope, () => { current.clear(); sources.delete(scope); });
    return metadata;
};
export const readSourceBytes = (store: StoreApi, id: string, offset: number, length: number) => {
    const source = sourceFor(store, id);
    if (!integer(offset) || !integer(length) || length > MAX_READ_BYTES || offset > source.metadata.byteSize) throw new Error('source_range_invalid');
    if (!source.bytes) {
        if (length === 0) return { source: source.metadata, offset, end: offset, bytes: [], complete: offset === source.metadata.byteSize };
        throw new Error('source_requires_bounded_async_read');
    }
    const end = Math.min(source.bytes.length, offset + length);
    return { source: source.metadata, offset, end, bytes: Array.from(source.bytes.subarray(offset, end)), complete: end === source.bytes.length };
};
/** Host-only immutable source handle for bounded streaming; never exposed as a model capability. */
export const getRetainedCsvSourceBlob = (store: StoreApi, id: string): File => sourceFor(store, id).blob;
/** Host recovery/retention capture only; no model tool exposes complete source bytes. */
export const captureRecoverySource = (store: StoreApi, id: string): { metadata: CsvSourceMetadata; bytes: Uint8Array } => {
    const source = sourceFor(store, id);
    if (!source.bytes || source.bytes.length > 8 * 1024 * 1024) throw new Error('recovery_source_capacity');
    return { metadata: structuredClone(source.metadata), bytes: source.bytes.slice() };
};
/** A saved source ID is a locator. Only newly verified bytes acquire access in this epoch. */
export const bindRecoverySource = async (store: StoreApi, file: File, expected: CsvSourceMetadata): Promise<void> => {
    const scope = captureSessionScope(store);
    if (file.size > 8 * 1024 * 1024 || expected.byteSize > 8 * 1024 * 1024) throw new Error('recovery_source_capacity');
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertSessionResourceActive(store, scope);
    if (bytes.length !== expected.byteSize || await sha256Bytes(bytes) !== expected.sha256) throw new Error('recovery_source_mismatch');
    assertSessionResourceActive(store, scope);
    const actual = await captureCsvSource(store, new File([bytes], expected.fileName));
    const signature = (s: CsvSourceMetadata) => JSON.stringify([s.sha256, s.byteSize, s.recordCount, s.dialect, s.diagnostics]);
    if (signature(actual) !== signature(expected)) throw new Error('recovery_source_structure_mismatch');
    assertSessionResourceActive(store, scope);
    const entries = sources.get(scope)!, verified = entries.get(actual.sourceId)!;
    if (entries.has(expected.sourceId) && entries.get(expected.sourceId)!.metadata.sha256 !== expected.sha256) throw new Error('recovery_source_mismatch');
    entries.set(expected.sourceId, { ...verified, metadata: Object.freeze(structuredClone(expected)) });
};
export const readSourceRecords = (store: StoreApi, id: string, startRow: number, count: number) => {
    const source = sourceFor(store, id);
    if (!source.bytes) throw new Error('source_requires_bounded_async_read');
    if (!integer(startRow) || !integer(count) || count > 50 || startRow > source.records.length) throw new Error('source_range_invalid');
    let consumed = 0;
    let outputBytes = 0;
    const records = [];
    for (let row = startRow; row < Math.min(source.records.length, startRow + count); row += 1) {
        const span = source.records[row];
        if (consumed + span.end - span.start > MAX_READ_BYTES) break;
        consumed += span.end - span.start;
        const rawText = new TextDecoder().decode(source.bytes.subarray(span.start, span.end));
        const text = rawText.replace(/(?:\r\n|\n|\r)$/, '');
        const result = Papa.parse<string[]>(text, { header: false, skipEmptyLines: false,
            delimiter: source.metadata.dialect.delimiter ?? ',', quoteChar: source.metadata.dialect.quoteChar ?? '"' });
        const cells = (result.data[0] ?? (text === '' ? [''] : [])).map((value, column) => ({ cellId: `${source.metadata.sha256}:r${row}:c${column}`, column, value }));
        const record = { rowId: `${source.metadata.sha256}:r${row}`, row, byteStart: span.start, byteEnd: span.end,
            startLine: span.startLine, endLine: span.endLine, rawText, cells, diagnostics: result.errors.map(error => error.code) };
        outputBytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
        if (outputBytes > MAX_READ_BYTES) break;
        records.push(record);
    }
    const nextRow = startRow + records.length;
    return { source: source.metadata, startRow, nextRow, records, complete: nextRow === source.records.length,
        blockedReason: records.length === 0 && count > 0 && startRow < source.records.length ? 'record_exceeds_read_quota_use_byte_ranges' : null };
};

const rangeFence = (store: StoreApi, id: string, source: Source) => {
    const scope = captureSessionScope(store), inspection = store.getState().datasetBundle?.source.inspection;
    return () => {
        assertSessionResourceActive(store, scope);
        if (sourceFor(store, id) !== source || store.getState().datasetBundle?.source.inspection !== inspection) throw new Error('source_range_stale');
    };
};
export const captureSourceRangeFence = (store: StoreApi, id: string): (() => void) => rangeFence(store, id, sourceFor(store, id));
export const readSourceBytesBounded = async (store: StoreApi, id: string, offset: number, length: number) => {
    const source = sourceFor(store, id), assertCurrent = rangeFence(store, id, source);
    if (source.bytes) return readSourceBytes(store, id, offset, length);
    if (!integer(offset) || !integer(length) || length > MAX_READ_BYTES || offset > source.metadata.byteSize) throw new Error('source_range_invalid');
    const end = Math.min(source.metadata.byteSize, offset + length);
    const bytes = await readCsvBlobSlice(source.blob.slice(offset, end));
    assertCurrent();
    return { source: source.metadata, offset, end, bytes: Array.from(bytes), complete: end === source.metadata.byteSize };
};
export const readSourceRecordsBounded = async (store: StoreApi, id: string, startRow: number, count: number) => {
    const source = sourceFor(store, id), assertCurrent = rangeFence(store, id, source);
    if (source.bytes) return readSourceRecords(store, id, startRow, count);
    const total = source.metadata.recordCount;
    if (!integer(startRow) || !integer(count) || count > 50 || startRow > total) throw new Error('source_range_invalid');
    const spans: CsvRecordSpan[] = [];
    const checkpoints = source.checkpoints!;
    let lo = 0, hi = checkpoints.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (checkpoints[mid].row <= startRow) lo = mid; else hi = mid - 1; }
    const anchor = checkpoints[lo];
    if (count && startRow < total && anchor) {
        // Checkpoints every 1024 records OR 512 KiB; with the scanner's 1 MiB record
        // limit a seek plus a requested record fits this independent bounded work budget.
        const end = Math.min(source.blob.size, anchor.start + 4 * 1024 * 1024);
        const slice = source.blob.slice(anchor.start, end);
        let consumed = 0;
        const scanner = new CsvStreamScanner(slice, { delimiter: source.metadata.dialect.delimiter ?? ',', quoteChar: source.metadata.dialect.quoteChar ?? '"', onRecord: span => {
            const row = anchor.row + span.row;
            if (row < startRow || row >= startRow + count) return;
            if (end < source.blob.size && span.end === slice.size) return;
            if (consumed + span.end - span.start > MAX_READ_BYTES) return;
            // A too-large earlier record must not be skipped to return a later row.
            if (row !== startRow + spans.length) return;
            consumed += span.end - span.start;
            spans.push({ row, start: anchor.start + span.start, end: anchor.start + span.end,
                startLine: anchor.startLine + span.startLine - 1, endLine: anchor.startLine + span.endLine - 1 });
        } });
        await scanner.run(progress => { if (spans.length >= count || progress.rows + anchor.row > startRow + count) scanner.cancel(); }, assertCurrent);
        assertCurrent();
    }
    const records: ReturnType<typeof readSourceRecords>['records'] = [];
    let outputBytes = 0;
    for (const span of spans) {
        const rawText = new TextDecoder().decode(await readCsvBlobSlice(source.blob.slice(span.start, span.end)));
        assertCurrent();
        const text = rawText.replace(/(?:\r\n|\n|\r)$/, '');
        const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: false, delimiter: source.metadata.dialect.delimiter ?? ',', quoteChar: source.metadata.dialect.quoteChar ?? '"' });
        const cells = (parsed.data[0] ?? (text === '' ? [''] : [])).map((value, column) => ({ cellId: `${source.metadata.sha256}:r${span.row}:c${column}`, column, value }));
        const record = { rowId: `${source.metadata.sha256}:r${span.row}`, row: span.row, byteStart: span.start, byteEnd: span.end,
            startLine: span.startLine, endLine: span.endLine, rawText, cells, diagnostics: parsed.errors.map(error => error.code) };
        outputBytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
        if (outputBytes > MAX_READ_BYTES) break;
        records.push(record);
    }
    const nextRow = startRow + records.length;
    return { source: source.metadata, startRow, nextRow, records, complete: nextRow === total,
        blockedReason: !records.length && count > 0 && startRow < total ? 'record_exceeds_read_quota_use_byte_ranges' : null };
};
