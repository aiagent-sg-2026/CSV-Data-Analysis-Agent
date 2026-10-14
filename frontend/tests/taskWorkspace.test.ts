// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createTaskWorkspace } from '../services/agent/taskWorkspace';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import type { AppStore } from '../store/useAppStore';
const store = () => {
    let state = { sessionId: 'session-a' } as AppStore;
    return { getState: () => state, setState: (patch: Partial<AppStore>) => { state = { ...state, ...patch }; } };
};
describe('task workspace boundary', () => {
    it('keeps immutable revisions, enforces compare-and-swap and never mutates accepted data', async () => {
        const app = store();
        const task = createTaskWorkspace(app, 'task-a', { allowedPrefixes: ['/workspace/'], allowedPaths: ['/dataset/cleaned.csv'] });
        const first = await task.write('/workspace/repair.js', 'return 1;', 0);
        const next = await task.patch('/workspace/repair.js', [{ start: 7, end: 8, text: '2' }], first.revision);
        expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(task.read(first.path, first.revision).content).toBe('return 1;');
        expect(task.read(next.path).content).toBe('return 2;');
        await expect(task.write(first.path, 'lost update', first.revision)).rejects.toThrow('workspace_conflict');
        const candidate = await task.write('/dataset/cleaned.csv', 'amount\n999\n', 0);
        expect(candidate.kind).toBe('candidate');
        expect(app.getState()).toEqual({ sessionId: 'session-a' });
    });
    it('rejects paths and atomic quota overflow', async () => {
        const task = createTaskWorkspace(store(), 'task-a', { allowedPrefixes: ['/workspace/'], maxFileBytes: 10, maxTotalBytes: 12 });
        for (const path of ['/workspace/../secret', '/workspace/%2e%2e/secret', '/workspace/a\\b', '/etc/passwd', '/workspace/a?x', '/workspace/a//b']) {
            await expect(task.write(path, 'x', 0)).rejects.toThrow();
        }
        await task.write('/workspace/a', '12345678', 0);
        await expect(task.write('/workspace/a', '56789', 1)).rejects.toThrow('resource_limit');
        expect(task.read('/workspace/a').revision).toBe(1);
    });
    it('revokes old namespaces even when the same session ID is reused', async () => {
        const app = store();
        const old = createTaskWorkspace(app, 'task-a', { allowedPrefixes: ['/workspace/'] });
        await old.write('/workspace/a', 'old', 0);
        beginSessionTransition(app);
        const current = createTaskWorkspace(app, 'task-a', { allowedPrefixes: ['/workspace/'] });
        await current.write('/workspace/a', 'new', 0);
        old.dispose();
        expect(current.read('/workspace/a').content).toBe('new');
        await expect(old.write('/workspace/a', 'late', 1)).rejects.toThrow('scope_revoked');
    });
});

describe('workspace atomic publication races', () => {
    it('serializes competing expected revisions and keeps revisions distinct', async () => {
        const task = createTaskWorkspace(store(), 'task-a', { allowedPrefixes: ['/workspace/'] });
        const results = await Promise.allSettled([task.write('/workspace/a', 'first', 0), task.write('/workspace/a', 'second', 0)]);
        expect(results.map(item => item.status)).toEqual(['fulfilled', 'rejected']);
        expect(task.read('/workspace/a').content).toBe('first');
        expect(task.diff('/workspace/a', 1).before.sha256).toBe(task.read('/workspace/a').sha256);
        await expect(task.write('/workspace/tasks/task-b/private.js', 'cross task', 0)).rejects.toThrow('workspace_path_denied');
        expect(() => task.patch('/workspace/a', [{ start: 0, end: 3, text: '' }, { start: 1, end: 2, text: '' }], 1)).toThrow('workspace_patch_invalid');
    });
});
