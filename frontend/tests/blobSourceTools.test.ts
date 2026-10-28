// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { executeWorkspaceFileAction } from '../services/agent/execution/executorWorkspaceActions';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import { bindRecoverySource, captureRecoverySource, readSourceBytesBounded } from '../services/data/immutableCsvSource';
import { cancelCsvSourceScan, resumeCsvSourceScan, scanCsvSourceForImport, scannedCsvSourceMetadata } from '../services/data/csvSourceScan';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import type { StoreApi } from '../services/agent/types';
import type { AppStore } from '../store/useAppStore';

const setup = () => {
    let state = { sessionId: crypto.randomUUID(), settings: { language: 'English', provider: 'default' },
        csvData: { fileName: 'source.csv', data: [{ key: 'preview', value: 1 }] },
        columnProfiles: [], analysisCards: [], chatHistory: [], agentEvents: [], agentToolLogs: [], telemetryEvents: [],
        workspaceFiles: {}, workspaceActionHistory: [], queryHistory: [], dataQualityIssues: [], logAgentToolUsage: vi.fn(),
    } as unknown as AppStore;
    const store: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    return store;
};
const until = async (test: () => boolean) => {
    for (let i = 0; i < 2000 && !test(); i += 1) await new Promise(resolve => setTimeout(resolve, 2));
    expect(test()).toBe(true);
};
const attach = (store: StoreApi, file: File) => {
    const metadata = scannedCsvSourceMetadata(store, file);
    const bundle = createSingleTableDatasetBundle({ datasetId: 'source', sourceFingerprint: metadata.sha256, file, data: store.getState().csvData! });
    bundle.source.inspection = metadata;
    store.setState({ datasetBundle: bundle });
    return metadata;
};
const dispatch = (store: StoreApi, path: string, args: Record<string, number>) => executeWorkspaceFileAction({ type: 'tool_call', toolName: 'workspace.read', args: { path, ...args } }, store);

