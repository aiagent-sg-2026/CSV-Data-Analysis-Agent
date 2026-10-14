import { describe, expect, it } from 'vitest';
import { CAPACITY_CASE_IDS, resolveCapacityVerdict, type CapacityObservation } from '../services/agent/execution/codeCapacityQualification';
const complete = (): CapacityObservation[] => CAPACITY_CASE_IDS.map(id => ({ id, passed: true, elapsedMs: 50, maxHeartbeatGapMs: 25 }));
describe('capacity qualification admission', () => {
    it('accepts the exact complete measured matrix', () => { expect(resolveCapacityVerdict(complete()).passed).toBe(true); });
    it.each(['empty', 'missing', 'duplicate', 'unknown', 'failed', 'cancelled', 'slow-health', 'invalid-time', 'nonboolean'])('refuses %s evidence', mode => {
        let evidence = complete();
        if (mode === 'empty') evidence = [];
        if (mode === 'missing') evidence.pop();
        if (mode === 'duplicate') evidence[1] = { ...evidence[0] };
        if (mode === 'unknown') evidence[0].id = 'unmeasured';
        if (mode === 'failed') evidence[0].passed = false;
        if (mode === 'slow-health') evidence[0].maxHeartbeatGapMs = 1001;
        if (mode === 'invalid-time') evidence[0].elapsedMs = Number.NaN;
        if (mode === 'nonboolean') evidence[0].passed = 'true' as never;
        expect(resolveCapacityVerdict(evidence, mode === 'cancelled').passed).toBe(false);
    });
});
