import { Hash } from 'fast-sha256';

/** Parser and evidence bounds are independent of source size. Limits fail, never imply a clean prefix. */
export const CSV_SCAN_LIMITS = Object.freeze({
    chunkBytes: 64 * 1024, maxFieldBytes: 256 * 1024, maxRecordBytes: 1024 * 1024,
    maxColumns: 1024, maxExamples: 32, maxHeaderCandidates: 8, maxBytes: 2 * 1024 * 1024 * 1024, maxRows: 20_000_000,
});
export type CsvScanStatus = 'running' | 'cancelled' | 'failed' | 'completed_clean' | 'completed_anomalies';
export interface CsvScanExample {
    kind: string; row: number; startLine: number; endLine: number;
    byteStart: number; byteEnd: number; width: number; expectedWidth: number | null;
}
export interface CsvScanResult {
    status: CsvScanStatus; bytesRead: number; totalBytes: number; rows: number; physicalLines: number;
    sha256: string | null; reason: string | null; expectedWidth: number | null; headerRow: number | null;
    counts: Record<string, number>; examples: CsvScanExample[]; examplesTruncated: boolean;
    headerCandidates: Array<{ row: number; startLine: number; byteStart: number; width: number }>; headerCandidatesTruncated: boolean;
    peakRecordBytes: number; peakRetainedRows: number;
}
export interface CsvScanOptions { delimiter: string; quoteChar?: string; chunkBytes?: number; maxBytes?: number; maxRows?: number }

/** Blob.arrayBuffer is absent in older WebKit/test DOMs. Only bounded slices reach this helper. */
export const readCsvBlobSlice = (blob: Blob): Promise<Uint8Array> => {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then(buffer => new Uint8Array(buffer));
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
        reader.onerror = () => reject(new Error('scan_source_read_failed'));
        reader.readAsArrayBuffer(blob);
    });
};

/** Private resumable parser state. Resume uses this exact immutable Blob, never a caller's checkpoint.
 * Byte-level framing keeps CSV offsets independent of UTF-8 code points and chunk boundaries.
 * A separate fatal streaming decoder validates every byte, including discarded/evidence-free cells.
 */
