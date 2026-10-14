import type { AiAction, ToolExecutionResult } from '../../../types';
import type { StoreApi } from '../types';
import type { CodeRunRequest, CodePolicyContext } from './codeExecutionContract';

export const executeCodeAction = async (action: AiAction, store: StoreApi, signal?: AbortSignal, policy?: CodePolicyContext): Promise<ToolExecutionResult> => {
    if (action.type !== 'tool_call' || !['code.run','code.inspect','code.cancel'].includes(action.toolName)) throw new Error('validation_failed');
    const toolName = action.toolName;
    if (toolName !== 'code.run' && (!action.args || typeof action.args !== 'object' || Array.isArray(action.args)
        || Object.keys(action.args).some(key => key !== 'jobId')
        || (action.args.jobId === undefined ? toolName !== 'code.inspect' : typeof action.args.jobId !== 'string' || !action.args.jobId.length || action.args.jobId.length > 80))) {
        return { status: 'blocked', toolName, message: 'validation_failed: use an owned jobId.', shouldStop: false };
    }
    const adapter = store.codeExecution, context = store.executionContext;
    if (!adapter || !context) return { status: 'blocked', toolName, message: 'capability_unavailable: host task execution authority is required.', shouldStop: false };
    try {
        const receipt = toolName === 'code.run' ? await adapter.run(action.args as CodeRunRequest, context, signal, policy)
            : toolName === 'code.cancel' ? adapter.cancel(action.args?.jobId, context, policy) : adapter.inspect(action.args?.jobId, context, policy);
        const terminal = !Array.isArray(receipt) ? receipt : undefined;
        const status = terminal && ['failed','cancelled','blocked'].includes(terminal.status) ? 'blocked' : 'success';
        return { status, toolName, message: terminal ? `${terminal.status}: ${terminal.reasonCode}` : 'Owned job receipts.', shouldStop: false,
            payload: { codeExecution: receipt }, artifacts: { codeExecution: receipt },
            retryHint: terminal?.retry ?? null,
            observation: { type: 'tool_result', status, toolName, summary: terminal ? `${terminal.status}: ${terminal.reasonCode}` : 'Owned jobs inspected.', detail: { codeExecution: receipt } },
        };
    } catch {
        return { status: 'blocked', toolName, message: 'scope_revoked: job is unavailable to this task.', shouldStop: false, retryHint: 'Use the current task and an owned jobId.' };
    }
};
