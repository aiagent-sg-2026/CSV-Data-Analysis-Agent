// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { StoreApi } from '../services/agent/types';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import { captureCsvSource } from '../services/data/immutableCsvSource';
import { assertLegacyBoundaryAllowed } from '../services/agent/structureRepairConfirmation';
import { inspectInitialHeaderAlignment } from '../services/agent/runtime/pi/piHeaderAlignmentGate';
import { buildReportIntakeIr } from '../services/data/reportCsvIntake';
import { parseCsvTextWithDetection } from '../services/data/csvDialectDetector';
import { assertCsvScanPublicationAllowed, bindCsvSourceScan, cancelCsvSourceScan, requireCurrentCsvSourceScan,
    resumeCsvSourceScan, scanCsvSourceForImport, scannedCsvSourceMetadata } from '../services/data/csvSourceScan';

const setup = () => {
    let state = { sessionId: crypto.randomUUID() } as ReturnType<StoreApi['getState']>;
    const store: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    return store;
};
const until = async (test: () => boolean) => {
    for (let i = 0; i < 500 && !test(); i += 1) await new Promise(resolve => setTimeout(resolve, 2));
    expect(test()).toBe(true);
};
const attach = async (store: StoreApi, file: File) => {
    const metadata = await captureCsvSource(store, file);
    const parsed = parseCsvTextWithDetection(await file.text());
    const intake = buildReportIntakeIr(file.name, parsed.rawRows, parsed.detection);
    intake.diagnostics.headerShapeDrift = false;
    store.setState({ rawIntakeIr: intake, datasetBundle: { source: { inspection: metadata } } as never });
    return metadata;
};

