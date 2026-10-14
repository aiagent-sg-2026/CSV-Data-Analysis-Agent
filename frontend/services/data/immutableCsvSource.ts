import * as Papa from 'papaparse';
import type { StoreApi } from '../agent/types';
import { assertSessionResourceActive, captureSessionScope, registerSessionResource, type SessionScope } from '../session/sessionOwnership';
import { parseCsvTextWithDetection } from './csvDialectDetector';
import { sha256Bytes } from './sourceDigest';

import type { CsvSourceMetadata } from '../../types/intake';
export type { CsvSourceMetadata } from '../../types/intake';

interface Source {
    metadata: CsvSourceMetadata; bytes: Uint8Array;
    records: Array<{ start: number; end: number; startLine: number; endLine: number }>;
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
    if ([...existing.values()].reduce((sum, source) => sum + source.bytes.length, 0) + bytes.length > MAX_SESSION_BYTES) throw new Error('source_resource_limit');
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
    if ([...current.values()].reduce((sum, source) => sum + source.bytes.length, 0) + bytes.length > MAX_SESSION_BYTES) throw new Error('source_resource_limit');
    current.set(metadata.sourceId, { metadata, bytes, records }); sources.set(scope, current);
    registerSessionResource(scope, () => { current.clear(); sources.delete(scope); });
    return metadata;
};
export const readSourceBytes = (store: StoreApi, id: string, offset: number, length: number) => {
    const source = sourceFor(store, id);
    if (!integer(offset) || !integer(length) || length > MAX_READ_BYTES || offset > source.bytes.length) throw new Error('source_range_invalid');
    const end = Math.min(source.bytes.length, offset + length);
    return { source: source.metadata, offset, end, bytes: Array.from(source.bytes.subarray(offset, end)), complete: end === source.bytes.length };
};
/** Host recovery/retention capture only; no model tool exposes complete source bytes. */
export const captureRecoverySource = (store: StoreApi, id: string): { metadata: CsvSourceMetadata; bytes: Uint8Array } => {
    const source = sourceFor(store, id);
    if (source.bytes.length > 8 * 1024 * 1024) throw new Error('recovery_source_capacity');
    return { metadata: structuredClone(source.metadata), bytes: source.bytes.slice() };
};
/** A saved source ID is a locator. Only newly verified bytes acquire access in this epoch. */
export const bindRecoverySource = async (store: StoreApi, file: File, expected: CsvSourceMetadata): Promise<void> => {
    const scope = captureSessionScope(store);
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
