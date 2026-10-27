import type { ReportIntakeIr } from '../../../../types/intake';
import type { HeaderAlignmentCell } from '../../../../types/headerAlignment';
import { solveHeaderAlignment } from '../../headerAlignment';

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
export const inspectInitialHeaderAlignment = async (intake: ReportIntakeIr | null | undefined, associatedSha: string | undefined): Promise<InitialHeaderAlignmentDiagnostic> => {
    const sha = associatedSha && /^[a-f0-9]{64}$/i.test(associatedSha) ? associatedSha : null;
    const identity = `Associated source byte SHA-256 (not verified against these rows): ${sha ?? 'unavailable'}.`;
    const unavailable = `${identity} Header alignment diagnostics are unavailable. Analysis is blocked awaiting semantic state; no selection or resume is supported, and no candidate can be committed.`;
    if (!intake) return {status:'unsupported', blocked:true, summary:unavailable, associatedSourceSha256:sha,
        rawRowsFingerprintSha256:null, reasons:['intake_unavailable'], possibleChoices:[]};
    const result = await solveHeaderAlignment(intake);
    if (result.status === 'unsupported') return {status:result.status, blocked:true, summary:unavailable, associatedSourceSha256:sha,
        rawRowsFingerprintSha256:null, reasons:result.ambiguities, possibleChoices:[]};
    if (result.status === 'no_candidates') {
        const blocked = Boolean(intake.diagnostics?.headerShapeDrift);
        return {status:result.status, blocked, associatedSourceSha256:sha, rawRowsFingerprintSha256:null,
            reasons:[...result.ambiguities, ...(blocked ? ['header_shape_drift'] : [])], possibleChoices:[],
            summary:blocked ? `${identity} Header/body shape drift was detected, but no reliable alignment was found. Analysis is blocked awaiting semantic state; no selection or resume is supported, and no candidate can be committed.` : ''};
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
        summary:`${identity} Canonical rawRows fingerprint (SHA-256 of declared width and parsed rows, not source bytes): ${fingerprint ?? 'unavailable'}. Structural alternatives: ${positions}. These are not semantic choices or approval. Analysis is blocked awaiting semantic state; no selection or resume is supported, and no candidate can be committed.`};
};
