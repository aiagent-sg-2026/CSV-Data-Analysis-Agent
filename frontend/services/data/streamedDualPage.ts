import type { StagedDatasetCandidate } from './candidateContract';
import type { CandidateValidationReceipt } from './candidateStaging';
import type { SpillChunk } from './candidateSpill';
import { spillBytes } from './candidateSpill';
import { dualOrdinal, dualSourceRow, dualProjectedRow } from './streamedDualGrain';

/** Authenticate only the needed immutable chunks; implicit lineage is the approved mapping
 * plus source-record ordinal, never an output-sized array or repeated original sparse seek. */
export const streamedDualPage = async (c: StagedDatasetCandidate, receipt: Readonly<CandidateValidationReceipt>, name: string,
    offset: number, limit: number, read: (sequence: number) => Promise<SpillChunk>, current: () => void) => {
    const m = c.streamedDual!, ti = c.tables.findIndex(t => t.name === name), table = c.tables[ti], spec = m.meaning.proposal.tables[ti];
    if (!table) throw new Error('candidate_table_unavailable');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > table.rowCount || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('preview_bounds_invalid');
    const result = { label: 'draft_uncommitted' as const, candidateId: c.candidateId, tableName: name, validationReceiptDigest: receipt.receiptDigest, changeDigest: c.changeDigest,
        sessionId: c.sessionId, sessionEpoch: c.sessionEpoch, protectedSource: c.protectedSource, sourceSha256: c.protectedSource!.sha256, sourceVersion: c.protectedSource!.sha256,
        inputBindings: c.inputBindings, offset, totalRows: table.rowCount, rows: [] as typeof table.rows, lineageSamples: [] as typeof table.lineage,
        truncated: false, lineageTruncated: false, answerEvidence: false as const };
    if (offset === table.rowCount) { current(); return result; }
    const target = dualSourceRow(spec, offset);
    let low = 0, high = m.manifest.chunks - 1, sequence = -1;
    while (low <= high) { const mid = Math.floor((low + high) / 2), chunk = await read(mid); current();
        if (target < chunk.startRow) high = mid - 1; else if (target >= chunk.nextRow) low = mid + 1; else { sequence = mid; break; } }
    if (sequence < 0) throw new Error('candidate_lineage_incomplete');
    const origins: Array<{ row: number; projection: number }> = [];
    let full = false;
    for (; sequence < m.manifest.chunks && result.rows.length < limit && !full; sequence++) {
        const chunk = await read(sequence); current();
        for (const raw of chunk.rows) {
            const ordinal = dualOrdinal(spec, raw.sourceRow); if (ordinal < 0) continue;
            for (let pi = 0; pi < spec.projections.length; pi++) {
                if (ordinal + pi < offset || result.rows.length >= limit || full) continue;
                result.rows.push(dualProjectedRow(m.meaning, ti, pi, raw.sourceRow, raw.cells));
                if (spillBytes(JSON.stringify(result)) > 60 * 1024) { result.rows.pop(); full = true; break; }
                origins.push({ row: raw.sourceRow, projection: pi });
            }
        }
    }
    if (!result.rows.length) throw new Error('candidate_preview_row_too_large');
    result.truncated = offset + result.rows.length < table.rowCount;
    outer: for (let i = 0; i < origins.length; i++) for (const map of spec.projections[origins[i].projection]) {
        result.lineageSamples.push({ row: offset + i, column: map.column, origins: [{ kind: 'source', name: m.meaning.proposal.input.name, row: map.sourceRow ?? origins[i].row, column: map.sourceColumn }] });
        if (result.lineageSamples.length > 50 || spillBytes(JSON.stringify(result)) > 63 * 1024) { result.lineageSamples.pop(); result.lineageTruncated = true; break outer; }
    }
    current(); return result;
};
