import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import { captureSessionScope, beginSessionTransition } from '../services/session/sessionOwnership';
const saveReport = vi.hoisted(() => vi.fn(async (_record: unknown) => undefined));
vi.mock('../services/storageService', () => ({ saveReport, CURRENT_SESSION_KEY: 'current_session' }));
import { persistCurrentAppSessionSnapshot, queueSessionWrite, drainSessionPersistence } from '../services/persistence/currentSessionPersistence';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};
const makeStore = () => {
    let state = { sessionId: 'old', csvData: { fileName: 'synthetic.csv', data: [{ Amount: 1 }] },
        currentDatasetId: 'synthetic', workspaceFiles: {}, sessionCreatedAt: new Date() } as unknown as ReturnType<StoreApi['getState']>;
    return { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } } satisfies StoreApi;
};

describe('session persistence barrier', () => {
    beforeEach(async () => { await drainSessionPersistence(); saveReport.mockReset(); saveReport.mockResolvedValue(undefined); });
    it('drops an old queued snapshot before it starts writing', async () => {
        const blocker = deferred();
        const first = queueSessionWrite(() => blocker.promise);
        const store = makeStore();
        const old = persistCurrentAppSessionSnapshot(store.getState(), { store, scope: captureSessionScope(store) });
        beginSessionTransition(store);
        blocker.resolve();
        await first;
        expect(await old).toBe(false);
        expect(saveReport).not.toHaveBeenCalled();
    });
    it('waits for a started transaction and never lets its alias overwrite the new session', async () => {
        const blocker = deferred();
        const started = deferred();
        saveReport.mockImplementationOnce(async () => { started.resolve(); await blocker.promise; });
        const store = makeStore();
        const old = persistCurrentAppSessionSnapshot(store.getState(), { store, scope: captureSessionScope(store) });
        await started.promise;
        beginSessionTransition(store);
        let drained = false;
        const barrier = drainSessionPersistence().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        blocker.resolve();
        await barrier;
        expect(await old).toBe(false);
        store.setState({ sessionId: 'new' });
        expect(await persistCurrentAppSessionSnapshot(store.getState(), { store })).toBe(true);
        expect(saveReport.mock.calls.map(([record]) => (record as { id: string }).id)).toEqual(['old', 'new', 'current_session']);
        expect(saveReport.mock.calls.at(-1)?.[0]).toMatchObject({ appState: { sessionId: 'new' } });
    });
    it('persists a metadata-only History fork so reload retains its exact accepted reference',async()=>{
        const store=makeStore();store.setState({csvData:null,datasetBundle:{source:{fileName:'synthetic.csv'},tables:[],transformationPrograms:[],
            acceptedCommit:{sessionId:'origin',commitId:'accepted-commit',revision:2}}} as never);
        expect(await persistCurrentAppSessionSnapshot(store.getState(),{store})).toBe(true);
        expect(saveReport.mock.calls).toHaveLength(2);
        expect(saveReport.mock.calls[0][0]).toMatchObject({filename:'synthetic.csv',appState:{csvData:null,datasetCommitBindingStatus:'awaiting_source',
            datasetBundle:{acceptedCommit:{sessionId:'origin',commitId:'accepted-commit',revision:2}}}});
    });
});
