import { sha256Bytes } from './sourceDigest';
import { openCandidateSpillDirectory } from './opfsDatasetStorage';

export const SPILL_LIMITS = Object.freeze({ chunkBytes: 256 * 1024, totalBytes: 256 * 1024 * 1024, chunks: 10000 });
export const spillBytes = (text: string) => new TextEncoder().encode(text).byteLength;
export const spillDigest = (text: string) => sha256Bytes(new TextEncoder().encode(text));
export interface SpillManifest {
    schemaVersion: 1; kind: 'source-record-spill'; generation: string; identity: string;
    chunks: number; bytes: number; sourceRows: number; sourceBytes: number; chain: string;
    structuralValidation: 'lossless_rectangular_v1'; semanticValidation: 'not_performed'; commitAllowed: false;
}
export interface SpillChunk {
    sequence: number; startRow: number; nextRow: number; startByte: number; endByte: number;
    previous: string; rows: Array<{ sourceRow: number; cells: string[] }>;
}
export interface CandidateSpillIO {
    /** Must be exclusive: a generation/ordinal can never be overwritten. */
    put(name: string, text: string): Promise<void>;
    get(name: string): Promise<string>;
    remove(): Promise<void>;
}
export type CandidateSpillFactory = (sessionId: string, generation: string, current: () => void) => Promise<CandidateSpillIO>;
export const openCandidateSpill: CandidateSpillFactory = async (sessionId, generation, current) => {
    const { directory, remove } = await openCandidateSpillDirectory(sessionId, generation, current);
    return {
        async put(name, text) {
            current();
            try { await directory.getFileHandle(name); throw new Error('spill_immutable_conflict'); }
            catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; }
            current();
            const handle = await directory.getFileHandle(name, { create: true }); current();
            const writable = await handle.createWritable();
            try { current(); await writable.write(text); current(); await writable.close(); }
            catch (error) { await writable.abort().catch(() => {}); throw error; }
        },
        async get(name) {
            current(); const handle = await directory.getFileHandle(name); current();
            const file = await handle.getFile(); current();
            if (file.size > SPILL_LIMITS.chunkBytes) throw new Error('spill_chunk_capacity');
            const text = await file.text(); current(); return text;
        },
        remove,
    };
};

/** Constant-size frontier; chunk references are ordinal filenames, never an in-memory manifest array.
 * Only sealed generations are readable as completed output. An interrupted generation is scratch,
 * not a recovered permission. Writes are serial and immutable; an uncertain write poisons the owner.
 */
export const createCandidateSpill = async (sessionId: string, identity: string, current: () => void,
    factory: CandidateSpillFactory = openCandidateSpill) => {
    current(); const generation = crypto.randomUUID();
    const io = await factory(sessionId, generation, current); current();
    let chunks = 0, bytes = 0, sourceRows = 0, sourceBytes = 0, chain = identity, sealed = false, poisoned = false;
    const own = () => { current(); if (poisoned) throw new Error('spill_poisoned'); };
    return {
        generation,
        async append(chunk: Omit<SpillChunk, 'sequence' | 'previous'>) {
            own(); if (sealed) throw new Error('spill_sealed');
            if (chunk.startRow !== sourceRows || chunk.startByte !== sourceBytes || chunk.nextRow <= sourceRows
                || chunk.endByte <= sourceBytes || chunk.rows.length !== chunk.nextRow - chunk.startRow
                || chunk.rows.some((row, i) => row.sourceRow !== sourceRows + i)) throw new Error('spill_cursor_invalid');
            const text = JSON.stringify({ ...chunk, sequence: chunks, previous: chain });
            const size = spillBytes(text);
            if (size > SPILL_LIMITS.chunkBytes || bytes + size > SPILL_LIMITS.totalBytes || chunks >= SPILL_LIMITS.chunks) throw new Error('spill_capacity');
            const hash = await spillDigest(text); own();
            try { await io.put(`chunk-${chunks}.json`, text); }
            catch (error) { poisoned = true; throw error; }
            // Advance even if cancellation occurs after durable close: replay cannot overwrite an ordinal.
            chunks++; bytes += size; sourceRows = chunk.nextRow; sourceBytes = chunk.endByte; chain = hash;
            own(); return size;
        },
        async *read() {
            own(); let previous = identity, row = 0, offset = 0, size = 0;
            const count = chunks, expectedChain = chain;
            for (let sequence = 0; sequence < count; sequence++) {
                const text = await io.get(`chunk-${sequence}.json`); own();
                if (spillBytes(text) > SPILL_LIMITS.chunkBytes) throw new Error('spill_chunk_capacity');
                const hash = await spillDigest(text); own();
                const chunk = JSON.parse(text) as SpillChunk;
                if (chunk.sequence !== sequence || chunk.previous !== previous || chunk.startRow !== row || chunk.startByte !== offset
                    || !Array.isArray(chunk.rows) || chunk.nextRow !== row + chunk.rows.length || chunk.nextRow <= row
                    || chunk.endByte <= offset || chunk.rows.some((r, i) => r.sourceRow !== row + i
                        || !Array.isArray(r.cells) || r.cells.some(c => typeof c !== 'string'))) throw new Error('spill_corrupt');
                previous = hash; row = chunk.nextRow; offset = chunk.endByte; size += spillBytes(text);
                yield chunk; own();
            }
            if (previous !== expectedChain || row !== sourceRows || offset !== sourceBytes || size !== bytes) throw new Error('spill_corrupt');
        },
        async seal(expectedRows: number, expectedBytes: number): Promise<SpillManifest> {
            own(); if (sealed || sourceRows !== expectedRows || sourceBytes !== expectedBytes) throw new Error('spill_incomplete');
            const manifest: SpillManifest = { schemaVersion: 1, kind: 'source-record-spill', generation, identity,
                chunks, bytes, sourceRows, sourceBytes, chain, structuralValidation: 'lossless_rectangular_v1',
                semanticValidation: 'not_performed', commitAllowed: false };
            try { await io.put('manifest.json', JSON.stringify(manifest)); }
            catch (error) { poisoned = true; throw error; }
            sealed = true; own(); return Object.freeze(manifest);
        },
        async verifyManifest(manifest: SpillManifest) {
            own(); const text = await io.get('manifest.json'); own();
            if (!sealed || text !== JSON.stringify(manifest)) throw new Error('spill_manifest_corrupt');
        },
        async dispose() { poisoned = true; await io.remove(); },
    };
};
export type CandidateSpill = Awaited<ReturnType<typeof createCandidateSpill>>;
