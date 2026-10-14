import type { StorageDatabase } from '../storageService';
import type { DatasetCommitMarker } from '../../types/datasetCommit';
import { DATASET_COMMITS_STORE } from '../../types/datasetCommit';
import { DATASET_RETENTION_STORE, RETENTION_POLICY, type DatasetRetainedArtifact, type DatasetRecoveryMaterial } from '../data/datasetRecoveryContract';
import { sha256Bytes } from '../data/sourceDigest';
import { validateRecoveryMaterial } from '../data/datasetRecovery';

export const RETAINED_DATA_ROOT = 'csv-analysis-agent-retained-v1';
const readPins = new Map<string, number>();
const encode = (text: string) => new TextEncoder().encode(text);
export type RetentionDirectory = Pick<FileSystemDirectoryHandle, 'getDirectoryHandle' | 'getFileHandle' | 'removeEntry'>;
const storageRoot = async (): Promise<RetentionDirectory> => {
    if (!navigator.storage?.getDirectory) throw new Error('retention_storage_unavailable');
    return navigator.storage.getDirectory();
};
const directory = async (root: RetentionDirectory, record: DatasetRetainedArtifact, create: boolean) => {
    if (!/^retained-[a-f0-9-]{36}$/.test(record.recordId)) throw new Error('retention_record_invalid');
    const owned = await (await root.getDirectoryHandle(RETAINED_DATA_ROOT, { create })).getDirectoryHandle(await sha256Bytes(encode(record.sessionId)), { create });
    return owned.getDirectoryHandle(record.recordId, { create });
};
const markerMatches = (marker: DatasetCommitMarker, record: DatasetRetainedArtifact) => record.sessionId === marker.sessionId
    && record.commitId === marker.commitId && record.manifestDigest === marker.replayManifest?.digest;

/** Explicit consent is provided by the host UI caller, never a model argument or saved setting. */
export const retainDatasetRows = async (db: StorageDatabase, marker: DatasetCommitMarker, material: DatasetRecoveryMaterial,
    assertCurrent: () => void, root: () => Promise<RetentionDirectory> = storageRoot): Promise<DatasetRetainedArtifact> => {
    assertCurrent(); await validateRecoveryMaterial(marker, material); assertCurrent();
    const previous=await db.getAllFromIndex(DATASET_RETENTION_STORE,'commitId',marker.commitId);assertCurrent();
    const reusable=previous.find(r=>r.status==='ready'&&markerMatches(marker,r));
    if(reusable){
        try{await readRetainedRows(db,marker,root);assertCurrent();const renewed={...reusable,expiresAt:Date.now()+RETENTION_POLICY.lifetimeMs};
            await db.put(DATASET_RETENTION_STORE,renewed);return renewed;}
        catch(error){if(!(error instanceof Error)||error.message!=='retention_rows_unavailable')throw error;
            assertCurrent();await db.put(DATASET_RETENTION_STORE,{...reusable,status:'writing',expiresAt:Date.now()});
            await collectRetainedRows(db,marker.sessionId,Date.now(),root);assertCurrent();}
    }
    const bytes = encode(JSON.stringify(material));
    if (bytes.length > RETENTION_POLICY.artifactBytes) throw new Error('retention_artifact_quota');
    const now = Date.now(), record: DatasetRetainedArtifact = { recordId: `retained-${crypto.randomUUID()}`, sessionId: marker.sessionId,
        commitId: marker.commitId, manifestDigest: marker.replayManifest!.digest, byteSize: bytes.length, sha256: await sha256Bytes(bytes),
        chunks: Math.ceil(bytes.length / RETENTION_POLICY.chunkBytes), createdAt: now, expiresAt: now + RETENTION_POLICY.lifetimeMs, status: 'writing' };
    assertCurrent();
    const tx = db.transaction([DATASET_RETENTION_STORE, DATASET_COMMITS_STORE], 'readwrite', { durability: 'strict' });
    void tx.done.catch(() => undefined);
    try {
        const stored = await tx.objectStore(DATASET_COMMITS_STORE).get(marker.recordId);
        if (stored?.kind !== 'commit' || stored.payloadDigest !== marker.payloadDigest) throw new Error('retention_commit_unavailable');
        const records = await tx.objectStore(DATASET_RETENTION_STORE).getAll();
        if (records.filter(r => r.status !== 'deleted').reduce((n, r) => n + r.byteSize, 0) + bytes.length > RETENTION_POLICY.totalBytes) throw new Error('retention_total_quota');
        assertCurrent(); await tx.objectStore(DATASET_RETENTION_STORE).add(record); await tx.done;
    } catch (error) { try { tx.abort(); } catch { /* Already complete. */ } await tx.done.catch(() => undefined); throw error; }
    let folder: FileSystemDirectoryHandle | undefined;
    try {
        assertCurrent(); const opfs = await root(); assertCurrent(); folder = await directory(opfs, record, true); assertCurrent();
        for (let i = 0; i < record.chunks; i++) {
            assertCurrent(); const file = await folder.getFileHandle(`chunk-${i}`, { create: true }); assertCurrent();
            const writer = await file.createWritable();
            try { assertCurrent(); await writer.write(bytes.slice(i * RETENTION_POLICY.chunkBytes, (i + 1) * RETENTION_POLICY.chunkBytes)); await writer.close(); }
            catch (error) { await writer.abort().catch(() => undefined); throw error; }
        }
        const verified = await readArtifactBytes(folder, record); assertCurrent();
        if (await sha256Bytes(verified) !== record.sha256) throw new Error('retention_digest_mismatch'); assertCurrent();
        const ready = { ...record, status: 'ready' as const };
        await db.put(DATASET_RETENTION_STORE, ready); return ready;
    } catch (error) {
        // A writing descriptor is harmless. Captured namespace cleanup cannot touch a new session.
        try { const opfs = await root(), owned = await (await opfs.getDirectoryHandle(RETAINED_DATA_ROOT)).getDirectoryHandle(await sha256Bytes(encode(record.sessionId)));
            await owned.removeEntry(record.recordId, { recursive: true }); await db.put(DATASET_RETENTION_STORE, { ...record, status: 'deleted' }); } catch { /* GC can retry this incomplete reservation. */ }
        throw error;
    }
};
const readArtifactBytes = async (folder: FileSystemDirectoryHandle, record: DatasetRetainedArtifact): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(record.byteSize) || record.byteSize < 1 || record.byteSize > RETENTION_POLICY.artifactBytes
        || record.chunks !== Math.ceil(record.byteSize / RETENTION_POLICY.chunkBytes)) throw new Error('retention_record_invalid');
    const bytes = new Uint8Array(record.byteSize); let offset = 0;
    for (let i = 0; i < record.chunks; i++) {
        const part = new Uint8Array(await (await (await folder.getFileHandle(`chunk-${i}`)).getFile()).arrayBuffer());
        if (part.length !== Math.min(RETENTION_POLICY.chunkBytes, record.byteSize - offset)) throw new Error('retention_chunk_invalid');
        bytes.set(part, offset); offset += part.length;
    }
    if (await sha256Bytes(bytes) !== record.sha256) throw new Error('retention_digest_mismatch'); return bytes;
};

