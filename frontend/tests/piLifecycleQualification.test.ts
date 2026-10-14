import { describe, expect, it } from 'vitest';
import { LIFECYCLE_CASES, completeLifecycleGroup, completeLifecycleMatrix, qualifyPiLifecycle, type LifecycleResult } from '../services/agent/runtime/pi/piLifecycleQualification';

describe('CA-170 explicit matrix integrity', () => {
    it('requires exact nonempty unique case identities and raw true verdicts', () => {
        expect(completeLifecycleGroup(['a'], [{id: 'a', passed: true}])).toBe(true);
        expect(completeLifecycleGroup([], [])).toBe(false);
        expect(completeLifecycleGroup(['a', 'a'], [{id: 'a', passed: true}, {id: 'a', passed: true}])).toBe(false);
        expect(completeLifecycleGroup(['a', 'b'], [{id: 'a', passed: true}, {id: 'a', passed: true}])).toBe(false);
        expect(completeLifecycleGroup(['a'], [{id: 'wrong', passed: true}])).toBe(false);
        expect(completeLifecycleGroup(['a'], [{id: 'a', passed: 'true' as unknown as boolean}])).toBe(false);
    });
    it('cannot pass missing, duplicated, unknown or contradicted group evidence', () => {
        const groups = Object.entries(LIFECYCLE_CASES).map(([group, ids]) => ({group, passed: true, cases: ids.map(id => ({id, passed: true}))})) as LifecycleResult[];
        expect(completeLifecycleMatrix(groups)).toBe(true);
        expect(completeLifecycleMatrix([])).toBe(false);
        expect(completeLifecycleMatrix(groups.slice(1))).toBe(false);
        expect(completeLifecycleMatrix([...groups.slice(1), groups[1]])).toBe(false);
        expect(completeLifecycleMatrix([{...groups[0], group: 'unknown' as LifecycleResult['group']}, ...groups.slice(1)])).toBe(false);
        expect(completeLifecycleMatrix([{...groups[0], error: 'failed'}, ...groups.slice(1)])).toBe(false);
        expect(completeLifecycleMatrix([{...groups[0], cases: [{id: 'wrong', passed: true}]}, ...groups.slice(1)])).toBe(false);
        expect(completeLifecycleMatrix([{...groups[0], passed: false}, ...groups.slice(1)])).toBe(false);
    });
    it('returns incomplete without allocating a native resource when already cancelled', async () => {
        const controller = new AbortController(); controller.abort();
        const result = await qualifyPiLifecycle(controller.signal);
        expect(result.passed).toBe(false); expect(result.groups).toEqual([]);
        expect(Object.values(LIFECYCLE_CASES).flat()).toHaveLength(112);
    });
});
