import type { HeaderAlignmentCandidateV1, HeaderAlignmentCell } from './headerAlignment';

/** UI projection only. Authority is ephemeral host state, never restored from this object. */
export interface StructureRepairReview {
    reviewId: string;
    status: 'awaiting_semantic_confirmation' | 'confirmed' | 'resuming' | 'draft_uncommitted' | 'neither' | 'cancelled' | 'stale' | 'continuing' | 'awaiting_repair' | 'repair_failed' | 'repair_blocked';
    sessionId: string;
    sessionEpoch: number;
    sourceSha256: string;
    sourceVersion: string;
    candidateSetDigest: string;
    choices: Array<{ label: string; candidateDigest: string; candidate: HeaderAlignmentCandidateV1 }>;
    selectedCandidateDigest: string | null;
    commitAllowed: false;
    message: string;
    draft?: {
        label: 'Draft / Uncommitted';
        validation: 'not_validated';
        columns: Array<{ targetColumn: number; headerPath: Array<HeaderAlignmentCell & { value: string }> }>;
        rows: Array<{ sourceRow: number; cells: string[] }>;
        totalSourceRows: number;
        truncated: boolean;
    };
}
