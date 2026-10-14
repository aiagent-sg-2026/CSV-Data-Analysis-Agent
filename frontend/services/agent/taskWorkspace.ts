import type { StoreApi } from './types';
import { assertSessionResourceActive, captureSessionScope, registerSessionResource, type SessionScope } from '../session/sessionOwnership';
import { sha256Bytes } from '../data/sourceDigest';

export interface TaskArtifact {
    artifactId: string; namespaceId: string; taskId: string; sessionId: string; sessionEpoch: number; path: string; revision: number;
    sha256: string; byteSize: number; kind: 'program' | 'scratch' | 'candidate'; content: string;
}
export interface WorkspaceGrant {
    allowedPrefixes?: string[]; allowedPaths?: string[];
    maxFileBytes?: number; maxTotalBytes?: number; maxArtifacts?: number;
}
export interface TextPatch { start: number; end: number; text: string }
const limits = { maxFileBytes: 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxArtifacts: 100 };
export const canonicalTaskPath = (path: string): string => {
    if (typeof path !== 'string' || path.length > 240 || !/^\/(workspace|dataset)\//.test(path)
        || path.startsWith('/workspace/task-artifacts/') || /[%\\?#\x00-\x1f\x7f]/.test(path) || path.trim() !== path
        || path.split('/').slice(1).some(part => !part || part === '.' || part === '..')) throw new Error('workspace_path_denied');
    return path;
};
export const assertWorkspaceOwner = assertSessionResourceActive;

/** Host-issued handle. It is transient, and has no Store, DuckDB or filesystem write capability. */
export const createTaskWorkspace = (store: StoreApi, taskId: string, grant: WorkspaceGrant) => {
    const scope = captureSessionScope(store);
    assertWorkspaceOwner(store, scope);
    if (!/^[a-zA-Z0-9._-]{1,160}$/.test(taskId)) throw new Error('task_identity_invalid');
    const prefixes = [...(grant.allowedPrefixes ?? [])];
    const paths = [...(grant.allowedPaths ?? [])];
    if (prefixes.some(prefix => prefix !== '/workspace/') || paths.some(path => canonicalTaskPath(path) !== path
        || (path.startsWith('/dataset/') && path !== '/dataset/cleaned.csv'))) throw new Error('workspace_grant_invalid');
    const quota = { ...limits };
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
        const value = grant[key] ?? limits[key];
        if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new Error('workspace_grant_invalid');
        quota[key] = value;
    }
    const namespaceId = crypto.randomUUID();
    const files = new Map<string, TaskArtifact[]>();
    let bytes = 0; let artifacts = 0; let disposed = false;
    let queue: Promise<unknown> = Promise.resolve();
    const active = () => { assertWorkspaceOwner(store, scope); if (disposed) throw new Error('scope_revoked'); };
    const allowed = (path: string) => {
        active(); canonicalTaskPath(path);
        if (path.startsWith('/workspace/tasks/') && !path.startsWith(`/workspace/tasks/${taskId}/`)) throw new Error('workspace_path_denied');
        if (!paths.includes(path) && !prefixes.some(prefix => path.startsWith(prefix))) throw new Error('workspace_path_denied');
    };
    const dispose = () => { disposed = true; files.clear(); bytes = 0; artifacts = 0; };
    registerSessionResource(scope, dispose);
    const read = (path: string, revision?: number): Readonly<TaskArtifact> => {
        allowed(path);
        const versions = files.get(path) ?? [];
        const artifact = revision === undefined ? versions.at(-1) : versions.find(item => item.revision === revision);
        if (!artifact) throw new Error('workspace_file_unavailable');
        return artifact;
    };
    const readRange = (path: string, revision?: number, startOffset = 0, length = 3000) => {
        const artifact = read(path, revision);
        if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > artifact.content.length
            || !Number.isSafeInteger(length) || length < 0 || length > 3000) throw new Error('workspace_range_invalid');
        const { content, ...reference } = artifact;
        const endOffset = Math.min(content.length, startOffset + length);
        return { ...reference, content: content.slice(startOffset, endOffset), startOffset, endOffset, complete: endOffset === content.length };
    };
    const write = (path: string, content: string, expectedRevision: number, assertCurrent?: () => void): Promise<Readonly<TaskArtifact>> => {
        const operation = async () => {
            allowed(path);
            assertCurrent?.();
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('workspace_revision_required');
            const versions = files.get(path) ?? [];
            if ((versions.at(-1)?.revision ?? 0) !== expectedRevision) throw new Error('workspace_conflict');
            if (typeof content !== 'string') throw new Error('workspace_content_invalid');
            const encoded = new TextEncoder().encode(content);
            if (encoded.byteLength > quota.maxFileBytes || bytes + encoded.byteLength > quota.maxTotalBytes
                || artifacts + 1 > quota.maxArtifacts) throw new Error('resource_limit');
            const sha256 = await sha256Bytes(encoded);
            active();
            assertCurrent?.();
            const artifact = Object.freeze({ artifactId: crypto.randomUUID(), namespaceId, taskId, sessionId: scope.sessionId, sessionEpoch: scope.epoch, path,
                revision: expectedRevision + 1, sha256, byteSize: encoded.byteLength,
                kind: path === '/dataset/cleaned.csv' ? 'candidate' as const
                    : /\.(js|ts|py|sql)$/.test(path) ? 'program' as const : 'scratch' as const, content });
            files.set(path, [...versions, artifact]); bytes += encoded.byteLength; artifacts += 1;
            return artifact;
        };
        const pending = queue.then(operation);
        queue = pending.catch(() => undefined);
        return pending;
    };
    const patch = (path: string, edits: TextPatch[], expectedRevision: number) => {
        const current = read(path);
        if (current.revision !== expectedRevision) return Promise.reject(new Error('workspace_conflict'));
        if (!Array.isArray(edits) || !edits.length || edits.length > 100) throw new Error('workspace_patch_invalid');
        let end = 0;
        for (const edit of edits) {
            if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < end
                || edit.end < edit.start || edit.end > current.content.length || typeof edit.text !== 'string') throw new Error('workspace_patch_invalid');
            end = edit.end;
        }
        let content = current.content;
        for (const edit of [...edits].reverse()) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
        return write(path, content, expectedRevision);
    };
    return Object.freeze({ namespaceId, taskId, read, readRange, write, patch, dispose,
        revision: (path: string) => { allowed(path); return files.get(path)?.at(-1)?.revision ?? 0; },
        list: () => { active(); return [...files.values()].map(versions => versions.at(-1)!); },
        diff: (path: string, from: number, to?: number) => ({ before: read(path, from), after: read(path, to) }),
    });
};
export type TaskWorkspace = ReturnType<typeof createTaskWorkspace>;
const workspaces = new WeakMap<SessionScope, Map<string, TaskWorkspace>>();
/** Task adapter callers reuse its captured namespace; legacy callers get a host-selected task. */
export const currentTaskWorkspace = (store: StoreApi): TaskWorkspace => {
    const scope = captureSessionScope(store);
    assertWorkspaceOwner(store, scope);
    if (store.codeExecution) return store.codeExecution.workspace;
    const taskId = store.executionContext?.lease.runId ?? store.getState().activeTurn?.runId ?? 'interactive';
    const tasks = workspaces.get(scope) ?? new Map<string, TaskWorkspace>();
    let workspace = tasks.get(taskId);
    if (!workspace) {
        workspace = createTaskWorkspace(store, taskId, { allowedPrefixes: ['/workspace/'], allowedPaths: ['/dataset/cleaned.csv'] });
        tasks.set(taskId, workspace); workspaces.set(scope, tasks);
        registerSessionResource(scope, () => { tasks.clear(); workspaces.delete(scope); });
    }
    return workspace;
};
