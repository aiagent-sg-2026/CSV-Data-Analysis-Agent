import type { CsvData, ReportIntakeIr } from './intake';
import type { RuntimeTableAssessment, RowInspectionBundle } from './data';

export type ReportRowRole =
    | 'title'
    | 'parameter'
    | 'header'
    | 'detail'
    | 'group_header'
    | 'subtotal'
    | 'summary'
    | 'note'
    | 'footer'
    | 'blank'
    | 'unknown';

export interface ReportBoundary {
    headerRowIndex: number | null;
    headerLayerRowIndexes: number[];
    bodyStartIndex: number | null;
    summaryStartIndex: number | null;
    parameterRowIndexes: number[];
    repeatedHeaderRowIndexes: number[];
}

export interface ReportBoundaryConfidence {
    header: number;
    body: number;
    summary: number;
    overall: number;
    sourceAgreement: number;
}

export interface ReportRowRoleAssignment {
    rowIndex: number;
    dataset: 'raw' | 'prepared';
    role: ReportRowRole;
    confidence: number;
    source: 'intake' | 'runtime' | 'deterministic' | 'human' | 'ai';
    notes?: string[];
}

export type ReportStructureFieldRole =
    | 'grain'
    | 'metric'
    | 'time_dimension'
    | 'identifier'
    | 'descriptor'
    | 'helper'
    | 'unknown';

export type ReportStructurePivotShape =
    | 'row_table'
    | 'wide_pivot'
    | 'statement_table'
    | 'unknown';

export interface ReportStructurePurposeProposal {
    summary: string;
    confidence: number;
}

export interface ReportStructureGrainProposal {
    columns: string[];
    description: string;
    confidence: number;
}

export interface ReportStructureFieldProposal {
    columnName: string;
    role: ReportStructureFieldRole;
    confidence: number;
    reasoning: string;
}

export interface ReportStructurePivotProposal {
    shape: ReportStructurePivotShape;
    dimensionColumns: string[];
    measureColumns: string[];
    labelColumns: string[];
    confidence: number;
}

export interface ReportStructureProposal {
    purpose: ReportStructurePurposeProposal;
    grain: ReportStructureGrainProposal;
    fields: ReportStructureFieldProposal[];
    pivot: ReportStructurePivotProposal;
    bodyRowRoles: Array<{
        rowIndex: number;
        role: ReportRowRole;
        confidence: number;
        notes?: string[];
    }>;
    carryForwardColumns: string[];
    sectionLabelColumns: string[];
    detailInclusionRoles: ReportRowRole[];
    confidence: number;
    reasoning: string;
}

export type ReportStructureProposalVerificationTier = 'pass' | 'warn' | 'fail';

export interface ReportStructureProposalVerificationIssue {
    code:
        | 'purpose_missing'
        | 'grain_missing'
        | 'grain_column_unresolved'
        | 'field_column_unresolved'
        | 'field_role_evidence_mismatch'
        | 'pivot_shape_unknown'
        | 'pivot_shape_conflict'
        | 'proposal_low_confidence'
        | 'high_impact_low_confidence'
        | 'normalization_warning';
    severity: 'warning' | 'error';
    message: string;
    columns?: string[];
}

export interface ReportStructureProposalVerification {
    tier: ReportStructureProposalVerificationTier;
    proposalConfidence: number;
    purpose: string | null;
    grainColumns: string[];
    fields: ReportStructureFieldProposal[];
    pivotShape: CanonicalizationDecision['targetShape'] | null;
    issues: ReportStructureProposalVerificationIssue[];
    accepted: boolean;
    autoApplySafe: boolean;
    requiresHumanConfirmation: boolean;
}

export interface CarryForwardColumnPolicy {
    columnName: string;
    source: 'deterministic' | 'ai' | 'human';
    reason: string;
}

export interface ReportNormalizationPlan {
    mergedHeaders: string[];
    carryForwardColumns: CarryForwardColumnPolicy[];
    sectionLabelColumns: string[];
    detailInclusionRoles: ReportRowRole[];
    excludedRoles: ReportRowRole[];
    rawRowRoleOverrides: ReportRowRoleAssignment[];
}

export interface CanonicalVerificationResult {
    passed: boolean;
    footerTotalsMatched: boolean | null;
    unresolvedMissingKeyDimensions: string[];
    warnings: string[];
    comparedFooterTotals: Record<string, {
        canonical: number;
        footer: number;
        matched: boolean;
    }>;
}

export interface CanonicalizationDecision {
    targetShape: 'row_table' | 'long_fact_table' | 'long_statement_table';
    shouldCanonicalize: boolean;
    reason: string;
}

export interface ReportStructureResolution {
    headerRowIndex: number | null;
    headerLayerRowIndexes: number[];
    bodyStartIndex: number | null;
    summaryStartIndex: number | null;
    parameterRowIndexes: number[];
    repeatedHeaderRowIndexes: number[];
    rowRoles: ReportRowRoleAssignment[];
    confidence: ReportBoundaryConfidence;
    blockingReasons: string[];
    requiresHumanReview: boolean;
    source: 'intake_provisional' | 'runtime_resolved' | 'human_confirmed' | 'ai_confirmed';
    decision: CanonicalizationDecision;
    rawIntakeBoundary: ReportBoundary | null;
    runtimeBoundary: ReportBoundary | null;
    humanBoundary: ReportBoundary | null;
    runtimeTableAssessment: RuntimeTableAssessment | null;
    rowInspection: RowInspectionBundle | null;
    proposalSource: 'none' | 'ai' | 'human';
    structureProposal: ReportStructureProposal | null;
    proposalVerification: ReportStructureProposalVerification | null;
    normalizationPlan: ReportNormalizationPlan;
    resolvedRawRowRoles: ReportRowRoleAssignment[];
    verificationSummary: CanonicalVerificationResult | null;
}

