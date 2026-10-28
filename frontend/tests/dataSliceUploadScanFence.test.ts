import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataSlice } from '../store/slices/dataSlice';
import { createTestSettings } from './testSettings';
import { cancelCsvSourceScan, scanCsvSourceForImport } from '../services/data/csvSourceScan';
import type { StoreApi } from '../services/agent/types';

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('../services/agent/orchestration/fileOrchestrator', () => ({ orchestrateFileUpload: upload }));
const setup = () => {
    let state: Record<string, any> = { sessionId: crypto.randomUUID(), csvData: null, datasetBundle: null,
        settings: createTestSettings(), progressMessages: [], activeExecution: null };
    const published: Record<string, any>[] = [];
    const setState = (patch: any) => {
        const update = typeof patch === 'function' ? patch(state) : patch;
        published.push(update); state = { ...state, ...update };
    };
    const getState = () => state;
    state = { ...state, ...createDataSlice(setState as never, getState as never, {} as never) };
    return { getState, setState, published };
};
beforeEach(() => upload.mockReset());

describe('upload scan publication boundary', () => {
    it('executes the exact source fence synchronously before installing canonical state', async () => {
        const store = setup(), candidate = { fileName: 'old.csv', data: [{ a: 1 }] };
        upload.mockImplementation(() => (async function* () {
            yield { type: 'state', assertCurrent: () => { throw new Error('scan_source_replaced'); },
                payload: { currentView: 'analysis_dashboard', csvData: candidate, canonicalCsvData: candidate } };
        })());
        await store.getState().handleFileUpload(new File(['a\n1\n'], 'old.csv'));
        expect(store.published.some(update => update.canonicalCsvData === candidate)).toBe(false);
        expect(store.getState().csvData).toBeNull();
    });
    it('a superseded same-epoch upload cannot publish or clear a newer imported source on late failure', async () => {
        const store = setup();
        let release!: () => void;
        const fresh = { fileName: 'new.csv', data: [{ a: 2 }] };
        upload.mockImplementation((file: File) => (async function* () {
            if (file.name === 'old.csv') {
                await new Promise<void>(resolve => { release = resolve; });
                throw new Error('late old source failure');
            }
            yield { type: 'state', payload: { currentView: 'analysis_dashboard', csvData: fresh, canonicalCsvData: fresh } };
        })());
        const first = store.getState().handleFileUpload(new File(['a\n1\n'], 'old.csv'));
        for (let i = 0; i < 100 && !release; i += 1) await new Promise(resolve => setTimeout(resolve, 1));
        expect(release).toBeTypeOf('function');
        await store.getState().handleFileUpload(new File(['a\n2\n'], 'new.csv'));
        release(); await first;
        expect(store.getState().csvData).toBe(fresh);
        expect(store.getState().canonicalCsvData).toBe(fresh);
        expect(store.getState().progressMessages).toEqual([]);
    });
    it('new upload intent immediately revokes a paused scan instead of retaining an old waiter', async () => {
        const store = setup();
        const pending = scanCsvSourceForImport(store as unknown as StoreApi, new File(['a,b\n' + 'x,1\n'.repeat(10000)], 'paused.csv'));
        const old = store.getState().csvSourceScan;
        cancelCsvSourceScan(store as unknown as StoreApi, old.scanId, old.sourceVersion);
        upload.mockImplementation(() => (async function* () { yield { type: 'progress', message: 'new source' }; })());
        const rejected = expect(pending).rejects.toThrow('scan_source_replaced');
        await store.getState().handleFileUpload(new File(['a,b\n2,3\n'], 'new.csv'));
        await rejected;
        expect(store.getState().csvSourceScan).toBeNull();
    });
});
