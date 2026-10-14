// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWorkspaceFileAction } from '../services/agent/execution/executorWorkspaceActions';
import { isWorkspaceWritablePath } from '../services/agent/workspaceFileUtils';
import { currentTaskWorkspace } from '../services/agent/taskWorkspace';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import { buildPersistedAppState } from '../services/persistence/persistedAppState';
import type { AppStore } from '../store/useAppStore';
import type { StoreApi } from '../services/agent/types';
import type { AiAction, ToolName } from '../types';
const makeStore = () => {
    let state = { sessionId: 'staging-session', settings: { provider: 'default', language: 'English', complexModel: 'mock' },
        csvData: { fileName: 'test.csv', data: [{ name: 'original', amount: 10 }], metadataRows: [], summaryRows: [] },
        columnProfiles: [], analysisCards: [], chatHistory: [], agentEvents: [], agentToolLogs: [], telemetryEvents: [],
        workspaceFiles: {}, workspaceActionHistory: [], queryHistory: [], dataQualityIssues: [],
        logAgentToolUsage: vi.fn(), regenerateAnalyses: vi.fn(), currentDatasetId: 'test-dataset',
    } as unknown as AppStore;
    state.rawCsvData = state.csvData;
    const app: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    state.datasetBundle = createSingleTableDatasetBundle({ datasetId: 'test', sourceFingerprint: 'test', file: new File(['name,amount\noriginal,10'], 'test.csv'), data: state.csvData! });
    return app;
};
const action = (toolName: ToolName, args: Record<string, unknown>): AiAction => ({ type: 'tool_call', toolName, args });
afterEach(() => vi.restoreAllMocks());
describe('real workspace dispatcher staging', () => {
    it('stages a cleaned CSV without changing originals, accepted tables, queries or saved rows', async () => {
        const app = makeStore();
        const before = app.getState();
        const result = await executeWorkspaceFileAction(action('workspace.write', { path: '/dataset/cleaned.csv', content: 'name,amount\nchanged,999', expectedRevision: 0 }), app);
        expect(result?.payload?.workspace).toMatchObject({ affectsCleanedDataset: false, stagedCandidate: { status: 'staged', acceptedDataChanged: false, validation: 'pending' } });
        expect(app.getState().csvData).toBe(before.csvData);
        expect(app.getState().rawCsvData).toBe(before.rawCsvData);
        expect(app.getState().datasetBundle).toBe(before.datasetBundle);
        expect(app.getState().activeDataQuery).toBe(before.activeDataQuery);
        expect(app.getState().regenerateAnalyses).not.toHaveBeenCalled();
        const metadataPath = Object.keys(app.getState().workspaceFiles).find(path => path.startsWith('/workspace/task-artifacts/'))!;
        expect(isWorkspaceWritablePath(metadataPath)).toBe(false);
        expect((await executeWorkspaceFileAction(action('workspace.read', { path: metadataPath }), app))?.output).toContain('Transient task files');
        const read = await executeWorkspaceFileAction(action('workspace.read', { path: '/dataset/cleaned.csv' }), app);
        expect(read?.output).toContain('changed,999');
        expect(read?.payload?.workspace).toMatchObject({ revision: 1 });
        expect(JSON.stringify(buildPersistedAppState(app.getState()).workspaceFiles)).not.toContain('changed,999');
        await expect(executeWorkspaceFileAction(action('workspace.append', { path: '/dataset/cleaned.csv', content: '\nextra,1', expectedRevision: 0 }), app)).rejects.toThrow('workspace_conflict');
    });
    it('reads actual positional records through the existing workspace tool', async () => {
        const app = makeStore();
        const metadata = await captureCsvSource(app, new File(['name,amount,amount\na,1,2\nb,3'], 'source.csv'));
        app.getState().datasetBundle!.source.inspection = metadata;
        const result = await executeWorkspaceFileAction(action('workspace.read', { path: '/intake/source-records.json', startRow: 2, rowCount: 1 }), app);
        expect(result?.payload?.sourceInspection).toMatchObject({ complete: true, records: [{ row: 2, cells: [{ value: 'b' }, { value: '3' }] }] });
    });
    it('rejects a late hash completion without writing catch/history into the replacement session', async () => {
        const app = makeStore();
        let resolve!: (value: ArrayBuffer) => void;
        let entered!: () => void;
        const waiting = new Promise<void>(done => { entered = done; });
        vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => { entered(); return new Promise(done => { resolve = done; }); });
        const late = executeWorkspaceFileAction(action('workspace.write', { path: '/workspace/repair.js', content: 'return 1', expectedRevision: 0 }), app);
        await waiting;
        beginSessionTransition(app);
        app.setState({ sessionId: 'replacement', workspaceFiles: {}, workspaceActionHistory: [], chatHistory: [] });
        const replacement = app.getState();
        resolve(new ArrayBuffer(32));
        await expect(late).rejects.toThrow('scope_revoked');
        expect(app.getState()).toBe(replacement);
        expect(currentTaskWorkspace(app).revision('/workspace/repair.js')).toBe(0);
    });
    it('rejects traversal and missing revisions at the execution boundary', async () => {
        const app = makeStore();
        for (const path of ['/workspace/../secret', '/workspace/%2e%2e/secret', '/workspace/a\\b', '/workspace/a?x']) {
            await expect(executeWorkspaceFileAction(action('workspace.write', { path, content: 'x', expectedRevision: 0 }), app)).rejects.toThrow('workspace_path_denied');
        }
        await expect(executeWorkspaceFileAction(action('workspace.write', { path: '/workspace/a', content: 'x' }), app)).rejects.toThrow('workspace_revision_required');
    });
});

