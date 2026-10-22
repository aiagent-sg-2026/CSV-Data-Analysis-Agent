// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { executeWorkspaceFileAction } from '../services/agent/execution/executorWorkspaceActions';
import { currentTaskWorkspace } from '../services/agent/taskWorkspace';
import { createWorkspaceToolManifests } from '../services/agent/tools/manifests/workspaceToolManifests';
import { WORKSPACE_PATH_RULES, WORKSPACE_READABLE_ROOTS } from '../services/agent/workspaceFileUtils';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import type { AppStore } from '../store/useAppStore';
import type { StoreApi } from '../services/agent/types';
import type { AiAction, ToolName } from '../types';

const makeStore = (workspaceFiles: Record<string, string> = {}) => {
    let state = { sessionId: 'discoverability-session', settings: { provider: 'default', language: 'English', complexModel: 'mock' },
        csvData: { fileName: 'hdb.csv', data: [{ town: 'ANG MO KIO', price: 250000 }], metadataRows: [], summaryRows: [] },
        columnProfiles: [], analysisCards: [], chatHistory: [], agentEvents: [], agentToolLogs: [], telemetryEvents: [],
        workspaceFiles, workspaceActionHistory: [], queryHistory: [], dataQualityIssues: [],
        logAgentToolUsage: vi.fn(), regenerateAnalyses: vi.fn(), currentDatasetId: 'hdb-dataset',
    } as unknown as AppStore;
    state.rawCsvData = state.csvData;
    const app: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    state.datasetBundle = createSingleTableDatasetBundle({ datasetId: 'hdb', sourceFingerprint: 'hdb', file: new File(['town,price\nANG MO KIO,250000'], 'hdb.csv'), data: state.csvData! });
    return app;
};
const action = (toolName: ToolName, args: Record<string, unknown>): AiAction => ({ type: 'tool_call', toolName, args });
const run = (app: StoreApi, toolName: ToolName, args: Record<string, unknown>) => executeWorkspaceFileAction(action(toolName, args), app);
const listed = async (app: StoreApi, args: Record<string, unknown>) =>
    JSON.parse((await run(app, 'workspace.list', args))!.output!) as { path: string; files: { path: string; pathType: string }[]; pathRules?: string };

describe('workspace path discoverability', () => {
    it('lists the allowed roots at "/" instead of an empty listing', async () => {
        // A stored skill path exists, but the root listing exposes only readable roots.
        const app = makeStore({ '/skills/private/SKILL.md': 'skill body' });
        for (const args of [{}, { path: '/' }]) {
            const root = await listed(app, args);
            const directories = root.files.filter(entry => entry.pathType === 'directory').map(entry => entry.path);
            expect(directories).toEqual(expect.arrayContaining(['/dataset', '/workspace', '/cleaning']));
            expect(directories.every(path => WORKSPACE_READABLE_ROOTS.includes(path))).toBe(true);
            expect(directories).not.toContain('/skills');
            expect(root.pathRules).toBe(WORKSPACE_PATH_RULES);
        }
        const dataset = await listed(app, { path: '/dataset' });
        expect(dataset.files.map(entry => entry.path)).toEqual(expect.arrayContaining(['/dataset/cleaned.csv', '/dataset/raw.csv']));
        // One trailing slash on a directory scope is tolerated rather than denied or silently empty.
        expect((await listed(app, { path: '/dataset/' })).files).toEqual(dataset.files);
    });

    it('searches every readable root when path is omitted', async () => {
        const app = makeStore({ '/skills/private/SKILL.md': 'ANG MO KIO skill' });
        const matches = JSON.parse((await run(app, 'workspace.search', { query: 'ANG MO KIO' }))!.output!) as { path: string }[];
        expect(matches.map(match => match.path)).toContain('/dataset/cleaned.csv');
        expect(matches.some(match => match.path.startsWith('/skills/'))).toBe(false);
        const grep = JSON.parse((await run(app, 'workspace.grep', { query: 'ANG MO KIO', path: '/' }))!.output!) as { matches: { path: string }[] };
        expect(grep.matches.some(match => match.path.startsWith('/skills/'))).toBe(false);
    });

    it('accepts the documented writable example path on the first attempt', async () => {
        const app = makeStore();
        const result = await run(app, 'workspace.write', { path: '/workspace/analysis.js', content: 'return 1;', expectedRevision: 0 });
        expect(result?.payload?.workspace).toMatchObject({ artifact: { path: '/workspace/analysis.js', revision: 1 } });
    });

    it('names the allowed roots in tool schemas and path denials', async () => {
        const manifests = new Map(createWorkspaceToolManifests().map(manifest => [manifest.name, manifest]));
        expect(manifests.get('workspace.list')!.description).toContain(WORKSPACE_PATH_RULES);
        expect(WORKSPACE_PATH_RULES).toContain('Readable roots: /session, /intake, /cleaning, /analysis, /chat, /context, /logs, /dataset, /workspace.');
        const pathDescription = (name: ToolName) => (manifests.get(name)!.inputSchema as { properties: { path: { description?: string } } }).properties.path.description;
        for (const name of ['workspace.write', 'workspace.append', 'workspace.replace'] as const) {
            expect(pathDescription(name)).toContain('/workspace/');
            expect(pathDescription(name)).toContain('/dataset/cleaned.csv');
        }
        expect(pathDescription('workspace.search')).toContain('Omit to search every readable root');
        expect(pathDescription('workspace.list')).toContain('use / to list the readable roots');

        const app = makeStore();
        await expect(run(app, 'workspace.list', { path: '.' })).rejects.toThrow(`workspace_path_denied: ".". ${WORKSPACE_PATH_RULES}`);
        await expect(run(app, 'workspace.write', { path: 'analysis.js', content: 'x', expectedRevision: 0 })).rejects.toThrow(WORKSPACE_PATH_RULES);
        await expect(run(app, 'workspace.write', { path: '/analysis/x.js', content: 'x', expectedRevision: 0 })).rejects.toThrow(/^workspace_path_denied: "\/analysis\/x\.js"\. Use absolute paths/);
        await expect(run(app, 'workspace.read', { path: '/etc/passwd' })).rejects.toThrow(`Workspace path not allowed: "/etc/passwd". ${WORKSPACE_PATH_RULES}`);
    });
});

