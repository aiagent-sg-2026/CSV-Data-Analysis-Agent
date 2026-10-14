import type { QueryPlan } from '../../../types';
import { requiresCompleteAggregateEvidence } from '../derivedMetricIntent';

/** The answer contract and executor use one policy; requested completeness is still checked after execution. */
export const normalizeEvidenceQueryPlan = (plan: QueryPlan, message: string): QueryPlan => ({
    ...plan,
    limit: requiresCompleteAggregateEvidence(message) && (plan.groupBy?.length ?? 0) > 0
        && (plan.aggregates?.length ?? 0) > 0 ? Math.max(plan.limit ?? 500, 500) : plan.limit ?? 500,
});
