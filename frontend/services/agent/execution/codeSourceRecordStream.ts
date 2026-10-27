import type { StoreApi } from '../types';
import { captureSessionScope, registerSessionResource } from '../../session/sessionOwnership';
import { captureSourceRangeFence, readSourceBytes, readSourceRecordsBounded } from '../../data/immutableCsvSource';
import { createCandidateSpill, spillBytes, spillDigest, type CandidateSpillFactory, type SpillManifest } from '../../data/candidateSpill';
import type { GuestOutcome } from '../../sandbox/javascriptGuestProtocol';
import { serializeCodeState } from './codeStatefulStream';

export const SOURCE_STREAM_LIMITS = Object.freeze({ batchRows: 50, steps: 10000, activeMs: 15 * 60 * 1000,
    batchJsonBytes: 256 * 1024, cumulativeReadBytes: 600 * 1024 * 1024, sources: 128, attempts: 3 });
interface Ledger { attempts: number; steps: number; activeMs: number; readBytes: number; owner: symbol }
const ledgers = new WeakMap<ReturnType<typeof captureSessionScope>, Map<string, Ledger>>();
export interface SourceStreamOptions { sourceId: string; sha256: string; width: number; initialState: unknown }
export interface SourceStreamMetrics {
    batches: number; peakSourceRecords: number; peakSourceJsonBytes: number; peakInputJsonBytes: number;
    peakOutputJsonBytes: number; peakSpillChunkBytes: number; peakStateBytes: number; validatedRows: number;
}

/** Host-only continuation. Neither a guest cursor nor a saved manifest can instantiate this owner.
 * Restricted first contract: one ordered output row per original record, same physical cells;
 * only absent/empty trailing cells may be padded/dropped to the proposed rectangular width.
 * This proves structural losslessness, NOT table roles, business meaning or commit eligibility.
 */
