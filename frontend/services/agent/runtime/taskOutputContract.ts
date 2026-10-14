import type { RuntimeTaskOutputVerdict } from '../../../types';

/** Recompute required coverage instead of trusting a caller's completed/status flag. */
export const assessTaskOutputs = (input: Omit<RuntimeTaskOutputVerdict, 'status' | 'missingRequiredIds'>): RuntimeTaskOutputVerdict => {
    const acceptedOutputs = input.acceptedOutputs.filter(output => output.references.length > 0
        && output.references.every(reference => typeof reference === 'string' && reference.length > 0)
        && input.requiredOutputs.some(requirement => requirement.id === output.requirementId && requirement.kind === output.kind));
    const missingRequiredIds = input.requiredOutputs.filter(requirement => requirement.required
        && !acceptedOutputs.some(output => output.requirementId === requirement.id)).map(requirement => requirement.id);
    const reasons = [...new Set([...input.reasons, ...missingRequiredIds.map(id => `required_output_missing:${id}`)])];
    if (!input.requiredOutputs.some(output => output.required)) reasons.push('required_output_contract_missing');
    return { ...input, acceptedOutputs, missingRequiredIds, reasons,
        status: missingRequiredIds.length === 0 && reasons.length === 0 ? 'complete' : acceptedOutputs.length ? 'partial' : 'missing' };
};
