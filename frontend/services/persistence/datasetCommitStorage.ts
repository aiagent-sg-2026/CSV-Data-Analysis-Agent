import type { Report } from '../../types';
import { DATASET_COMMITS_STORE, commitHeadKey, commitIntentKey, validCommitKey,
    type DatasetCommitMarker, type DatasetCommitHead } from '../../types/datasetCommit';
import { CURRENT_SESSION_KEY, type StorageDatabase } from '../storageService';
import { datasetCommitBindings, projectCommittedReport } from './datasetCommitProjection';
import { toSerializable } from '../../utils/serializable';

export const readCommitIntent = async (db: StorageDatabase, sessionId: string, key: string): Promise<DatasetCommitMarker | undefined> => {
    if (!validCommitKey(key)) throw new Error('idempotency_key_invalid');
    const record = await db.get(DATASET_COMMITS_STORE, commitIntentKey(sessionId, key));
    if (record && record.kind !== 'commit') throw new Error('commit_marker_invalid');
    return record?.kind === 'commit' ? record : undefined;
};

/** The transaction owns CAS, uniqueness and approval consumption. No external awaits enter it. */
export const commitDatasetTransaction = async (db: StorageDatabase, marker: DatasetCommitMarker, baseline: Report,
    assertAdmission: () => void, onAdmitted?: () => void): Promise<{ marker: DatasetCommitMarker; replay: boolean }> => {
    if (!validCommitKey(marker.idempotencyKey) || marker.recordId !== commitIntentKey(marker.sessionId, marker.idempotencyKey)
        || marker.intentKey !== marker.recordId || !/^[a-f0-9]{64}$/.test(marker.payloadDigest)) throw new Error('idempotency_key_invalid');
    assertAdmission();
    const tx = db.transaction([DATASET_COMMITS_STORE, 'reports'], 'readwrite', { durability: 'strict' });
    void tx.done.catch(() => undefined);
    try {
        // Admission freezes this attempt. Normal Stop/switch cannot retract a local transaction.
        onAdmitted?.();
        const commits = tx.objectStore(DATASET_COMMITS_STORE), reports = tx.objectStore('reports');
        const existing = await commits.get(marker.recordId);
        if (existing) {
            if (existing.kind !== 'commit' || existing.payloadDigest !== marker.payloadDigest) throw new Error('idempotency_conflict');
            await tx.done;
            return { marker: existing, replay: true };
        }
        const head = await commits.get(commitHeadKey(marker.sessionId));
        if (head && head.kind !== 'head') throw new Error('commit_marker_invalid');
        if ((head?.commitId ?? null) !== marker.parentCommitId || (head?.revision ?? 0) + 1 !== marker.revision) throw new Error('input_version_changed');
        const previous = await reports.get(marker.sessionId);
        const accepted = head?.kind === 'head' ? await commits.get(head.markerKey) : undefined;
        if (head && (!accepted || accepted.kind !== 'commit' || accepted.commitId !== head.commitId)) throw new Error('commit_marker_invalid');
        const input = accepted?.kind === 'commit' ? accepted.bundle : previous?.appState.datasetBundle ?? baseline.appState.datasetBundle;
        if (!input || JSON.stringify(datasetCommitBindings(input)) !== JSON.stringify(marker.inputBindings)) throw new Error('input_version_changed');
        if (await commits.index('approvalKey').get(marker.approvalKey)) throw new Error('approval_consumed');
        await commits.add(toSerializable(marker));
        const next: DatasetCommitHead = {kind:'head',recordId:commitHeadKey(marker.sessionId),sessionId:marker.sessionId,
            commitId:marker.commitId,revision:marker.revision,markerKey:marker.recordId};
        await commits.put(next);
        const projected = projectCommittedReport(previous ?? baseline, marker);
        await reports.put(toSerializable({...projected,id:marker.sessionId}));
        const alias = await reports.get(CURRENT_SESSION_KEY);
        // Another session's alias cannot be acquired by a late acknowledgement.
        if (!alias || alias.appState.sessionId === marker.sessionId) await reports.put(toSerializable({...projected,id:CURRENT_SESSION_KEY}));
        await tx.done;
        return {marker,replay:false};
    } catch (error) {
        try { tx.abort(); } catch { /* Reconciliation below distinguishes a lost acknowledgement. */ }
        await tx.done.catch(() => undefined);
        throw error;
    }
};