export const createSourceRecordStream = async (store: StoreApi, options: SourceStreamOptions, identityValue: unknown,
    current: () => void, factory?: CandidateSpillFactory) => {
    current();
    const source = store.getState().datasetBundle?.source.inspection;
    if (!source || source.sourceId !== options.sourceId || source.sha256 !== options.sha256
        || !Number.isSafeInteger(options.width) || options.width < 1 || options.width > 256
        || source.diagnostics.some(d => ['invalid_utf8', 'unclosed_quote'].includes(d))) throw new Error('source_stream_binding_invalid');
    const scope = captureSessionScope(store), fence = captureSourceRangeFence(store, source.sourceId);
    const signature = JSON.stringify(source);
    if (JSON.stringify(readSourceBytes(store, source.sourceId, 0, 0).source) !== signature) throw new Error('source_stream_binding_invalid');
    const identity = await spillDigest(JSON.stringify({ scope, source, identityValue, options })); current(); fence();
    let map = ledgers.get(scope);
    if (!map) { map = new Map(); ledgers.set(scope, map); registerSessionResource(scope, () => { map!.clear(); ledgers.delete(scope); }); }
    const key = JSON.stringify([source.sha256, source.byteSize, source.recordCount, source.dialect]);
    let ledger = map.get(key);
    if (!ledger) {
        if (map.size >= SOURCE_STREAM_LIMITS.sources) throw new Error('source_stream_ledger_capacity');
        ledger = { attempts: 0, steps: 0, activeMs: 0, readBytes: 0, owner: Symbol() }; map.set(key, ledger);
    }
    if (ledger.attempts >= SOURCE_STREAM_LIMITS.attempts) throw new Error('source_stream_attempts_exhausted');
    ledger.attempts++;
    const account = ledger, owner = Symbol(); account.owner = owner;
    let assertInvocation = current, activeStarted: number | undefined;
    const check = () => {
        assertInvocation(); fence();
        if (account.owner !== owner || JSON.stringify(store.getState().datasetBundle?.source.inspection) !== signature) throw new Error('source_stream_stale');
        if (account.activeMs + (activeStarted === undefined ? 0 : Date.now() - activeStarted) >= SOURCE_STREAM_LIMITS.activeMs || account.readBytes > SOURCE_STREAM_LIMITS.cumulativeReadBytes
            || account.steps >= SOURCE_STREAM_LIMITS.steps) throw new Error('source_stream_budget_exhausted');
    };
    const spill = await createCandidateSpill(scope.sessionId, identity, check, factory); check();
    let nextRow = 0, nextByte = 0, state = serializeCodeState(options.initialState), failed = false, busy = false, batchAttempts = 0;
    let manifest: SpillManifest | undefined;
    const metrics: SourceStreamMetrics = { batches: 0, peakSourceRecords: 0, peakSourceJsonBytes: 0, peakInputJsonBytes: 0,
        peakOutputJsonBytes: 0, peakSpillChunkBytes: 0, peakStateBytes: spillBytes(state), validatedRows: 0 };
    const read = async (row: number, count: number) => {
        check(); const batch = await readSourceRecordsBounded(store, source.sourceId, row, count); check();
        const size = spillBytes(JSON.stringify(batch)); account.readBytes += size;
        metrics.peakSourceRecords = Math.max(metrics.peakSourceRecords, batch.records.length);
        metrics.peakSourceJsonBytes = Math.max(metrics.peakSourceJsonBytes, size);
        if (!batch.records.length || batch.startRow !== row || batch.nextRow !== row + batch.records.length || size > 128 * 1024
            || batch.records.some((record, i) => record.row !== row + i || record.diagnostics.length
                || (i && record.byteStart !== batch.records[i - 1].byteEnd))) throw new Error('source_stream_no_progress');
        check(); return batch;
    };
    const validateRows = (rows: Array<{ sourceRow: number; cells: string[] }>, records: Awaited<ReturnType<typeof read>>['records']) => {
        if (rows.length !== records.length) throw new Error('source_stream_lineage_invalid');
        for (let i = 0; i < records.length; i++) {
            const record = records[i], row = rows[i];
            if (!row || Object.keys(row).sort().join('|') !== 'cells|sourceRow' || row.sourceRow !== record.row
                || !Array.isArray(row.cells) || row.cells.length !== options.width
                || row.cells.some((cell, col) => typeof cell !== 'string' || cell !== (record.cells[col]?.value ?? ''))
                || record.cells.slice(options.width).some(cell => cell.value !== '')) throw new Error('source_stream_cell_mismatch');
        }
    };
    const dispose = () => spill.dispose();
    registerSessionResource(scope, () => { failed = true; void dispose().catch(() => {}); });
    return {
        identity, generation: spill.generation,
        get cursor() { return Object.freeze({ nextRow, nextByte }); },
        get metrics() { return structuredClone(metrics); },
        async execute(run: (json: string) => Promise<GuestOutcome>, invocation: () => void): Promise<SpillManifest> {
            if (failed || busy) throw new Error('source_stream_unavailable');
            assertInvocation = invocation; check(); busy = true;
            const started = Date.now(); activeStarted = started; let writing = false;
            try {
                if (manifest) { await spill.verifyManifest(manifest); check(); }
                while (nextRow < source.recordCount) {
                    check(); if (Date.now() - started + account.activeMs >= SOURCE_STREAM_LIMITS.activeMs) throw new Error('source_stream_budget_exhausted');
                    const batch = await read(nextRow, SOURCE_STREAM_LIMITS.batchRows);
                    if (batch.records[0].byteStart !== nextByte) throw new Error('source_stream_cursor_invalid');
                    const json = JSON.stringify({ source: { sha256: source.sha256, dialect: source.dialect },
                        records: batch.records.map(record => ({ sourceRow: record.row, cells: record.cells.map(cell => cell.value) })),
                        stream: { startRow: nextRow, nextRow: batch.nextRow, final: batch.complete, state: JSON.parse(state) } });
                    metrics.peakInputJsonBytes = Math.max(metrics.peakInputJsonBytes, spillBytes(json));
                    if (spillBytes(json) > SOURCE_STREAM_LIMITS.batchJsonBytes) throw new Error('source_stream_input_capacity');
                    if (batchAttempts >= SOURCE_STREAM_LIMITS.attempts) throw new Error('source_stream_no_progress_exhausted');
                    batchAttempts++; account.steps++; check();
                    const result = await run(json); check();
                    if (result.status !== 'completed' || typeof result.outputJson !== 'string') throw new Error(`source_stream_guest_${result.code}`);
                    metrics.peakOutputJsonBytes = Math.max(metrics.peakOutputJsonBytes, spillBytes(result.outputJson));
                    if (spillBytes(result.outputJson) > SOURCE_STREAM_LIMITS.batchJsonBytes) throw new Error('source_stream_output_capacity');
                    const value = JSON.parse(result.outputJson);
                    if (!value || Object.keys(value).sort().join('|') !== 'rows|state' || !Array.isArray(value.rows)) throw new Error('source_stream_output_invalid');
                    const nextState = serializeCodeState(value.state);
                    // Check once before writing, then independently re-read ALL persisted cells below.
                    validateRows(value.rows, batch.records);
                    const chunk = { startRow: nextRow, nextRow: batch.nextRow, startByte: nextByte,
                        endByte: batch.records.at(-1)!.byteEnd, rows: value.rows };
                    writing = true; const chunkBytes = await spill.append(chunk); writing = false; check();
                    metrics.peakSpillChunkBytes = Math.max(metrics.peakSpillChunkBytes, chunkBytes);
                    nextRow = chunk.nextRow; nextByte = chunk.endByte; state = nextState; batchAttempts = 0;
                    metrics.peakStateBytes = Math.max(metrics.peakStateBytes, spillBytes(state)); metrics.batches++;
                }
                if (nextByte !== source.byteSize) throw new Error('source_stream_incomplete');
                metrics.validatedRows = 0;
                for await (const chunk of spill.read()) {
                    const batch = await read(chunk.startRow, chunk.rows.length);
                    if (batch.nextRow !== chunk.nextRow || batch.records[0].byteStart !== chunk.startByte
                        || batch.records.at(-1)!.byteEnd !== chunk.endByte) throw new Error('source_stream_lineage_invalid');
                    validateRows(chunk.rows, batch.records); metrics.validatedRows += chunk.rows.length;
                }
                check(); if (metrics.validatedRows !== source.recordCount) throw new Error('source_stream_incomplete');
                if (!manifest) { writing = true; manifest = await spill.seal(source.recordCount, source.byteSize); writing = false; }
                check(); return manifest;
            } catch (error) {
                // Only a pre-write cancellation may reuse the private exact frontier. Unknown persistence
                // outcome, stale source/program, validation failure or budget exhaustion cannot resume.
                const reason = error instanceof Error ? error.message : '';
                if (writing || reason !== 'scope_revoked') { failed = true; await dispose().catch(() => {}); }
                throw error;
            } finally { account.activeMs += Date.now() - started; activeStarted = undefined; busy = false; }
        },
        dispose,
    };
};
export type SourceRecordStream = Awaited<ReturnType<typeof createSourceRecordStream>>;