it('checks the original SHA-256 even when legacy parsed rows and source metadata match', async () => {
    const { verifyDatasetBundleSource } = await import('../services/data/datasetBundle');
    const app = makeStore();
    const original = new File(['name,amount\noriginal,10'], 'test.csv');
    const inspection = await captureCsvSource(app, original);
    const bundle = app.getState().datasetBundle!;
    const { buildDatasetFingerprint } = await import('../utils/datasetId');
    bundle.source = { ...bundle.source, inspection, fingerprint: buildDatasetFingerprint('test.csv', app.getState().csvData!.data) };
    expect(await verifyDatasetBundleSource({ bundle, file: original, parsedData: app.getState().csvData! })).toMatchObject({ matches: true });
    const changed = new File(['name,amount\noriginal,11'], 'test.csv');
    expect(await verifyDatasetBundleSource({ bundle, file: changed, parsedData: app.getState().csvData! })).toMatchObject({ matches: false, reasonCode: 'source_sha256_mismatch' });
});

it('returns bounded program content and diffs immutable revisions through the real dispatcher', async () => {
    const app = makeStore();
    await executeWorkspaceFileAction(action('workspace.write', { path: '/workspace/repair.js', content: 'return 1;', expectedRevision: 0 }), app);
    await executeWorkspaceFileAction(action('workspace.replace', { path: '/workspace/repair.js', oldText: '1', newText: '2', expectedRevision: 1 }), app);
    const read = await executeWorkspaceFileAction(action('workspace.read', { path: '/workspace/repair.js', revision: 1, startOffset: 7, limit: 2 }), app);
    expect(read?.payload?.workspace).toMatchObject({ revision: 1, content: '1;', complete: true, startOffset: 7 });
    const diff = await executeWorkspaceFileAction(action('workspace.diff', { path: '/workspace/repair.js', compareRevision: 1, revision: 2 }), app);
    expect(diff?.payload?.workspace).toMatchObject({ beforeRevision: 1, afterRevision: 2 });
    expect(diff?.output).toContain('return 1;');
    expect(diff?.output).toContain('return 2;');
    expect(app.getState().workspaceActionHistory.some(entry => entry.output?.includes('return 1;'))).toBe(false);
});