describe('host-owned source scan and limited-negative gates', () => {
    it('genuinely scans and accepts ordinary large CSVs beyond the alignment sample', async () => {
        const store = setup(), file = new File(['key,value\n' + 'x,1\n'.repeat(10000)], 'ordinary.csv');
        try {
            const source = await attach(store, file);
            const result = await inspectInitialHeaderAlignment(store.getState().rawIntakeIr, source.sha256, store);
            expect(result).toMatchObject({ blocked: false, reasons: expect.arrayContaining(['full_source_parsing_complete_no_structural_signal', 'schema_coverage_bounded_heuristic']) });
            await expect(assertLegacyBoundaryAllowed(store)).resolves.toBeUndefined();
            expect(await requireCurrentCsvSourceScan(store)).toMatchObject({ status: 'completed_clean', rows: 10001, sha256: source.sha256 });
        } finally { beginSessionTransition(store); }
    });
    it.each(['ragged', 'repeated', 'compact', 'stacked_equal_width', 'case_repeat', 'equal_width_band'])('rejects actual retained %s evidence beyond initial previews even when drift is false', async kind => {
        const store = setup();
        const tail = kind === 'ragged' ? 'bad,row,extra\n' : kind === 'repeated' ? 'key,value\n' : kind === 'case_repeat' ? 'KEY,VALUE\nx,2\n' : kind === 'stacked_equal_width' ? 'product,price\ny,2\n' : kind === 'equal_width_band' ? 'Group,Group\nA,B\ny,2\n' : 'ID,G1,G2,G1,G2\nX,Y,X,Y\n1,2,3,4,5,6,7\n2,3,4,5,6,7,8\n';
        const file = new File(['key,value\n' + 'x,1\n'.repeat(8000) + tail], 'late.csv');
        try {
            const source = await attach(store, file);
            const result = await inspectInitialHeaderAlignment(store.getState().rawIntakeIr, source.sha256, store);
            expect(result.blocked).toBe(true);
            await expect(assertLegacyBoundaryAllowed(store)).rejects.toThrow();
            expect(store.getState().csvSourceScan?.status).toBe('completed_anomalies');
            expect(store.getState().csvSourceScan!.examples[0].row).toBe(8001);
            expect(store.getState().datasetBundle?.acceptedCommit).toBeUndefined();
        } finally { beginSessionTransition(store); }
    });
    it.each([{ gap: '', tail: '\n' }, { gap: '', tail: '\n3,4\n' }, { gap: '\n', tail: '' }])('allows safe blank evidence through both full-source gates: %s', async ({ gap, tail }) => {
        const store = setup(), file = new File(['a,b\n' + gap + '1,2\n'.repeat(2500) + tail], 'blanks.csv');
        try {
            const source = await attach(store, file);
            expect((await inspectInitialHeaderAlignment(store.getState().rawIntakeIr, source.sha256, store)).blocked).toBe(false);
            await expect(assertLegacyBoundaryAllowed(store)).resolves.toBeUndefined();
            expect((await requireCurrentCsvSourceScan(store)).counts.blank_record).toBe(1);
        } finally { beginSessionTransition(store); }
    });
    it('cancels and resumes the same retained source/version; stale and double actions cannot advance', async () => {
        const store = setup(), file = new File(['key,value\r\n' + '"x\r\ny",1\r\n'.repeat(50000)], 'resume.csv');
        try {
            let settled = false;
            const done = scanCsvSourceForImport(store, file).then(result => { settled = true; return result; });
            const view = store.getState().csvSourceScan!;
            cancelCsvSourceScan(store, view.scanId, view.sourceVersion);
            await until(() => store.getState().csvSourceScan?.status === 'cancelled');
            expect(settled).toBe(false);
            expect(() => assertCsvScanPublicationAllowed(store)).toThrow();
            expect(() => cancelCsvSourceScan(store, view.scanId, view.sourceVersion)).toThrow('scan_action_stale');
            expect(() => resumeCsvSourceScan(store, view.scanId, 'forged-version')).toThrow('scan_action_stale');
            const resumed = resumeCsvSourceScan(store, view.scanId, view.sourceVersion);
            expect(() => resumeCsvSourceScan(store, view.scanId, view.sourceVersion)).toThrow('scan_action_stale');
            await resumed;
            expect(await done).toMatchObject({ status: 'completed_clean', rows: 50001 });
            expect(store.getState().csvSourceScan).toMatchObject({ sourceVersion: view.sourceVersion, scanId: view.scanId });
            const metadata = scannedCsvSourceMetadata(store, file);
            store.setState({ datasetBundle: { source: { inspection: metadata } } as never });
            expect((await requireCurrentCsvSourceScan(store)).sha256).toBe(metadata.sha256);
            expect(() => resumeCsvSourceScan(store, view.scanId, view.sourceVersion)).toThrow('scan_action_stale');
        } finally { beginSessionTransition(store); }
    });
    it('rejects same-size changed source and UI-forged clean checkpoints', async () => {
        const store = setup(), original = new File(['a,b\n1,2\n'], 'same.csv');
        try {
            await scanCsvSourceForImport(store, original);
            const metadata = scannedCsvSourceMetadata(store, original);
            const changed = new File(['a,b\n1,3\n'], 'same.csv', { lastModified: original.lastModified });
            expect(changed.size).toBe(original.size);
            expect(() => bindCsvSourceScan(store, changed, metadata)).toThrow('scan_source_binding_mismatch');
            await scanCsvSourceForImport(store, changed);
            store.setState({ datasetBundle: { source: { inspection: metadata } } as never,
                csvSourceScan: { ...store.getState().csvSourceScan!, status: 'completed_clean', sha256: metadata.sha256 } });
            await expect(requireCurrentCsvSourceScan(store)).rejects.toThrow();
        } finally { beginSessionTransition(store); }
    });
    it('revokes a running/paused scan on source or session replacement, without late publication', async () => {
        const store = setup(), file = new File(['a,b\n' + 'x,1\n'.repeat(50000)], 'old.csv');
        const old = scanCsvSourceForImport(store, file);
        const previous = store.getState().csvSourceScan!;
        const fresh = scanCsvSourceForImport(store, new File(['a,b\n9,8\n'], 'new.csv'));
        await expect(old).rejects.toThrow('scan_source_replaced');
        expect(await fresh).toMatchObject({ status: 'completed_clean', rows: 2 });
        expect(() => resumeCsvSourceScan(store, previous.scanId, previous.sourceVersion)).toThrow('scan_action_stale');
        const paused = scanCsvSourceForImport(store, file);
        const view = store.getState().csvSourceScan!;
        cancelCsvSourceScan(store, view.scanId, view.sourceVersion);
        await until(() => store.getState().csvSourceScan?.status === 'cancelled');
        beginSessionTransition(store);
        await expect(paused).rejects.toThrow('scan_source_replaced');
        expect(store.getState().csvSourceScan).toBeNull();
        expect(() => resumeCsvSourceScan(store, view.scanId, view.sourceVersion)).toThrow('scan_action_stale');
    });
    it('keeps quoted fields larger than the dialect sample intact', async () => {
        const store = setup(), file = new File(['key,value\r\n"a,b\r\n' + 'c'.repeat(150000) + '",1\r\n'], 'quoted.csv');
        try {
            expect(await scanCsvSourceForImport(store, file)).toMatchObject({ status: 'completed_clean', rows: 2, expectedWidth: 2 });
            const source = await attach(store, file);
            bindCsvSourceScan(store, file, source);
        } finally { beginSessionTransition(store); }
    });
    it('a tiny DuckDB preview cannot stand in for a large original scan', async () => {
        const store = setup();
        const parsed = parseCsvTextWithDetection('a,b\n1,2\n');
        store.setState({ rawIntakeIr: buildReportIntakeIr('preview.csv', parsed.rawRows, parsed.detection),
            csvData: { fileName: 'preview.csv', data: [{ a: 1, b: 2 }], backing: { mode: 'duckdb_file', rowCount: 100000, sampleRowCount: 1 } } as never });
        try {
            expect((await inspectInitialHeaderAlignment(store.getState().rawIntakeIr, undefined, store)).blocked).toBe(true);
            await expect(assertLegacyBoundaryAllowed(store)).rejects.toThrow('scan_original_source_unavailable_reselect_original');
        } finally { beginSessionTransition(store); }
    });
    it('binds the scan dialect as well as complete source bytes', async () => {
        const store = setup(), file = new File(['a,b\n1,2\n'], 'dialect.csv');
        try {
            await scanCsvSourceForImport(store, file);
            const metadata = scannedCsvSourceMetadata(store, file);
            expect(() => bindCsvSourceScan(store, file, { ...metadata, dialect: { delimiter: ';', quoteChar: '"' } })).toThrow('scan_source_binding_mismatch');
        } finally { beginSessionTransition(store); }
    });
    it('returned results and UI checkpoints cannot mutate private scan authority', async () => {
        const store = setup(), file = new File(['a,b\n1,2\nbad\n'], 'anomalous.csv');
        try {
            const result = await scanCsvSourceForImport(store, file);
            const metadata = scannedCsvSourceMetadata(store, file);
            store.setState({ datasetBundle: { source: { inspection: metadata } } as never });
            result.status = 'completed_clean'; result.counts = {}; result.examples = [];
            store.setState({ csvSourceScan: { ...store.getState().csvSourceScan!, status: 'completed_clean', counts: {}, examples: [] } });
            expect((await requireCurrentCsvSourceScan(store)).status).toBe('completed_anomalies');
            expect(() => assertCsvScanPublicationAllowed(store)).toThrow('source_scan_requires_automatic_repair_or_resume');
            expect((await scanCsvSourceForImport(store, file)).status).toBe('completed_anomalies');
        } finally { beginSessionTransition(store); }
    });
    it('does not accept a clean UI projection with no retained original bytes', async () => {
        const store = setup();
        store.setState({ datasetBundle: { source: { inspection: { sourceId: 'missing', sha256: 'a'.repeat(64), byteSize: 8 } } } as never,
            csvSourceScan: { status: 'completed_clean', sha256: 'a'.repeat(64) } as never });
        await expect(requireCurrentCsvSourceScan(store)).rejects.toThrow('scan_original_source_unavailable_reselect_original');
        beginSessionTransition(store);
    });
});
