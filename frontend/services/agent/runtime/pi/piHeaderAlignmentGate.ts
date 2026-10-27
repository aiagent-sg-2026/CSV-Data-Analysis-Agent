import type { ReportIntakeIr } from '../../../../types/intake';
import type { HeaderAlignmentCell } from '../../../../types/headerAlignment';
import { solveHeaderAlignment } from '../../headerAlignment';
import type { StoreApi } from '../../types';
import { requireCurrentCsvSourceScan, assertCsvScanPublicationAllowed } from '../../../data/csvSourceScan';

/** Bounded, value-free evidence; coordinates are zero-based source positions. Not a selection or authority. */
export interface InitialHeaderAlignmentDiagnostic {
    status: 'no_candidates' | 'semantic_review_required' | 'unsupported';
    blocked: boolean;
    summary: string;
    associatedSourceSha256: string | null;
    rawRowsFingerprintSha256: string | null;
    reasons: string[];
    possibleChoices: Array<{
        structuralIndex: number;
        headerSourceRows: number[];
        bodySourceRows: { start: number; endExclusive: number };
        summarySourceRows: { start: number; endExclusive: number };
        mainStartColumn: number;
        mainEndColumn: number;
        dataWidth: number;
        groupCount: number;
        groupWidth: number;
        headerEvidence: { upperRowIndex: number; leafRowIndex: number; repeatedGroupCount: number; leafPeriod: number };
        mappings: Array<{ targetColumn: number; headerPath: HeaderAlignmentCell[] }>;
        reasons: string[];
    }>;
}

/** Source inspection metadata is associated, not proof that these rows came from those bytes. */
export const inspectInitialHeaderAlignment = async (intake: ReportIntakeIr | null | undefined, associatedSha: string | undefined, store?: StoreApi): Promise<InitialHeaderAlignmentDiagnostic> => {
    const sha = associatedSha && /^[a-f0-9]{64}$/i.test(associatedSha) ? associatedSha : null;
    const identity = `Associated source byte SHA-256 (not verified against these rows): ${sha ?? 'unavailable'}.`;
    const unavailable = `${identity} Header alignment diagnostics are unavailable. Analysis is blocked awaiting semantic state; diagnostics alone cannot authorize selection or resume, and no candidate can be committed.`;
    if (!intake) return {status:'unsupported', blocked:true, summary:unavailable, associatedSourceSha256:sha,
        rawRowsFingerprintSha256:null, reasons:['intake_unavailable'], possibleChoices:[]};
    const result = await solveHeaderAlignment(intake);
    if (result.status === 'unsupported') return {status:result.status, blocked:true, summary:unavailable, associatedSourceSha256:sha,
        rawRowsFingerprintSha256:null, reasons:result.ambiguities, possibleChoices:[]};
    if (result.status === 'no_candidates') {
        const reasons = [...result.ambiguities];
        let blocked = Boolean(intake.diagnostics?.headerShapeDrift);
        if (blocked) reasons.push('header_shape_drift');
        if (result.ambiguities.includes('header_scan_limited') || store?.getState().csvData?.backing?.mode === 'duckdb_file') {
            try {
                if (!store) throw new Error('scan_original_source_unavailable_reselect_original');
                const scan = await requireCurrentCsvSourceScan(store);
                if (scan.status !== 'completed_clean' || scan.sha256 !== sha) throw new Error(scan.reason ?? 'source_scan_requires_automatic_repair_or_resume');
                reasons.push('full_source_scan_completed_clean');
            } catch (error) { blocked = true; reasons.push(error instanceof Error ? error.message : 'full_source_scan_unverified'); }
        }
        if (store) {
            try { assertCsvScanPublicationAllowed(store); }
            catch { blocked = true; reasons.push('source_scan_requires_automatic_repair_or_resume'); }
        }
        return {status:result.status, blocked, associatedSourceSha256:sha, rawRowsFingerprintSha256:null,
            reasons, possibleChoices:[],
            summary:blocked ? `${identity} ${intake.diagnostics?.headerShapeDrift ? 'Header/body shape drift was detected, but no reliable alignment was found.' : 'Complete clean structural evidence is not available.'} Analysis is blocked awaiting semantic state and automatic source scanning/repair continuation. A partial header scan is not proof of no issues; no candidate can be committed.` : ''};
    }
    const fingerprint = result.candidates[0]?.sourceFingerprint ?? null;
    const possibleChoices = result.candidates.map((candidate, index) => ({
        structuralIndex:index, headerSourceRows:candidate.headerSourceRows, bodySourceRows:candidate.bodySourceRows,
        summarySourceRows:candidate.summarySourceRows, mainStartColumn:candidate.mainStartColumn, mainEndColumn:candidate.mainEndColumn,
        dataWidth:candidate.dataWidth, groupCount:candidate.groupCount, groupWidth:candidate.groupWidth,
        headerEvidence:candidate.headerEvidence, mappings:candidate.mappings, reasons:candidate.ambiguities,
    }));
    // Coordinates are safe to display; never interpolate untrusted source cells into UI or prompts.
    const positions = result.candidates.map((candidate, index) =>
        `${index + 1}: header rows ${candidate.headerSourceRows.map(row => row + 1).join(', ')}, repeated data columns ${candidate.mainStartColumn + 1}–${candidate.mainEndColumn}`).join('; ');
    return {status:result.status, blocked:true, associatedSourceSha256:sha, rawRowsFingerprintSha256:fingerprint,
        reasons:result.ambiguities, possibleChoices,
        summary:`${identity} Canonical rawRows fingerprint (SHA-256 of declared width and parsed rows, not source bytes): ${fingerprint ?? 'unavailable'}. Structural alternatives: ${positions}. These are not semantic choices or approval. Analysis is blocked awaiting semantic state; diagnostics alone cannot authorize selection or resume. Use current source-bound review for read-only mapping drafts; no candidate can be committed.`};
};
