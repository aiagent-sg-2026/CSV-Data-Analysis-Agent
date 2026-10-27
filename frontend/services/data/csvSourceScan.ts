import type { StoreApi } from '../agent/types';
import type { CsvSourceMetadata } from '../../types/intake';
import { assertSessionResourceActive, captureSessionScope, registerSessionResource, type SessionScope } from '../session/sessionOwnership';
import { CsvStreamScanner, readCsvBlobSlice, type CsvScanResult } from './csvStreamScanner';
import { parseCsvTextWithDetection } from './csvDialectDetector';
import { getRetainedCsvSourceBlob } from './immutableCsvSource';

/** Display-only projection. Neither this object nor a saved checkpoint can grant scan authority. */
export interface CsvSourceScanView extends CsvScanResult {
    scanId: string; sourceVersion: string; fileName: string; sessionId: string; sessionEpoch: number;
    delimiter: string; quoteChar: string; commitAllowed: false;
}
interface Entry {
    scope: SessionScope; source: File; scanId: string; sourceVersion: string; scanner: CsvStreamScanner | null;
    result: CsvScanResult | null; delimiter: string; quoteChar: string; boundSourceId: string | null;
    running: boolean; cancelled: boolean; retired: boolean; unregister: () => void;
    completion: Promise<CsvScanResult>; resolve: (result: CsvScanResult) => void; reject: (error: Error) => void;
}
const scans = new WeakMap<SessionScope, Entry>();
const current = (store: StoreApi, entry: Entry) => {
    assertSessionResourceActive(store, entry.scope);
    if (entry.retired || scans.get(entry.scope) !== entry) throw new Error('scan_source_replaced');
};
const publish = (store: StoreApi, entry: Entry, result: CsvScanResult) => {
    current(store, entry);
    entry.result = result;
    store.setState({ csvSourceScan: { ...structuredClone(result), scanId: entry.scanId, sourceVersion: entry.sourceVersion,
        fileName: entry.source.name, sessionId: entry.scope.sessionId, sessionEpoch: entry.scope.epoch,
        delimiter: entry.delimiter, quoteChar: entry.quoteChar, commitAllowed: false } });
};
const retire = (entry: Entry) => {
    entry.retired = true;
    entry.unregister();
    entry.scanner?.cancel();
    entry.reject(new Error('scan_source_replaced'));
};
const execute = async (store: StoreApi, entry: Entry): Promise<void> => {
    // Claim before the first read/await, including dialect initialization.
    if (entry.running) throw new Error('scan_already_running');
    entry.running = true;
    try {
        current(store, entry);
        if (!entry.scanner) {
            const bytes = await readCsvBlobSlice(entry.source.slice(0, 64 * 1024));
            current(store, entry);
            // A sample selects a dialect only. It never supplies full-source coverage evidence.
            const sample = new TextDecoder('utf-8').decode(bytes, { stream: true });
            const { detection } = parseCsvTextWithDetection(sample);
            if (detection.strategy === 'fixed_width_layout') throw new Error('scan_fixed_width_requires_layout_scanner');
            entry.delimiter = detection.delimiter ?? ',';
            entry.quoteChar = detection.quoteChar ?? '"';
            entry.scanner = new CsvStreamScanner(entry.source, { delimiter: entry.delimiter, quoteChar: entry.quoteChar });
            if (entry.cancelled) {
                const result = { ...entry.scanner.snapshot(), status: 'cancelled' as const };
                publish(store, entry, result);
                return;
            }
        }
        let lastPublish = 0;
        const result = await entry.scanner.run(progress => {
            if (entry.cancelled) entry.scanner!.cancel();
            if (performance.now() - lastPublish > 80 || progress.status !== 'running') {
                publish(store, entry, progress); lastPublish = performance.now();
            }
        }, () => current(store, entry));
        publish(store, entry, result);
        if (result.status !== 'cancelled') entry.resolve(structuredClone(result));
    } catch (error) {
        if (!entry.retired) {
            const result: CsvScanResult = { status: 'failed', bytesRead: 0, totalBytes: entry.source.size, rows: 0, physicalLines: 0,
                sha256: null, reason: error instanceof Error ? error.message : 'scan_source_read_failed', expectedWidth: null,
                headerRow: null, counts: {}, examples: [], examplesTruncated: false, headerCandidates: [], headerCandidatesTruncated: false, peakRecordBytes: 0, peakRetainedRows: 0 };
            try { publish(store, entry, result); entry.resolve(structuredClone(result)); } catch { entry.reject(new Error('scan_source_replaced')); }
        }
    } finally { entry.running = false; }
};

