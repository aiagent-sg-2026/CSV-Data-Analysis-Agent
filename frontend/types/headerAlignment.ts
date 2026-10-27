/** A reference into the original, unmodified rawRows (zero-based). */
export interface HeaderAlignmentCell {
    rowIndex: number;
    columnIndex: number;
}

export interface HeaderAlignmentMapping {
    targetColumn: number;
    /** Ordered header path. Resolve each coordinate against intake.rawRows; no value is copied. */
    headerPath: HeaderAlignmentCell[];
}

/** Structural evidence only. It is never an approval or a canonical schema. */
export interface HeaderAlignmentCandidateV1 {
    version: 1;
    sourceFingerprint: string;
    status: 'semantic_review_required';
    confidence: 'structural';
    sourceWidths: number[];
    headerSourceRows: number[];
    /** Row references and repetition counts supporting the proposed grouping. */
    headerEvidence: {
        upperRowIndex: number;
        leafRowIndex: number;
        repeatedGroupCount: number;
        leafPeriod: number;
    };
    /** Contiguous, equal-width rows; this is a structural hypothesis. */
    bodySourceRows: { start: number; endExclusive: number };
    /** Remaining rows, potentially including unknown or footer rows, not confirmed summaries. */
    summarySourceRows: { start: number; endExclusive: number };
    dataWidth: number;
    shape: 'repeated_groups';
    grain: 'one_row_per_source_row';
    mainStartColumn: number;
    mainEndColumn: number;
    groupCount: number;
    groupWidth: number;
    mappings: HeaderAlignmentMapping[];
    ambiguities: string[];
}

export interface HeaderAlignmentResult {
    status: 'semantic_review_required' | 'no_candidates' | 'unsupported';
    candidates: HeaderAlignmentCandidateV1[];
    ambiguities: string[];
}

export interface HeaderAlignmentValidation {
    valid: boolean;
    status: 'semantic_review_required' | 'invalid';
    issues: string[];
}