export type CanonicalizationStatus = 'idle' | 'ready' | 'needs_review' | 'failed';

export type CanonicalBuildSource = ReportStructureResolution['source'] | 'analysis_reshape';

export interface CanonicalReshapeProvenance {
    reshapedFromWidePivot: boolean;
    reshapeOperationId: string;
    reshapeAppliedAt: string;
    sourceColumnCountBefore: number;
    rowCountBefore: number;
    rowCountAfter: number;
}

/** Calendar grain of the period columns of a period-header wide table. */
export type PeriodGrain = 'year' | 'quarter' | 'month';

/** One published series of a melted period-header wide table. */
export interface PeriodSeriesInfo {
    /** Unique series key as stored in the series column. */
    name: string;
    /** Source label, present only when it repeats and so differs from `name` (e.g. `Male` for `Citizens > Male`). */
    label?: string;
    parent: string | null;
    rowClass: 'fact' | 'subtotal' | 'total';
    /** Periods with a published (non-missing) value. */
    observations: number;
    /** ISO start date of the latest period with a published value. */
    latestPeriod: string | null;
}

/**
 * What the value column of a melted period-header wide table means. Each row
 * holds one series in one period, and different series can measure different
 * things (km of rail, daily riders, passenger-km), so the value is only
 * comparable or summable across series when the intake verified it.
 */
export interface SeriesMeasureSemantics {
    seriesColumn: string;
    measureColumn: string;
    periodColumn: string;
    periodGrain: PeriodGrain;
    parentColumn: string | null;
    /** Columns carrying the row class (RowClass and its RowRole copies); empty without a hierarchy. */
    detailRowColumns: string[];
    detailRowValue: string;
    /**
     * False only on positive evidence that the series do not share one unit: a
     * published parent that does not equal the sum of its children, or several
     * top-level series without a covering total while some have components.
     * A plain table without hierarchy is additive. When true, detail (fact)
     * series can be summed.
     */
    additiveAcrossSeries: boolean;
    /** Families verified to share a unit: a published parent equal to the sum of its children. */
    unitFamilies: Array<{ parent: string; children: string[] }>;
    evidence: {
        rootSeries: number;
        parentSeriesChecked: number;
        parentSeriesVerified: number;
        parentPeriodsChecked: number;
        parentPeriodsMatched: number;
        summary: string;
    };
    series: PeriodSeriesInfo[];
}

export interface CanonicalBuildMeta {
    shape: CanonicalizationDecision['targetShape'];
    source: CanonicalBuildSource;
    rowCount: number;
    columnCount: number;
    lineageColumns: string[];
    summary: string;
    excludedRowCounts: Partial<Record<ReportRowRole, number>>;
    carryForwardAppliedCounts: Record<string, number>;
    footerTotalsMatched: boolean | null;
    reshapeProvenance?: CanonicalReshapeProvenance;
    /** Set when the canonical table is a melted period-header wide table. */
    seriesMeasure?: SeriesMeasureSemantics | null;
    /**
     * Set when a row table's label column carried a verified indentation
     * hierarchy. Parent rows stay in the table with RowClass subtotal|total;
     * detail rows have RowClass fact.
     */
    rowHierarchy?: {
        labelColumn: string;
        parentColumn: string;
        depthColumn: string;
        rowClassColumn: string;
        detailRowValue: string;
        levels: number;
        parentRows: number;
        detailRows: number;
        parentsChecked: number;
        parentsVerified: number;
    } | null;
}

export interface CanonicalDatasetArtifact {
    canonicalCsvData: CsvData;
    canonicalSchema: string[];
    canonicalBuildMeta: CanonicalBuildMeta;
}

export type PipelineOutcomeStatus =
    | 'ready'
    | 'needs_structure_review'
    | 'blocked_by_intake'
    | 'blocked_by_shape_verification'
    | 'blocked_by_sql_precheck'
    | 'degraded_but_usable'
    | 'cleaning_failed';

export interface PipelineOutcome {
    status: PipelineOutcomeStatus;
    canAutoAnalyze: boolean;
    severity: 'info' | 'warning' | 'blocked';
    reasonCode: string;
    message: string;
}

export interface ResolveReportStructureInput {
    rawCsvData: CsvData | null | undefined;
    csvData: CsvData | null | undefined;
    rawIntakeIr: ReportIntakeIr | null | undefined;
    runtimeTableAssessment?: RuntimeTableAssessment | null | undefined;
    rowInspection?: RowInspectionBundle | null | undefined;
    humanBoundary?: ReportBoundary | null | undefined;
    structureProposal?: ReportStructureProposal | null | undefined;
    shapeFailureSignalKey?: string | null | undefined;
    shapeVerificationPassed?: boolean | null | undefined;
    /** The prepared table is a period-header wide table with a verified deterministic reshape. */
    periodWideTableRecognized?: boolean;
}
