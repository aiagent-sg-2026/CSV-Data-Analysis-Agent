import type { StoreApi } from '../types';
import { captureSessionScope, registerSessionResource, rootStore } from '../../session/sessionOwnership';
import { captureSourceRangeFence, createSourceRecordReader, readSourceBytes } from '../../data/immutableCsvSource';
import { createCandidateSpill, spillBytes, spillDigest, type CandidateSpillFactory, type SpillManifest } from '../../data/candidateSpill';
import type { GuestOutcome } from '../../sandbox/javascriptGuestProtocol';
import { serializeCodeState } from './codeStatefulStream';

export const SOURCE_STREAM_LIMITS = Object.freeze({ batchRows: 50, steps: 10000, activeMs: 15 * 60 * 1000,
    batchJsonBytes: 256 * 1024, cumulativeReadBytes: 600 * 1024 * 1024, sources: 128, attempts: 3 });
export interface SourceStreamBudget { attempts:number;steps:number;activeMs:number;readBytes:number }
interface Ledger extends SourceStreamBudget { owner: symbol; meaningAttempts?: number }
const ledgers = new WeakMap<ReturnType<typeof captureSessionScope>, Map<string, Ledger>>();
export interface SourceStreamOptions { sourceId: string; sha256: string; width: number; initialState: unknown }
export interface SourceStreamMetrics {
    batches: number; peakSourceRecords: number; peakSourceJsonBytes: number; peakInputJsonBytes: number;
    peakOutputJsonBytes: number; peakSpillChunkBytes: number; peakStateBytes: number; validatedRows: number;
    physicalReadBytes: number; physicalReadCalls: number; cumulativePhysicalReadBytes: number; peakReaderRetainedBytes: number;
}

/** Recovery installs only conservative consumed-budget floors, never an owner/grant/frontier. */
export const seedRecoveredSourceStreamBudget=(store:StoreApi,source:NonNullable<ReturnType<StoreApi['getState']>['datasetBundle']>['source']['inspection']&{},budget:SourceStreamBudget)=>{
    const scope=captureSessionScope(store),key=JSON.stringify([source.sha256,source.byteSize,source.recordCount,source.dialect]);
    if(JSON.stringify(store.getState().datasetBundle?.source.inspection)!==JSON.stringify(source)
        ||Object.values(budget).some(v=>!Number.isSafeInteger(v)||v<0)||budget.attempts>=SOURCE_STREAM_LIMITS.attempts
        ||budget.steps>=SOURCE_STREAM_LIMITS.steps||budget.activeMs>=SOURCE_STREAM_LIMITS.activeMs||budget.readBytes>SOURCE_STREAM_LIMITS.cumulativeReadBytes)throw new Error('source_stream_budget_exhausted');
    let map=ledgers.get(scope);if(!map){map=new Map();ledgers.set(scope,map);registerSessionResource(scope,()=>{map!.clear();ledgers.delete(scope);});}
    const prior=map.get(key);
    if(!prior&&map.size>=SOURCE_STREAM_LIMITS.sources)throw new Error('source_stream_ledger_capacity');
    map.set(key,{owner:Symbol(),meaningAttempts:prior?.meaningAttempts??0,attempts:Math.max(prior?.attempts??0,budget.attempts),steps:Math.max(prior?.steps??0,budget.steps),
        activeMs:Math.max(prior?.activeMs??0,budget.activeMs),readBytes:Math.max(prior?.readBytes??0,budget.readBytes)});
};

