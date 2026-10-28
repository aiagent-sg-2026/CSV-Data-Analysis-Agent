import type { DatasetCommitMarker } from '../../types/datasetCommit';
import type { DatasetRecoveryMaterial } from './datasetRecoveryContract';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { sha256Bytes } from './sourceDigest';
import { openAcceptedSpill, type AcceptedSpillStorage } from './acceptedSpill';
import { validateRecoveryMaterial } from './datasetRecovery';

// This is deliberately a small complete-envelope contract, not streamed multi-table storage.
export const ACCEPTED_DUAL_BYTES = 8 * 1024 * 1024;
export interface AcceptedDualGrain {
    version: 1; kind: 'accepted-dual-grain'; generation: string; bytes: number; sha256: string;
    candidateId: string; validationDigest: string; recoveryDigest: string; bundleDigest: string; digest: string;
}
export const planAcceptedDual = async (marker: DatasetCommitMarker, material: DatasetRecoveryMaterial): Promise<AcceptedDualGrain> => {
    await validateRecoveryMaterial(marker, material);
    const bytes = new TextEncoder().encode(JSON.stringify(material));
    if (bytes.length > ACCEPTED_DUAL_BYTES) throw new Error('accepted_dual_capacity');
    const body = { version: 1 as const, kind: 'accepted-dual-grain' as const, generation: crypto.randomUUID(), bytes: bytes.length,
        sha256: await sha256Bytes(bytes), candidateId: marker.candidateId, validationDigest: marker.validation.receiptDigest,
        recoveryDigest: marker.replayManifest!.digest, bundleDigest: await codeDigest(marker.bundle) };
    return { ...body, digest: await codeDigest(body) };
};
export const verifyAcceptedDualMarker = async (marker: DatasetCommitMarker, proposal = false) => {
    const m = marker.acceptedDualGrain;
    if (!m) throw new Error('accepted_dual_manifest_missing');
    const { digest, ...body } = m;
    const { receiptDigest, ...receipt } = marker.validation;
    if (m.version !== 1 || m.kind !== 'accepted-dual-grain' || marker.activationFailed || marker.bundle.tables.length !== 2
        || !marker.replayManifest?.validationBinding.contract.completeSourceCells || !marker.replayManifest.validationBinding.inference
        || m.bytes < 1 || m.bytes > ACCEPTED_DUAL_BYTES || !Number.isSafeInteger(m.bytes)
        || await codeDigest(body) !== digest || await codeDigest(marker.bundle) !== m.bundleDigest
        || m.candidateId !== marker.candidateId || m.validationDigest !== receiptDigest || await codeDigest(receipt) !== receiptDigest
        || m.recoveryDigest !== marker.replayManifest.digest || marker.validation.decision !== 'validated'
        || !proposal && (!marker.approval.approvalId || marker.approval.approvedAt <= 0
            || marker.approval.consumedAt < marker.approval.approvedAt || marker.approval.consumedAt >= marker.approval.expiresAt)) throw new Error('accepted_dual_marker_mismatch');
    return m;
};
export const readAcceptedDual = async (marker: DatasetCommitMarker, current: () => void, storage: AcceptedSpillStorage = openAcceptedSpill, proposal = false) => {
    const m = await verifyAcceptedDualMarker(marker, proposal); current();
    const dir = await storage(m.generation, false, current); current();
    if (await dir.manifest() !== JSON.stringify(m)) throw new Error('accepted_dual_manifest_corrupt'); current();
    const file = await dir.file(); current();
    if (file.size !== m.bytes) throw new Error('accepted_dual_content_corrupt');
    const bytes = new Uint8Array(await file.arrayBuffer()); current();
    if (await sha256Bytes(bytes) !== m.sha256) throw new Error('accepted_dual_content_corrupt'); current();
    const material = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as DatasetRecoveryMaterial;
    const result = await validateRecoveryMaterial(marker, material); current();
    return result;
};
export const writeAcceptedDual = async (marker: DatasetCommitMarker, material: DatasetRecoveryMaterial, current: () => void, storage: AcceptedSpillStorage = openAcceptedSpill) => {
    const m = await verifyAcceptedDualMarker(marker, true); current();
    const dir = await storage(m.generation, true, current);
    try {
        await dir.writeCsv((async function* () { yield JSON.stringify(material); })(), current); current();
        await dir.seal(JSON.stringify(m), current); current();
        await readAcceptedDual(marker, current, storage, true); current();
        return dir;
    } catch (e) { await dir.remove().catch(() => {}); throw e; }
};
