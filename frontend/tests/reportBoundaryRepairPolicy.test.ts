import { describe, expect, it } from 'vitest';
import { reportBoundaryOverridePolicy } from '../services/agent/reportBoundaryRepairPolicy';
import type { PipelineOutcomeStatus } from '../types/reportStructure';

const allowed = { accepted: true, refresh: true, initialAnalysis: true };
const blocked = { accepted: false, refresh: false, initialAnalysis: false };

describe('report boundary candidate repair policy', () => {
    it.each(['ready', 'degraded_but_usable'] as const)(
        'does not accept, refresh or analyze a host-marked pending repair with %s outcome',
        status => {
            expect(reportBoundaryOverridePolicy(status, { kind: 'candidate_repair', approval: 'pending' })).toEqual(blocked);
        },
    );

    it.each(['ready', 'degraded_but_usable'] as const)(
        'preserves the legacy %s outcome without a repair marker',
        status => {
            expect(reportBoundaryOverridePolicy(status, null)).toEqual(allowed);
            expect(reportBoundaryOverridePolicy(status, undefined)).toEqual(allowed);
        },
    );

    it('permits a ready outcome when the host marks the repair approved', () => {
        expect(reportBoundaryOverridePolicy('ready', { kind: 'candidate_repair', approval: 'approved' })).toEqual(allowed);
    });

    it.each([
        'needs_structure_review',
        'blocked_by_intake',
        'blocked_by_shape_verification',
        'blocked_by_sql_precheck',
        'cleaning_failed',
        null,
        undefined,
    ] satisfies Array<PipelineOutcomeStatus | null | undefined>)(
        'never accepts or starts downstream work for non-usable outcome %s',
        status => {
            expect(reportBoundaryOverridePolicy(status, undefined)).toEqual(blocked);
            expect(reportBoundaryOverridePolicy(status, { kind: 'candidate_repair', approval: 'pending' })).toEqual(blocked);
            expect(reportBoundaryOverridePolicy(status, { kind: 'candidate_repair', approval: 'approved' })).toEqual(blocked);
        },
    );
});