describe('workspace path security boundaries still hold', () => {
    const malformed = ['/workspace/../secret', '/workspace/./a', '/workspace//a', '/workspace/%2e%2e/secret', '/workspace/a\u0000b',
        '/workspace/a\nb', ' /workspace/a', '/workspace/a\\b', '/workspace/a?x', '/workspace/a#x', 'workspace/a', '.', '..'];

    it('rejects traversal, encoding and control characters for read, list, search and write', async () => {
        const app = makeStore();
        for (const path of malformed) {
            await expect(run(app, 'workspace.list', { path })).rejects.toThrow('workspace_path_denied');
            await expect(run(app, 'workspace.search', { path, query: 'x' })).rejects.toThrow('workspace_path_denied');
            await expect(run(app, 'workspace.read', { path })).rejects.toThrow('workspace_path_denied');
            await expect(run(app, 'workspace.write', { path, content: 'x', expectedRevision: 0 })).rejects.toThrow('workspace_path_denied');
        }
        expect(currentTaskWorkspace(app).list()).toEqual([]);
    });

    it('keeps root, host, metadata, raw dataset and cross-task paths out of reach', async () => {
        const app = makeStore({ '/skills/private/SKILL.md': 'skill body' });
        // Listing "/" is a directory view only; it never grants reading "/" or unlisted prefixes.
        await expect(run(app, 'workspace.read', { path: '/' })).rejects.toThrow('Workspace path not allowed');
        await expect(run(app, 'workspace.head', { path: '/' })).rejects.toThrow('Workspace path not allowed');
        await expect(run(app, 'workspace.search', { path: '/skills', query: 'skill' })).rejects.toThrow('Workspace path not allowed');
        await expect(run(app, 'workspace.read', { path: '/skills/private/SKILL.md' })).rejects.toThrow('Workspace path not allowed');
        for (const path of ['/', '/workspace', '/workspace/', '/etc/passwd', '/dataset/raw.csv', '/dataset/other.csv',
            '/workspace/task-artifacts/forged.json', '/workspace/tasks/other-task/private.js', '/analysis/x.js']) {
            await expect(run(app, 'workspace.write', { path, content: 'x', expectedRevision: 0 })).rejects.toThrow(/^(workspace_path_denied|Write permission denied|Workspace path not allowed): /);
        }
        expect(currentTaskWorkspace(app).list()).toEqual([]);
        expect(Object.keys(app.getState().workspaceFiles)).toEqual(['/skills/private/SKILL.md']);
    });
});