/** Public-tool compilation uses the execution ledger, not a resettable per-proposal allowance. */
export const inspectSourceMeaning = async (store: StoreApi, current: () => void,
    inspect: (records: Awaited<ReturnType<ReturnType<typeof createSourceRecordReader>['read']>>['records']) => void) => {
    current();
    const source = store.getState().datasetBundle?.source.inspection;
    if (!source || source.recordCount < 2) throw new Error('meaning_source_unavailable');
    if (JSON.stringify(readSourceBytes(store, source.sourceId, 0, 0).source) !== JSON.stringify(source)) throw new Error('source_stream_binding_invalid');
    const scope = captureSessionScope(store), key = JSON.stringify([source.sha256, source.byteSize, source.recordCount, source.dialect]);
    let map = ledgers.get(scope);
    if (!map) { map = new Map(); ledgers.set(scope, map); registerSessionResource(scope, () => { map!.clear(); ledgers.delete(scope); }); }
    let account = map.get(key);
    if (!account) {
        if (map.size >= SOURCE_STREAM_LIMITS.sources) throw new Error('source_stream_ledger_capacity');
        account = { attempts: 0, steps: 0, activeMs: 0, readBytes: 0, owner: Symbol() }; map.set(key, account);
    }
    const ledger = account, owner = ledger.owner, started = Date.now();
    if ((ledger.meaningAttempts ?? 0) >= SOURCE_STREAM_LIMITS.attempts) throw new Error('source_stream_meaning_attempts_exhausted');
    ledger.meaningAttempts = (ledger.meaningAttempts ?? 0) + 1;
    const check = () => {
        current();
        if (ledger.owner !== owner) throw new Error('source_stream_stale');
        if (ledger.activeMs + Date.now() - started >= SOURCE_STREAM_LIMITS.activeMs || ledger.steps >= SOURCE_STREAM_LIMITS.steps) throw new Error('source_stream_budget_exhausted');
    };
    const reader = createSourceRecordReader(store, source.sourceId, check, bytes => {
        check();
        if (ledger.readBytes + bytes > SOURCE_STREAM_LIMITS.cumulativeReadBytes) throw new Error('source_stream_budget_exhausted');
        ledger.readBytes += bytes;
    });
    let next = 0;
    try {
        while (next < source.recordCount) {
            check(); ledger.steps++;
            const batch = await reader.read(SOURCE_STREAM_LIMITS.batchRows); check();
            if (batch.startRow !== next || !batch.records.length) throw new Error('source_stream_no_progress');
            inspect(batch.records); next = batch.nextRow; reader.commit();
        }
        check();
        if (next !== source.recordCount) throw new Error('source_stream_incomplete');
    } finally { ledger.activeMs += Date.now() - started; }
};

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
    const initialState = serializeCodeState(options.initialState);
    const scope = captureSessionScope(store), fence = captureSourceRangeFence(store, source.sourceId);
    const detachedFence=captureSourceRangeFence(rootStore(store),source.sourceId);
    let sourceFence=fence;
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
        assertInvocation(); sourceFence();
        if (account.owner !== owner || JSON.stringify(store.getState().datasetBundle?.source.inspection) !== signature) throw new Error('source_stream_stale');
        if (account.activeMs + (activeStarted === undefined ? 0 : Date.now() - activeStarted) >= SOURCE_STREAM_LIMITS.activeMs || account.readBytes > SOURCE_STREAM_LIMITS.cumulativeReadBytes
            || account.steps >= SOURCE_STREAM_LIMITS.steps) throw new Error('source_stream_budget_exhausted');
    };
    let nextRow = 0, nextByte = 0, state = initialState, failed = false, busy = false, batchAttempts = 0, validationAttempts = 0;
    let manifest: SpillManifest | undefined;
    let semanticAttempts = 0;
    const metrics: SourceStreamMetrics = { batches: 0, peakSourceRecords: 0, peakSourceJsonBytes: 0, peakInputJsonBytes: 0,
        peakOutputJsonBytes: 0, peakSpillChunkBytes: 0, peakStateBytes: spillBytes(state), validatedRows: 0,
        physicalReadBytes: 0, physicalReadCalls: 0, cumulativePhysicalReadBytes: account.readBytes, peakReaderRetainedBytes: 0 };
    const charge = (bytes: number) => {
        check();
        if (account.readBytes + bytes > SOURCE_STREAM_LIMITS.cumulativeReadBytes) throw new Error('source_stream_budget_exhausted');
        account.readBytes += bytes; metrics.physicalReadBytes += bytes; metrics.physicalReadCalls++;
    };
    const executionReader = createSourceRecordReader(store, source.sourceId, check, charge);
    let validationReader = createSourceRecordReader(store, source.sourceId, check, charge);
    const read = async (reader: typeof executionReader, row: number, count: number) => {
        check();
        let batch;
        try { batch = await reader.read(count); }
        finally { metrics.peakReaderRetainedBytes = Math.max(metrics.peakReaderRetainedBytes, reader.retainedBytes); }
        check();
        const size = spillBytes(JSON.stringify(batch));
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
    const spill = await createCandidateSpill(scope.sessionId, identity, check, factory);
    const dispose = () => spill.dispose();
    try {
        check();
        registerSessionResource(scope, () => { failed = true; void dispose().catch(() => {}); });
    } catch (error) { await dispose().catch(() => {}); throw error; }
    return {
        identity, generation: spill.generation,
        get budget():SourceStreamBudget{return {attempts:account.attempts,steps:account.steps,activeMs:account.activeMs,readBytes:account.readBytes};},
        get cursor() { return Object.freeze({ nextRow, nextByte }); },
        get metrics() { return structuredClone({ ...metrics, cumulativePhysicalReadBytes: account.readBytes }); },
        async execute(run: (json: string) => Promise<GuestOutcome>, invocation: () => void): Promise<SpillManifest> {
            if (failed || busy) throw new Error('source_stream_unavailable');
            assertInvocation = invocation; sourceFence=fence; busy = true;
            const started = Date.now(); activeStarted = started; let writing = false;
            try {
                check();
                if (manifest) {
                    await spill.verifyManifest(manifest); check();
                    validationReader = createSourceRecordReader(store, source.sourceId, check, charge); metrics.validatedRows = 0;
                }
                while (nextRow < source.recordCount) {
                    check(); if (Date.now() - started + account.activeMs >= SOURCE_STREAM_LIMITS.activeMs) throw new Error('source_stream_budget_exhausted');
                    if (batchAttempts >= SOURCE_STREAM_LIMITS.attempts) throw new Error('source_stream_no_progress_exhausted');
                    batchAttempts++; account.steps++;
                    const batch = await read(executionReader, nextRow, SOURCE_STREAM_LIMITS.batchRows);
                    if (batch.records[0].byteStart !== nextByte) throw new Error('source_stream_cursor_invalid');
                    const json = JSON.stringify({ source: { sha256: source.sha256, dialect: source.dialect },
                        records: batch.records.map(record => ({ sourceRow: record.row, cells: record.cells.map(cell => cell.value) })),
                        stream: { startRow: nextRow, nextRow: batch.nextRow, final: batch.complete, state: JSON.parse(state) } });
                    metrics.peakInputJsonBytes = Math.max(metrics.peakInputJsonBytes, spillBytes(json));
                    if (spillBytes(json) > SOURCE_STREAM_LIMITS.batchJsonBytes) throw new Error('source_stream_input_capacity');
                    check();
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
                    writing = true; const chunkBytes = await spill.append(chunk); check();
                    metrics.peakSpillChunkBytes = Math.max(metrics.peakSpillChunkBytes, chunkBytes);
                    nextRow = chunk.nextRow; nextByte = chunk.endByte; state = nextState; batchAttempts = 0; executionReader.commit(); writing = false;
                    metrics.peakStateBytes = Math.max(metrics.peakStateBytes, spillBytes(state)); metrics.batches++;
                }
                if (nextByte !== source.byteSize) throw new Error('source_stream_incomplete');
                const iterator = spill.read();
                let validationAttemptCharged = false;
                while (true) {
                    if (!validationAttemptCharged) {
                        if (validationAttempts >= SOURCE_STREAM_LIMITS.attempts) throw new Error('source_stream_no_progress_exhausted');
                        validationAttempts++; validationAttemptCharged = true;
                    }
                    account.steps++; check();
                    const item = await iterator.next(); check();
                    if (item.done === true) { validationAttempts = 0; break; }
                    const chunk = item.value;
                    // On resume the chain is reverified, but acknowledged original records are not reread.
                    if (chunk.nextRow <= metrics.validatedRows) continue;
                    const batch = await read(validationReader, chunk.startRow, chunk.rows.length);
                    if (batch.nextRow !== chunk.nextRow || batch.records[0].byteStart !== chunk.startByte
                        || batch.records.at(-1)!.byteEnd !== chunk.endByte) throw new Error('source_stream_lineage_invalid');
                    validateRows(chunk.rows, batch.records); metrics.validatedRows += chunk.rows.length;
                    validationReader.commit(); validationAttempts = 0; validationAttemptCharged = false;
                }
                check(); if (metrics.validatedRows !== source.recordCount) throw new Error('source_stream_incomplete');
                if (!manifest) { writing = true; manifest = await spill.seal(source.recordCount, source.byteSize); check(); writing = false; }
                check(); return manifest;
            } catch (error) {
                // Only a pre-write cancellation may reuse the private exact frontier. Unknown persistence
                // outcome, stale source/program, validation failure or budget exhaustion cannot resume.
                const reason = error instanceof Error ? error.message : '';
                if (writing || reason !== 'scope_revoked') { failed = true; await dispose().catch(() => {}); }
                throw error;
            } finally { account.activeMs += Date.now() - started; activeStarted = undefined; busy = false; }
        },
        /** Additional independently metered source pass for host semantic validation. */
        async *inspectRows(invocation: () => void) {
            if (failed || busy || !manifest) throw new Error('source_stream_unavailable');
            if (semanticAttempts >= SOURCE_STREAM_LIMITS.attempts) throw new Error('source_stream_attempts_exhausted');
            semanticAttempts++; assertInvocation = invocation; sourceFence=fence; busy = true; const started = Date.now(); activeStarted = started;
            try {
                check(); await spill.verifyManifest(manifest); check();
                const reader = createSourceRecordReader(store, source.sourceId, check, charge);
                for await (const chunk of spill.read()) {
                    account.steps++; check();
                    const batch = await read(reader, chunk.startRow, chunk.rows.length);
                    if (batch.nextRow !== chunk.nextRow || batch.records[0].byteStart !== chunk.startByte
                        || batch.records.at(-1)!.byteEnd !== chunk.endByte) throw new Error('source_stream_lineage_invalid');
                    validateRows(chunk.rows, batch.records);
                    yield { chunk, records: batch.records }; check(); reader.commit();
                }
                check();
            } finally { account.activeMs += Date.now() - started; activeStarted = undefined; busy = false; }
        },
        async readChunk(sequence: number, invocation: () => void, detached=false) {
            if (failed || busy || !manifest) throw new Error('source_stream_unavailable');
            assertInvocation = invocation; sourceFence=detached?detachedFence:fence; busy = true;
            try { account.steps++; check(); await spill.verifyManifest(manifest); check(); const chunk = await spill.readChunk(sequence); check(); return chunk; }
            finally { busy = false; }
        },
        dispose,
    };
};
export type SourceRecordStream = Awaited<ReturnType<typeof createSourceRecordStream>>;