describe('actual Blob-backed immutable source tools', () => {
    it('reads >25 MiB through tool dispatch after actual cancellation/resume without whole-file reads', async () => {
        const store = setup();
        const row = `${'x'.repeat(1000)},1\r\n`;
        const prefix = 'key,value\r\n' + row.repeat(27000);
        const file = new File([prefix, '"last\r\nrecord",2\r\n'], 'large.csv');
        expect(file.size).toBeGreaterThan(25 * 1024 * 1024);
        let peakRead = 0;
        const guard = (blob: Blob): Blob => {
            const read = blob.arrayBuffer.bind(blob), slice = blob.slice.bind(blob);
            blob.arrayBuffer = () => { peakRead = Math.max(peakRead, blob.size); expect(blob.size).toBeLessThanOrEqual(65536); return read(); };
            blob.slice = (...args) => guard(slice(...args));
            return blob;
        };
        guard(file);
        try {
            const pending = scanCsvSourceForImport(store, file);
            await until(() => (store.getState().csvSourceScan?.bytesRead ?? 0) > 0);
            const view = store.getState().csvSourceScan!;
            cancelCsvSourceScan(store, view.scanId, view.sourceVersion);
            await until(() => store.getState().csvSourceScan?.status === 'cancelled');
            expect(store.getState().csvSourceScan?.sha256).toBeNull();
            await resumeCsvSourceScan(store, view.scanId, view.sourceVersion);
            const completed = await pending;
            expect(completed).toMatchObject({ status: 'completed_clean', rows: 27002 });
            const source = attach(store, file);
            const records = (await dispatch(store, '/intake/source-records.json', { startRow: 25001, rowCount: 1 }))!.payload!.sourceInspection as any;
            expect(records.records[0]).toMatchObject({ row: 25001, startLine: 25002, rawText: row, cells: [{ value: 'x'.repeat(1000) }, { value: '1' }] });
            const last = (await dispatch(store, '/intake/source-records.json', { startRow: 27001, rowCount: 1 }))!.payload!.sourceInspection as any;
            expect(last).toMatchObject({ complete: true, nextRow: 27002, records: [{ startLine: 27002, endLine: 27003, cells: [{ value: 'last\r\nrecord' }, { value: '2' }] }] });
            const bytes = (await dispatch(store, '/dataset/source.bytes', { byteOffset: prefix.length, byteLength: 30 }))!.payload!.sourceInspection as any;
            expect(new TextDecoder().decode(new Uint8Array(bytes.bytes))).toBe('"last\r\nrecord",2\r\n');
            expect(completed.parsingCoverage).toBe('complete');
            expect(peakRead).toBeLessThanOrEqual(65536);
            expect(() => captureRecoverySource(store, source.sourceId)).toThrow('recovery_source_capacity');
            beginSessionTransition(store);
            await expect(readSourceBytesBounded(store, source.sourceId, 0, 10)).rejects.toThrow('source_unavailable');
            // Metadata alone cannot resurrect access. Explicit recovery verifies the complete
            // large File through bounded slices; synchronous byte capture remains unavailable.
            await bindRecoverySource(store,file,source);
            expect((await dispatch(store,'/intake/source-records.json',{startRow:27001,rowCount:1}))!.payload).toBeDefined();
            expect(()=>captureRecoverySource(store,source.sourceId)).toThrow('recovery_source_capacity');
            expect(peakRead).toBeLessThanOrEqual(65536);
            beginSessionTransition(store);
            await scanCsvSourceForImport(store, file);
            const rebound = attach(store, file);
            expect(rebound.sourceId).not.toBe(source.sourceId);
            expect(rebound.sha256).toBe(source.sha256);
            expect((await dispatch(store, '/intake/source-records.json', { startRow: 27001, rowCount: 1 }))!.payload).toBeDefined();
        } finally { beginSessionTransition(store); }
    }, 30000);

    it('rejects oversized recovery before reading and fences source replacement during reattachment',async()=>{
        const store=setup(),file=new File(['key,value\nx,1\n'],'source.csv');
        try{
            await scanCsvSourceForImport(store,file);const source=attach(store,file);
            const huge=new File([],'huge.csv');Object.defineProperty(huge,'size',{value:100*1024*1024+1});
            const full=vi.spyOn(huge,'arrayBuffer'),slice=vi.spyOn(huge,'slice');
            await expect(bindRecoverySource(store,huge,{...source,byteSize:huge.size})).rejects.toThrow('recovery_source_capacity');
            expect(full).not.toHaveBeenCalled();expect(slice).not.toHaveBeenCalled();
            let release!:(bytes:ArrayBuffer)=>void;
            const bytes=await file.arrayBuffer();vi.spyOn(file,'arrayBuffer').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
            const pending=bindRecoverySource(store,file,source);await until(()=>!!release);
            store.setState({datasetBundle:{...store.getState().datasetBundle!,source:{...store.getState().datasetBundle!.source,inspection:{...source,byteSize:source.byteSize+1}}}});
            release(bytes);await expect(pending).rejects.toThrow('input_version_changed');
        }finally{beginSessionTransition(store);vi.restoreAllMocks();}
    });

    it('enforces Blob record/output quotas without skipping an oversized record', async () => {
        const store = setup(), file = new File(['key,value\n' + 'x'.repeat(70000) + ',1\nshort,2\n'], 'wide-record.csv');
        try {
            await scanCsvSourceForImport(store, file);
            attach(store, file);
            const result = (await dispatch(store, '/intake/source-records.json', { startRow: 1, rowCount: 2 }))!.payload!.sourceInspection;
            expect(result).toMatchObject({ startRow: 1, nextRow: 1, records: [], blockedReason: 'record_exceeds_read_quota_use_byte_ranges' });
            expect((await dispatch(store, '/dataset/source.bytes', { byteOffset: 10, byteLength: 10 }))!.payload!.sourceInspection).toMatchObject({ bytes: Array(10).fill(120) });
            await expect(dispatch(store, '/intake/source-records.json', { startRow: 0, rowCount: 51 })).rejects.toThrow('source_range_invalid');
            await expect(dispatch(store, '/dataset/source.bytes', { byteOffset: 0, byteLength: 65537 })).rejects.toThrow('source_range_invalid');
        } finally { beginSessionTransition(store); }
    });

    it('revokes an in-flight range on source replacement, preserving the newer accepted state', async () => {
        const store = setup(), file = new File(['key,value\nx,1\n'], 'old.csv');
        await scanCsvSourceForImport(store, file);
        attach(store, file);
        let release!: (buffer: ArrayBuffer) => void;
        const slice = file.slice.bind(file);
        file.slice = (...args) => {
            const blob = slice(...args);
            blob.arrayBuffer = () => new Promise(resolve => { release = resolve; });
            return blob;
        };
        const pending = dispatch(store, '/dataset/source.bytes', { byteOffset: 0, byteLength: 2 });
        await until(() => !!release);
        await scanCsvSourceForImport(store, new File(['key,value\ny,2\n'], 'new.csv'));
        const newer = { ...store.getState().datasetBundle!, acceptedCommit: { id: 'keep' } } as never;
        store.setState({ datasetBundle: newer, currentDatasetId: 'newer' });
        const history = store.getState().workspaceActionHistory, chat = store.getState().chatHistory;
        release(new Uint8Array([107, 101]).buffer);
        await expect(pending).rejects.toThrow();
        expect(store.getState().workspaceActionHistory).toBe(history);
        expect(store.getState().chatHistory).toBe(chat);
        expect(store.getState().datasetBundle).toBe(newer);
        expect(store.getState().currentDatasetId).toBe('newer');
        beginSessionTransition(store);
    });
});
