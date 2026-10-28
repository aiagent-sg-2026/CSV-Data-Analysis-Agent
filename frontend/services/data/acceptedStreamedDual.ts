import { Hash } from 'fast-sha256';
import type { CsvData, CsvSourceMetadata } from '../../types';
import type { DatasetCommitMarker } from '../../types/datasetCommit';
import type { StoreApi } from '../agent/types';
import { codeDigest } from '../agent/execution/codeTableInputs';
import { validateCodeRunRequest } from '../agent/execution/codeExecutionContract';
import type { HostCandidateValidationContract } from './candidateValidationBinding';
import { openAcceptedSpill, type AcceptedSpillStorage, type SpillReadCustody } from './acceptedSpill';
import { spillBytes, SPILL_LIMITS } from './candidateSpill';
import { sha256Bytes } from './sourceDigest';
import { dualOrdinal, dualProjectedRow, dualSchema, createDualScan } from './streamedDualGrain';

export interface AcceptedStreamedDual {
    version: 1; kind: 'accepted-streamed-dual'; digest: string; identityDigest: string;
    candidateId: string; changeDigest: string; validationDigest: string; programDigest: string;
    source: CsvSourceMetadata; binding: HostCandidateValidationContract;
    structural: NonNullable<SpillReadCustody['candidate']['streamedDual']>['manifest'];
    tables: Array<{ name: string; generation: string; bytes: number; sha256: string; rowCount: number }>;
}
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const quote = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
async function* tableCsv(custody: SpillReadCustody, ti: number, store: StoreApi, current: () => void) {
    const d = custody.candidate.streamedDual!, spec = d.meaning.proposal.tables[ti];
    let buffer = spec.columns.map(c => quote(c.name)).join(',') + '\n', bytes = spillBytes(buffer);
    for (let sequence = 0; sequence < d.manifest.chunks; sequence++) {
        const chunk = await custody.readChunk(sequence, store, current); current();
        for (const raw of chunk.rows) {
            if (dualOrdinal(spec, raw.sourceRow) < 0) continue;
            for (let pi = 0; pi < spec.projections.length; pi++) {
                const row = dualProjectedRow(d.meaning, ti, pi, raw.sourceRow, raw.cells);
                // Exact conversion already proved base-10 round-trip. Never binary toFixed.
                const text = spec.columns.map(c => row[c.name] === null ? '' : quote(row[c.name])).join(',') + '\n', n = spillBytes(text);
                if (n > SPILL_LIMITS.chunkBytes) throw new Error('accepted_row_capacity');
                if (bytes + n > SPILL_LIMITS.chunkBytes) { yield buffer; buffer = ''; bytes = 0; }
                buffer += text; bytes += n;
            }
        }
    }
    if (buffer) yield buffer;
    current();
}
export const planAcceptedStreamedDual = async (custody: SpillReadCustody, binding: HostCandidateValidationContract, store: StoreApi, current: () => void): Promise<AcceptedStreamedDual> => {
    const c = custody.candidate, tables: AcceptedStreamedDual['tables'] = [];
    if (!binding.streamedDual || JSON.stringify(binding.streamedDual.meaning) !== JSON.stringify(c.streamedDual?.meaning)) throw new Error('accepted_dual_meaning_mismatch');
    let total = 0;
    for (let ti = 0; ti < 2; ti++) {
        const hash = new Hash(); let bytes = 0;
        for await (const part of tableCsv(custody, ti, store, current)) { const b = new TextEncoder().encode(part); hash.update(b); bytes += b.length; if (total + bytes > SPILL_LIMITS.totalBytes) throw new Error('accepted_capacity'); }
        total += bytes;
        tables.push({ name: c.tables[ti].name, generation: crypto.randomUUID(), bytes, sha256: hex(hash.digest()), rowCount: c.tables[ti].rowCount });
    }
    const body = { version: 1 as const, kind: 'accepted-streamed-dual' as const, identityDigest: await codeDigest({ namespace: c.namespaceId, task: c.requestedChange, execution: c.execution, lineage: c.lineageDigest }),
        candidateId: c.candidateId, changeDigest: c.changeDigest, validationDigest: custody.receipt.receiptDigest, programDigest: custody.receipt.programDigest,
        source: structuredClone(store.getState().datasetBundle!.source.inspection!), binding: structuredClone(binding), structural: c.streamedDual!.manifest, tables };
    current(); const digest = await codeDigest(body); current(); return { ...body, digest };
};
export const acceptedStreamedDualCsv = (m: AcceptedStreamedDual): CsvData => ({ fileName: m.source.fileName, data: [], backing: {
    mode: 'duckdb_file', rowCount: m.tables[0].rowCount, sampleRowCount: 0, readOnly: true, ephemeral: false,
    loadVersion: `accepted-${m.digest}`, datasetVersion: `accepted-${m.digest}`, columnNames: m.binding.streamedDual!.meaning.proposal.tables[0].columns.map(c => c.name),
    opfsPath: `csv-analysis-agent-accepted/${m.tables[0].generation}/data.csv`, byteSize: m.tables[0].bytes,
} });
export const verifyStreamedDualMarker = async (marker: DatasetCommitMarker, proposal = false) => {
    const m = marker.acceptedStreamedDual;
    if (!m) throw new Error('accepted_dual_manifest_missing');
    const { digest, ...body } = m, { receiptDigest, ...receipt } = marker.validation, binding = m.binding, meaning = binding.streamedDual?.meaning;
    const request = marker.spillRunRequest;
    if (m.version !== 1 || m.kind !== 'accepted-streamed-dual' || !meaning || marker.activationFailed || marker.rowStorage !== 'durable_spill'
        || !binding.inference || !binding.contract.completeSourceCells || binding.contract.ambiguities.length || !request || !validateCodeRunRequest(request) || request.mode !== 'source_records'
        || request.inputs.length || request.sources?.length || request.tables?.length || request.sourceRecords?.sourceId !== m.source.sourceId
        || request.sourceRecords.sha256 !== m.source.sha256 || request.sourceRecords.width !== meaning.width
        || request.program.path !== marker.program.path || request.program.revision !== marker.program.revision || request.program.sha256 !== marker.program.sha256
        || await codeDigest(body) !== digest || await codeDigest(receipt) !== receiptDigest || await codeDigest(binding) !== marker.validation.contractDigest
        || await codeDigest(meaning) !== binding.streamedDual!.digest || marker.validation.decision !== 'validated'
        || m.candidateId !== marker.candidateId || m.changeDigest !== marker.changeDigest || marker.validation.changeDigest !== m.changeDigest
        || m.validationDigest !== receiptDigest || m.programDigest !== marker.program.sha256 || m.programDigest !== marker.validation.programDigest
        || await codeDigest(marker.environment) !== marker.validation.environmentDigest || await sha256Bytes(new TextEncoder().encode(marker.program.content)) !== m.programDigest
        || JSON.stringify(marker.bundle.source.inspection) !== JSON.stringify(m.source) || marker.bundle.datasetVersion !== `accepted-${digest}`
        || marker.sessionId !== binding.sessionId || marker.audit.sessionEpoch !== binding.sessionEpoch
        || marker.validation.sessionId !== binding.sessionId || marker.validation.sessionEpoch !== binding.sessionEpoch || marker.validation.candidateId !== marker.candidateId
        || JSON.stringify(binding.protectedSource) !== JSON.stringify({sourceId:m.source.sourceId,sha256:m.source.sha256})
        || JSON.stringify(marker.validation.protectedSource) !== JSON.stringify(binding.protectedSource) || JSON.stringify(marker.inputBindings) !== JSON.stringify(binding.inputBindings)
        || marker.audit.taskId !== marker.validation.taskId || marker.audit.taskRevision !== marker.validation.taskRevision
        || marker.bundle.tables.length !== 2 || m.tables.length !== 2 || new Set(m.tables.map(t => t.generation)).size !== 2
        || m.tables.reduce((n, t) => n + t.bytes, 0) > SPILL_LIMITS.totalBytes
        || JSON.stringify(marker.lineage.excludedRows) !== JSON.stringify(meaning.proposal.exclusions.map(e => ({ origin: { kind: 'source', name: 'original', row: e.row }, reason: e.role })))
        || !proposal && (!marker.approval.approvalId || marker.approval.approvedAt <= 0 || marker.approval.consumedAt < marker.approval.approvedAt || marker.approval.consumedAt >= marker.approval.expiresAt)) throw new Error('accepted_dual_marker_mismatch');
    const expected=createDualScan(meaning.proposal, m.source.recordCount).meaning;
    if(expected.width!==meaning.width||JSON.stringify(expected.counts)!==JSON.stringify(meaning.counts))throw new Error('accepted_dual_marker_mismatch');
    const lineage = await codeDigest({ manifest: m.structural, meaningDigest: binding.streamedDual!.digest, excludedRows: marker.lineage.excludedRows });
    if (lineage !== marker.validation.lineageDigest || m.structural.sourceBytes !== m.source.byteSize || m.structural.sourceRows !== m.source.recordCount) throw new Error('accepted_dual_marker_mismatch');
    for (let i = 0; i < 2; i++) {
        const table = marker.bundle.tables[i], t = m.tables[i], spec = meaning.proposal.tables[i];
        if (!Number.isSafeInteger(t.bytes) || t.bytes < 1 || t.bytes > SPILL_LIMITS.totalBytes || table.name !== spec.name || t.name !== spec.name
            || table.rowCount !== meaning.counts[i] || t.rowCount !== meaning.counts[i] || JSON.stringify(table.schema) !== JSON.stringify(dualSchema(spec))
            || table.storage.mode !== 'accepted_spill' || table.storage.generation !== t.generation || table.storage.manifestDigest !== digest || table.datasetVersion !== `accepted-${digest}`) throw new Error('accepted_dual_table_mismatch');
    }
    const relationship = marker.bundle.relationships[0], p = meaning.proposal.relationships[0];
    if (marker.bundle.primaryTableId !== marker.bundle.tables[0].tableId || marker.bundle.relationships.length !== 1 || relationship?.decision !== 'trusted'
        || relationship.cardinality !== 'many_to_one' || relationship.fromTableId !== marker.bundle.tables[1].tableId || relationship.toTableId !== marker.bundle.tables[0].tableId
        || JSON.stringify(relationship.fromKeys) !== JSON.stringify(p.fromKeys) || JSON.stringify(relationship.toKeys) !== JSON.stringify(p.toKeys)) throw new Error('accepted_dual_relationship_mismatch');
    return m;
};
export const readAcceptedStreamedDual = async (marker: DatasetCommitMarker, current: () => void, storage: AcceptedSpillStorage = openAcceptedSpill, proposal = false) => {
    const m = await verifyStreamedDualMarker(marker, proposal); current();
    const files: File[] = [], bundleDigest=await codeDigest(marker.bundle); current();
    for (const t of m.tables) {
        const dir = await storage(t.generation, false, current); current();
        if (await dir.manifest() !== JSON.stringify({ digest: m.digest, bundleDigest, table: t })) throw new Error('accepted_dual_manifest_corrupt'); current();
        const file = await dir.file(); current();
        if (file.size !== t.bytes) throw new Error('accepted_dual_content_corrupt');
        const hash = new Hash();
        for (let offset = 0; offset < file.size; offset += 65536) { const bytes = new Uint8Array(await file.slice(offset, offset + 65536).arrayBuffer()); current(); hash.update(bytes); }
        if (hex(hash.digest()) !== t.sha256) throw new Error('accepted_dual_content_corrupt');
        files.push(file);
    }
    current(); return files;
};
export const writeAcceptedStreamedDual = async (marker: DatasetCommitMarker, custody: SpillReadCustody, store: StoreApi, current: () => void, storage: AcceptedSpillStorage = openAcceptedSpill) => {
    const m = await verifyStreamedDualMarker(marker, true); current();
    const dirs: Awaited<ReturnType<AcceptedSpillStorage>>[] = [],bundleDigest=await codeDigest(marker.bundle); current();
    const remove = async () => { await Promise.all(dirs.map(d => d.remove().catch(() => {}))); };
    try {
        for (let ti = 0; ti < 2; ti++) {
            const dir = await storage(m.tables[ti].generation, true, current); dirs.push(dir); current();
            await dir.writeCsv(tableCsv(custody, ti, store, current), current); current();
            await dir.seal(JSON.stringify({ digest: m.digest, bundleDigest, table: m.tables[ti] }), current); current();
        }
        const files = await readAcceptedStreamedDual(marker, current, storage, true); current();
        return { files, remove };
    } catch (e) { await remove(); throw e; }
};