/** Retain the immutable File itself, not a full byte/row copy. Cancel pauses the import here;
 * resume restarts only this private parser/hash state. Epoch/source changes revoke the waiter.
 */
export const scanCsvSourceForImport = (store: StoreApi, source: File): Promise<CsvScanResult> => {
    const scope = captureSessionScope(store), prior = scans.get(scope);
    if (prior && !prior.retired && prior.source === source) return prior.completion.then(result => structuredClone(result));
    if (prior) retire(prior);
    let resolve!: Entry['resolve'], reject!: Entry['reject'];
    const completion = new Promise<CsvScanResult>((yes, no) => { resolve = yes; reject = no; });
    const entry: Entry = { scope, source, scanId: crypto.randomUUID(), sourceVersion: crypto.randomUUID(), scanner: null,
        result: null, delimiter: ',', quoteChar: '"', boundSourceId: null, running: false, cancelled: false, retired: false, unregister: () => {},
        completion, resolve, reject };
    scans.set(scope, entry);
    // Avoid an unhandled rejection if retirement precedes the caller attaching its await.
    void completion.catch(() => {});
    entry.unregister = registerSessionResource(scope, () => { retire(entry); if (scans.get(scope) === entry) scans.delete(scope); });
    publish(store, entry, { status: 'running', bytesRead: 0, totalBytes: source.size, rows: 0, physicalLines: 0,
        sha256: null, reason: null, expectedWidth: null, headerRow: null, counts: {}, examples: [], examplesTruncated: false,
        headerCandidates: [], headerCandidatesTruncated: false, peakRecordBytes: 0, peakRetainedRows: 0 });
    void execute(store, entry);
    return completion.then(result => structuredClone(result));
};
const actionEntry = (store: StoreApi, scanId: string, sourceVersion: string) => {
    const entry = scans.get(captureSessionScope(store));
    if (!entry || entry.scanId !== scanId || entry.sourceVersion !== sourceVersion) throw new Error('scan_action_stale');
    current(store, entry);
    return entry;
};
export const cancelCsvSourceScan = (store: StoreApi, scanId: string, sourceVersion: string): void => {
    const entry = actionEntry(store, scanId, sourceVersion);
    if (!entry.running || entry.cancelled) throw new Error('scan_action_stale');
    entry.cancelled = true;
    entry.scanner?.cancel();
};
export const resumeCsvSourceScan = (store: StoreApi, scanId: string, sourceVersion: string): Promise<void> => {
    const entry = actionEntry(store, scanId, sourceVersion);
    if (entry.running || entry.result?.status !== 'cancelled') throw new Error('scan_action_stale');
    entry.cancelled = false;
    return execute(store, entry);
};

/** New upload intent revokes a paused/running original before another awaited pipeline starts. */
export const discardCsvSourceScan = (store: StoreApi): void => {
    const scope = captureSessionScope(store), entry = scans.get(scope);
    if (entry) { retire(entry); scans.delete(scope); }
    store.setState({ csvSourceScan: null });
};

