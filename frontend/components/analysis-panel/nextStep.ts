export type NextStepKind = 'enable_cloud_ai' | 'repair_structure' | 'recover_provider' | 'review_evidence' | 'report';

export interface NextStepFlags {
    /** Cloud analysis never started because the user chose local processing only. */
    needsCloudAiConsent?: boolean;
    needsStructureRepair: boolean;
    needsProviderRecovery: boolean;
    needsEvidenceReview: boolean;
}

/**
 * The detected structure must be confirmed before cleaning or analysis can
 * continue. Cleaning resume/restart actions cannot succeed in this state, so
 * both the dashboard and spreadsheet cleaning banners stay hidden.
 */
export const isStructureReviewPending = (
    pipelineOutcome: { status?: string } | null | undefined,
    reportStructureResolution: { requiresHumanReview?: boolean } | null | undefined,
): boolean => pipelineOutcome?.status === 'needs_structure_review'
    && reportStructureResolution?.requiresHumanReview === true;

/**
 * A declined cloud AI consent comes first because no analysis ran and every other step needs it.
 * Then structure problems, a failed provider and evidence review; otherwise the report.
 */
export const resolveNextStepKind = (flags: NextStepFlags): NextStepKind => {
    if (flags.needsCloudAiConsent) return 'enable_cloud_ai';
    if (flags.needsStructureRepair) return 'repair_structure';
    if (flags.needsProviderRecovery) return 'recover_provider';
    if (flags.needsEvidenceReview) return 'review_evidence';
    return 'report';
};

export interface NextStepCopyKeys {
    reason: string;
    outcome: string;
    action: string;
}

export const resolveNextStepCopyKeys = (params: {
    kind: NextStepKind;
    degraded: boolean;
    hasReport: boolean;
    isGeneratingReport: boolean;
}): NextStepCopyKeys => {
    const { kind, degraded, hasReport, isGeneratingReport } = params;
    switch (kind) {
        case 'enable_cloud_ai':
            return {
                reason: 'analysis_results_next_step_reason_cloud_consent',
                outcome: 'analysis_results_next_step_outcome_cloud_consent',
                action: 'analysis_results_enable_cloud_ai_action',
            };
        case 'repair_structure':
            return {
                reason: 'analysis_results_next_step_reason_structure',
                outcome: 'analysis_results_next_step_outcome_repair',
                action: 'analysis_results_repair_action',
            };
        case 'recover_provider':
            return {
                reason: 'analysis_results_next_step_reason_provider',
                outcome: 'analysis_results_next_step_outcome_provider',
                action: 'analysis_results_retry_action',
            };
        case 'review_evidence':
            return {
                reason: 'analysis_results_next_step_reason_repair',
                outcome: 'analysis_results_next_step_outcome_evidence',
                action: 'analysis_results_review_evidence_action',
            };
        default:
            return {
                reason: degraded
                    ? 'analysis_results_next_step_reason_degraded_report'
                    : 'analysis_results_next_step_reason_ready_report',
                outcome: 'analysis_results_next_step_outcome_report',
                action: hasReport
                    ? 'report_open'
                    : isGeneratingReport ? 'generate_analyst_report_running' : 'generate_analyst_report',
            };
    }
};