export class CsvStreamScanner {
    private readonly hash = new Hash();
    private readonly decoder = new TextDecoder('utf-8', { fatal: true });
    private readonly field = new Uint8Array(CSV_SCAN_LIMITS.maxFieldBytes);
    private fieldLength = 0;
    private cells: string[] = [];
    private header: string[] | null = null;
    private mode: 'start' | 'plain' | 'quoted' | 'after' = 'start';
    private line = 1;
    private rowLine = 1;
    private rowStart = 0;
    private pendingCR: { end: number; line: number } | null = null;
    private lastCR = false;
    private alternateDelimiter = false;
    private cancelled = false;
    private active = false;
    private initialized = false;
    private bomBytes = 0;
    private readonly delimiter: number;
    private readonly quote: number;
    private readonly chunkBytes: number;
    private readonly maxBytes: number;
    private readonly maxRows: number;
    private result: CsvScanResult;
    constructor(private readonly source: Blob, options: CsvScanOptions) {
        if (!options.delimiter || options.delimiter.length !== 1 || options.delimiter.charCodeAt(0) > 127
            || /[\r\n\0]/.test(options.delimiter)) throw new Error('scan_unsupported_dialect');
        const quote = options.quoteChar ?? '"';
        if (quote.length > 1 || (quote && (quote.charCodeAt(0) > 127 || /[\r\n\0]/.test(quote) || quote === options.delimiter))) throw new Error('scan_unsupported_dialect');
        this.delimiter = options.delimiter.charCodeAt(0);
        this.quote = quote ? quote.charCodeAt(0) : -1;
        this.chunkBytes = options.chunkBytes ?? CSV_SCAN_LIMITS.chunkBytes;
        this.maxBytes = Math.min(options.maxBytes ?? CSV_SCAN_LIMITS.maxBytes, CSV_SCAN_LIMITS.maxBytes);
        this.maxRows = Math.min(options.maxRows ?? CSV_SCAN_LIMITS.maxRows, CSV_SCAN_LIMITS.maxRows);
        if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > CSV_SCAN_LIMITS.chunkBytes
            || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0 || !Number.isSafeInteger(this.maxRows) || this.maxRows < 1) throw new Error('scan_invalid_budget');
        this.result = { status: 'running', bytesRead: 0, totalBytes: source.size, rows: 0, physicalLines: 0,
            sha256: null, reason: null, expectedWidth: null, headerRow: null,
            counts: {}, examples: [], examplesTruncated: false, headerCandidates: [], headerCandidatesTruncated: false, peakRecordBytes: 0, peakRetainedRows: 0 };
    }
    snapshot(): CsvScanResult { return structuredClone(this.result); }
    cancel(): void { if (this.active) this.cancelled = true; }
    private anomaly(kind: string, end: number, endLine: number, width = this.cells.length + 1): void {
        this.result.counts[kind] = (this.result.counts[kind] ?? 0) + 1;
        if (this.result.examples.length < CSV_SCAN_LIMITS.maxExamples) this.result.examples.push({
            kind, row: this.result.rows, startLine: this.rowLine, endLine,
            byteStart: this.rowStart, byteEnd: end, width, expectedWidth: this.result.expectedWidth,
        });
        else this.result.examplesTruncated = true;
    }
    private append(byte: number): void {
        if (this.fieldLength >= this.field.length) throw new Error('scan_field_budget');
        this.field[this.fieldLength++] = byte;
    }
    private endField(): void {
        if (this.cells.length >= CSV_SCAN_LIMITS.maxColumns) throw new Error('scan_column_budget');
        this.cells.push(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.field.subarray(0, this.fieldLength)));
        this.fieldLength = 0;
        this.mode = 'start';
    }
    private endRow(end: number, endLine: number): void {
        this.endField();
        if (this.result.rows >= this.maxRows) throw new Error('scan_row_budget');
        const width = this.cells.length;
        const nonblank = this.cells.some(cell => cell.trim());
        if (width === 1 && this.alternateDelimiter) this.anomaly('ambiguous_delimiter', end, endLine, width);
        if (!nonblank) this.anomaly('blank_record', end, endLine, width);
        else if (!this.header) {
            this.header = this.cells;
            this.result.expectedWidth = width;
            this.result.headerRow = this.result.rows;
        } else {
            if (width !== this.result.expectedWidth) this.anomaly('width_mismatch', end, endLine, width);
            if (width === this.header.length && this.cells.every((cell, i) => cell.trim() === this.header![i].trim())) this.anomaly('repeated_header', end, endLine, width);
        }
        // Look for stronger label bands throughout the source, not just its initial sample.
        // Generic lexical evidence locates hypotheses; it does not assign business meaning.
        if (nonblank && width >= 2 && (this.result.headerCandidates.length === 0 || width !== this.result.expectedWidth)
            && this.cells.filter(cell => /[\p{L}]/u.test(cell)).length >= width * 0.75) {
            if (this.result.headerCandidates.length < CSV_SCAN_LIMITS.maxHeaderCandidates) this.result.headerCandidates.push({
                row: this.result.rows, startLine: this.rowLine, byteStart: this.rowStart, width,
            });
            else this.result.headerCandidatesTruncated = true;
            if (width > (this.result.expectedWidth ?? 0)) {
                this.header = this.cells;
                this.result.headerRow = this.result.rows;
                this.result.expectedWidth = width;
            }
        }
        // A changed width remains an anomaly even if a later band suggests another header.
        this.result.peakRetainedRows = Math.max(this.result.peakRetainedRows, this.header ? 2 : 1);
        this.result.rows += 1;
        this.result.physicalLines = endLine;
        this.cells = [];
        this.alternateDelimiter = false;
        this.rowStart = end;
        this.rowLine = endLine + 1;
    }
    private byte(byte: number, offset: number): void {
        if (offset < this.bomBytes) return;
        if (this.pendingCR) {
            const pending = this.pendingCR;
            this.pendingCR = null;
            this.endRow(byte === 10 ? offset + 1 : pending.end, pending.line);
            if (byte === 10) { this.lastCR = false; return; }
        }
        const recordBytes = offset + 1 - this.rowStart;
        this.result.peakRecordBytes = Math.max(this.result.peakRecordBytes, recordBytes);
        if (recordBytes > CSV_SCAN_LIMITS.maxRecordBytes) throw new Error('scan_record_budget');
        const newline = byte === 10 || byte === 13;
        const currentLine = this.line;
        if (byte === 13 || byte === 10 && !this.lastCR) this.line += 1;
        this.lastCR = byte === 13;
        if (this.mode === 'quoted') {
            if (byte === this.quote) this.mode = 'after';
            else this.append(byte);
            return;
        }
        if (this.mode === 'after' && byte === this.quote) { this.append(byte); this.mode = 'quoted'; return; }
        if (byte === this.delimiter) { this.endField(); return; }
        if (byte === 44 || byte === 59 || byte === 9 || byte === 124) this.alternateDelimiter = true;
        if (newline) {
            if (byte === 13) this.pendingCR = { end: offset + 1, line: currentLine };
            else this.endRow(offset + 1, currentLine);
            return;
        }
        if (this.mode === 'start' && byte === this.quote) { this.mode = 'quoted'; return; }
        if (this.mode === 'after' || byte === this.quote) this.anomaly('malformed_quote', offset + 1, currentLine);
        this.append(byte);
        this.mode = 'plain';
    }
    async run(onProgress?: (progress: CsvScanResult) => void, assertCurrent: () => void = () => {}): Promise<CsvScanResult> {
        if (this.active) throw new Error('scan_already_running');
        if (this.result.status !== 'running' && this.result.status !== 'cancelled') throw new Error('scan_terminal');
        this.active = true;
        this.cancelled = false;
        this.result.status = 'running';
        try {
            assertCurrent();
            if (this.source.size > this.maxBytes) throw new Error('scan_source_budget');
            if (!this.initialized) {
                const head = await readCsvBlobSlice(this.source.slice(0, 3));
                assertCurrent();
                if (head[0] === 0xff && head[1] === 0xfe || head[0] === 0xfe && head[1] === 0xff) throw new Error('scan_unsupported_encoding');
                this.bomBytes = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
                this.initialized = true;
            }
            while (this.result.bytesRead < this.source.size && !this.cancelled) {
                const start = this.result.bytesRead;
                const end = Math.min(start + this.chunkBytes, this.source.size);
                const bytes = await readCsvBlobSlice(this.source.slice(start, end));
                assertCurrent();
                if (bytes.length !== end - start) throw new Error('scan_source_read_failed');
                if (bytes.includes(0)) throw new Error('scan_unsupported_encoding');
                try { this.decoder.decode(bytes, { stream: true }); } catch { throw new Error('scan_invalid_utf8'); }
                this.hash.update(bytes);
                for (let i = 0; i < bytes.length; i += 1) this.byte(bytes[i], start + i);
                this.result.bytesRead = end;
                onProgress?.(this.snapshot());
                // Macrotask yield: cancellation, paint and source/session replacement get a chance to run.
                if (end < this.source.size) await new Promise<void>(resolve => setTimeout(resolve, 0));
                assertCurrent();
            }
            if (this.cancelled) this.result.status = 'cancelled';
            else {
                try { this.decoder.decode(); } catch { throw new Error('scan_invalid_utf8'); }
                if (this.pendingCR) { this.endRow(this.pendingCR.end, this.pendingCR.line); this.pendingCR = null; }
                if (this.rowStart < this.source.size) {
                    if (this.mode === 'quoted') this.anomaly('unclosed_quote', this.source.size, this.line);
                    this.endRow(this.source.size, this.line);
                }
                if (!this.header) throw new Error('scan_empty_source');
                this.result.sha256 = Array.from(this.hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
                this.result.status = Object.keys(this.result.counts).length ? 'completed_anomalies' : 'completed_clean';
            }
        } catch (error) {
            this.result.status = 'failed';
            this.result.reason = error instanceof Error ? error.message : 'scan_source_read_failed';
            this.result.sha256 = null;
        } finally { this.active = false; }
        assertCurrent();
        onProgress?.(this.snapshot());
        return this.snapshot();
    }
}