/** Freshness only, including anomalous raw staging. Never authorization for canonical publication. */
export const captureCsvSourceScanFence = (store: StoreApi, source: File): (() => void) => {
    const entry = scans.get(captureSessionScope(store));
    if (!entry || entry.source !== source || !entry.result?.sha256 || !entry.boundSourceId) throw new Error('scan_source_unverified');
    const sha = entry.result.sha256, sourceId = entry.boundSourceId;
    return () => {
        current(store, entry);
        if (entry.source !== source || entry.result?.sha256 !== sha || entry.boundSourceId !== sourceId
            || !entry.result.status.startsWith('completed_')) throw new Error('scan_source_replaced');
    };
};

/** The upload caller binds the real retained source locator, not a UI-supplied digest. */
export const bindCsvSourceScan = (store: StoreApi, source: File, metadata: CsvSourceMetadata): void => {
    const entry = scans.get(captureSessionScope(store));
    if (!entry || entry.source !== source || entry.result?.sha256 !== metadata.sha256 || source.size !== metadata.byteSize
        || metadata.dialect.delimiter !== entry.delimiter || metadata.dialect.quoteChar !== entry.quoteChar) throw new Error('scan_source_binding_mismatch');
    current(store, entry);
    entry.boundSourceId = metadata.sourceId;
};
export const scannedCsvSourceMetadata = (store: StoreApi, source: File): CsvSourceMetadata => {
    const entry = scans.get(captureSessionScope(store));
    if (!entry || entry.source !== source || !entry.result?.sha256 || !entry.result.status.startsWith('completed_')) throw new Error('scan_source_unverified');
    current(store, entry);
    entry.boundSourceId = entry.scanId;
    return Object.freeze({ sourceId: entry.scanId, sha256: entry.result.sha256, byteSize: source.size, fileName: source.name,
        recordCount: entry.result.rows, dialect: Object.freeze({ delimiter: entry.delimiter, quoteChar: entry.quoteChar }),
        diagnostics: Object.freeze(['streaming_source_use_scan_evidence_not_legacy_record_index']) });
};

/** Existing small-source imports can lazily acquire the same full scan. No rawRows clone/sample
 * or mutable public scan projection is accepted as evidence. Missing retained bytes fail closed.
 */
export const requireCurrentCsvSourceScan = async (store: StoreApi): Promise<CsvScanResult> => {
    const scope = captureSessionScope(store), inspection = store.getState().datasetBundle?.source.inspection;
    if (!inspection) throw new Error('scan_original_source_unavailable_reselect_original');
    let entry = scans.get(scope);
    if (!entry || entry.boundSourceId !== inspection.sourceId) {
        let source: File;
        try { source = getRetainedCsvSourceBlob(store, inspection.sourceId); }
        catch { throw new Error('scan_original_source_unavailable_reselect_original'); }
        await scanCsvSourceForImport(store, source);
        bindCsvSourceScan(store, source, inspection);
        entry = scans.get(scope);
    } else await entry.completion;
    assertSessionResourceActive(store, scope);
    if (!entry || scans.get(scope) !== entry || entry.retired || store.getState().datasetBundle?.source.inspection !== inspection
        || entry.boundSourceId !== inspection.sourceId || entry.result?.sha256 !== inspection.sha256
        || entry.source.size !== inspection.byteSize || inspection.dialect.delimiter !== entry.delimiter
        || inspection.dialect.quoteChar !== entry.quoteChar) throw new Error('scan_source_changed_or_unverified');
    return structuredClone(entry.result);
};

/** Synchronous publication fence: only a private complete result on the exact current source. */
export const assertCsvScanPublicationAllowed = (store: StoreApi): void => {
    const entry = scans.get(captureSessionScope(store));
    if (!entry) return;
    current(store, entry);
    if (entry.result?.status !== 'completed_clean') throw new Error('source_scan_requires_automatic_repair_or_resume');
    const inspection = store.getState().datasetBundle?.source.inspection;
    if (inspection && (entry.boundSourceId !== inspection.sourceId || entry.result.sha256 !== inspection.sha256
        || entry.source.size !== inspection.byteSize || inspection.dialect.delimiter !== entry.delimiter
        || inspection.dialect.quoteChar !== entry.quoteChar)) throw new Error('scan_source_changed_or_unverified');
};
