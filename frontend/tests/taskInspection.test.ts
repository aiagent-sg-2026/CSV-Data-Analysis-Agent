// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import { beginRun, beginSessionTransition, finishRun, scopeRunStore } from '../services/session/sessionOwnership';
import { createTaskWorkspace } from '../services/agent/taskWorkspace';
import { createTaskInspection, readTaskProgram, publishTaskOutcome } from '../services/agent/runtime/pi/piTaskInspection';
import { buildPersistedAppState } from '../services/persistence/persistedAppState';

const fixture = () => {
    let state = { sessionId: 'inspection-session', workspaceFiles: {}, columnProfiles: [], chatHistory: [] } as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    const lease = beginRun(root, 'follow_up', 'inspection-run', 'inspection-turn'), store = scopeRunStore(root, lease);
    const workspace = createTaskWorkspace(root, 'inspection-task', { allowedPrefixes: ['/workspace/'] });
    const task = { taskId: 'inspection-task', revision: 1, sessionId: state.sessionId } as NonNullable<typeof state.activeAgentTask>;
    store.setState({ activeAgentTask: task });
    const inspector = createTaskInspection(store, lease, workspace, task.taskId);
    return { root, store, lease, workspace, task, inspector };
};
describe('session-owned task inspection', () => {
    it('reads exact old and current program revisions through bounded live ranges after terminal release', async () => {
        const f = fixture();
        const first = await f.workspace.write('/workspace/program.js', `return '${'a'.repeat(4000)}';`, 0);
        f.inspector.observe(f.task, 'workspace.write', { status: 'success', toolName: 'workspace.write', message: 'First program.', shouldStop: false }, 'write-a');
        await f.workspace.write(first.path, 'return 2;', 1);
        f.inspector.observe(f.task, 'workspace.replace', { status: 'success', toolName: 'workspace.replace', message: 'Repaired program.', shouldStop: false }, 'write-b');
        const programs = f.root.getState().taskInspection!.programs;
        expect(programs.map(p => p.revision)).toEqual([1, 2]);
        finishRun(f.root, f.lease);
        const range = readTaskProgram(f.root, f.task.taskId, programs[0]);
        expect(range.content).toHaveLength(3000); expect(range.complete).toBe(false);
        expect(readTaskProgram(f.root, f.task.taskId, programs[0], range.endOffset).complete).toBe(true);
        expect(readTaskProgram(f.root, f.task.taskId, programs[1]).content).toBe('return 2;');
        expect(() => readTaskProgram(f.root, f.task.taskId, { ...programs[1], sha256: first.sha256 })).toThrow('task_code_revision_mismatch');
        beginSessionTransition(f.root);
    });
    it('retains actual bounded logs without persisting inspection text or inferring evidence from stdout', async () => {
        const f = fixture();
        await f.workspace.write('/workspace/test.js', 'throw new Error("repair me");', 0);
        f.inspector.observe(f.task, 'code.run', { status: 'error', toolName: 'code.run', message: 'Failed.', shouldStop: false,
            artifacts: { codeExecution: { status: 'failed', jobId: 'actual-job', stdout: 'secret fixture row'.repeat(200), stderr: 'stack', error: { message: 'repair me' }, durationMs: 7 } } }, 'real-call');
        const view = f.root.getState().taskInspection!;
        expect(view.observations[0]).toMatchObject({ status: 'failed', jobId: 'actual-job', message: 'repair me', durationMs: 7, truncated: true });
        expect(view.observations[0].stdout).toHaveLength(2000);
        expect(view.programs[0]).not.toHaveProperty('content');
        expect(view.grounding).toBeUndefined();
        expect(buildPersistedAppState(f.root.getState()).taskInspection).toBeNull();
        beginSessionTransition(f.root);
    });
    it('bounds recent observations and refuses late publication / source reads after same-ID replacement', async () => {
        const f = fixture(); await f.workspace.write('/workspace/program.js', 'return 1;', 0);
        for (let i = 0; i < 35; i++) f.inspector.observe(f.task, 'workspace.read', { status: 'success', toolName: 'workspace.read', message: `read ${i}`, shouldStop: false }, `call-${i}`);
        expect(f.root.getState().taskInspection!.observations).toHaveLength(30);
        expect(f.root.getState().taskInspection!.omittedObservations).toBe(5);
        const program = f.root.getState().taskInspection!.programs[0];
        beginSessionTransition(f.root);
        const newer = beginRun(f.root, 'follow_up', 'new-run', 'new-turn'); f.root.setState({ isBusy: true });
        f.inspector.publish();
        f.inspector.observe(f.task, 'code.run', { status: 'success', toolName: 'code.run', message: 'late', shouldStop: false }, 'late');
        f.store.piTask = { snapshot: f.task } as never;
        publishTaskOutcome(f.store, 'late completion');
        expect(f.root.getState().taskInspection).toBeNull();
        expect(f.root.getState().activeExecution?.runId).toBe('new-run'); expect(f.root.getState().isBusy).toBe(true);
        expect(() => readTaskProgram(f.root, f.task.taskId, program)).toThrow('task_code_unavailable');
        finishRun(f.root, newer); beginSessionTransition(f.root);
    });
});
