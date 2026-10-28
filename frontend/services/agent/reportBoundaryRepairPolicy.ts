import type { PipelineOutcomeStatus } from '../../types/reportStructure';

/** This marker must be supplied by the host, not inferred from review text or persisted state. */
export type ReportBoundaryRepairMarker = {
    kind: 'candidate_repair';
    approval: 'pending' | 'approved';
};

/** Boundary confirmation is not an approval of an agent's candidate repair. */
export const reportBoundaryOverridePolicy = (
    status: PipelineOutcomeStatus | null | undefined,
    marker: ReportBoundaryRepairMarker | null | undefined,
) => {
    const pendingRepair = marker?.kind === 'candidate_repair' && marker.approval === 'pending';
    const accepted = !pendingRepair && (status === 'ready' || status === 'degraded_but_usable');
    return {
        accepted,
        refresh: accepted,
        initialAnalysis: accepted,
    };
};