export const readRetainedRows = async (db: StorageDatabase, marker: DatasetCommitMarker,
    root: () => Promise<RetentionDirectory> = storageRoot): Promise<DatasetRecoveryMaterial | undefined> => {
    // The read pin is acquired before any await and checked inside the GC transaction.
    const pin = JSON.stringify([marker.sessionId, marker.commitId]); readPins.set(pin, (readPins.get(pin) ?? 0) + 1);
    try {
        const records = await db.getAllFromIndex(DATASET_RETENTION_STORE, 'commitId', marker.commitId);
        const ready = records.filter(r => r.status === 'ready' && markerMatches(marker, r)).sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!ready) return undefined;
        try {
            const bytes = await readArtifactBytes(await directory(await root(), ready, false), ready);
            const material = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as DatasetRecoveryMaterial;
            await validateRecoveryMaterial(marker, material); return material;
        } catch { throw new Error('retention_rows_unavailable'); }
    } finally { const count = (readPins.get(pin) ?? 1) - 1; if (count) readPins.set(pin, count); else readPins.delete(pin); }
};

/** An expiry permits collection only after every durable reference has gone away. */
export const collectRetainedRows = async (db: StorageDatabase, outgoingSessionId: string, now = Date.now(),
    root: () => Promise<RetentionDirectory> = storageRoot): Promise<number> => {
    const candidates = await db.getAllFromIndex(DATASET_RETENTION_STORE, 'sessionId', outgoingSessionId); let removed = 0;
    for (const candidate of candidates) {
        if (candidate.status === 'deleted' || candidate.expiresAt > now) continue;
        const tx = db.transaction([DATASET_RETENTION_STORE, DATASET_COMMITS_STORE, 'reports'], 'readwrite');
        void tx.done.catch(() => undefined); let admitted = false;
        try {
            const current = await tx.objectStore(DATASET_RETENTION_STORE).get(candidate.recordId);
            const commits = await tx.objectStore(DATASET_COMMITS_STORE).getAll(), reports = await tx.objectStore('reports').getAll();
            const roots = new Set(commits.filter(c => c.kind === 'head').map(c => c.commitId));
            for (const r of reports) if (r.appState.datasetBundle?.acceptedCommit) roots.add(r.appState.datasetBundle.acceptedCommit.commitId);
            // Parent/rollback replay chains are references too. Preserve their input artifacts.
            let changed = true;
            while (changed) { changed = false; for (const c of commits) if (c.kind === 'commit' && roots.has(c.commitId)) {
                for (const ref of [c.replayManifest?.parent, c.rollbackTarget, c.previousCommit]) if (ref && !roots.has(ref.commitId)) { roots.add(ref.commitId); changed = true; }
            } }
            const pinned = readPins.has(JSON.stringify([outgoingSessionId, candidate.commitId]));
            if (current && current.sessionId === outgoingSessionId && current.status !== 'deleted' && current.expiresAt <= now
                && !pinned && (current.status==='writing'||!roots.has(current.commitId))) { await tx.objectStore(DATASET_RETENTION_STORE).put({ ...current, status: 'deleting' }); admitted = true; }
            await tx.done;
        } catch (error) { try { tx.abort(); } catch { /* Already complete. */ } await tx.done.catch(() => undefined); throw error; }
        if (!admitted) continue;
        try {
            const opfs = await root(), owned = await (await opfs.getDirectoryHandle(RETAINED_DATA_ROOT)).getDirectoryHandle(await sha256Bytes(encode(outgoingSessionId)));
            await owned.removeEntry(candidate.recordId, { recursive: true });
        } catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') continue; }
        await db.put(DATASET_RETENTION_STORE, { ...candidate, status: 'deleted' }); removed++;
    }
    return removed;
};
export const clearAllRetainedDatasetRows = async (): Promise<boolean> => {
    if(!navigator.storage?.getDirectory)return false;
    try { await (await storageRoot()).removeEntry(RETAINED_DATA_ROOT, { recursive: true }); return true; }
    catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; return false; }
};
