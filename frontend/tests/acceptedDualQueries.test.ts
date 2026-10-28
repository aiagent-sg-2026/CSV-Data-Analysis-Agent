// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAcceptedTablesBinding, prepareOrdinaryDatasetBinding, prepareAcceptedSpillBinding, retireInactiveAcceptedTables, executeManagedDataQuery, executeRawSqlQuery, disposeDuckDbQueryEngine } from '../services/duckdb/queryEngine';
import type { DatasetCommitMarker } from '../types/datasetCommit';
import type { CandidateOutput } from '../services/data/candidateContract';
import { acceptedQueryOwner } from '../services/duckdb/acceptedQueryOwner';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import type { StoreApi } from '../services/agent/types';
const io = vi.hoisted(() => ({ clients: [] as any[], fail: false, wait: null as Promise<void> | null }));
vi.mock('../services/workers/duckDbWorkerClient', () => {
    let current: any = { retireSession() {} };
    return {
    get duckDbWorkerClient() { return current; },
    exchangeDuckDbWorkerClient(next: any) { const previous = current; current = next; return previous; },
    DuckDbWorkerClient: class {
        id = io.clients.length; retired = false; payload: any;
        constructor() { io.clients.push(this); }
        async initDuckDb() {}
        async loadFileDataset(payload: any) { this.payload = payload; if (io.fail && this.id % 2) throw new Error('second_table_failed'); return { rowCount: 1, preview: [{ Id: 'one', Amount: 4 }] }; }
        async loadCleanDataset(payload: any) { this.payload = payload; if (io.fail) throw new Error('ordinary_load_failed'); }
        async executeRawQuery(payload: any) { return this.executeCompiledQuery(payload); }
        async executeCompiledQuery(payload: any) { await io.wait; return { rows: [{ worker: this.id, sql: payload.sql }], selectedColumns: [], returnedRows: 1, totalMatchedRows: 1, truncated: false, durationMs: 1, appliedLimit: 500, appliedOrderBy: [] }; }
        retireSession() { this.retired = true; }
    },
}; });
afterEach(async () => { io.wait = null; io.fail = false; await disposeDuckDbQueryEngine(); io.clients.length = 0; });
const fixture = () => {
    const output = { schemaVersion: 1, complete: true, tables: [
        { name: 'entities', rows: [{ Id: 'one', Amount: 4 }], schema: [{ name: 'Id', dataType: 'string', nullable: false }, { name: 'Amount', dataType: 'number', nullable: false }], rowCount: 1 },
        { name: 'metrics', rows: [{ Id: 'one', Value: null }], schema: [{ name: 'Id', dataType: 'string', nullable: false }, { name: 'Value', dataType: 'number', nullable: true }], rowCount: 1 },
    ], relationships: [], excludedRows: [] } as unknown as CandidateOutput;
    const marker = { sessionId: 'session-one', commitId: crypto.randomUUID(), bundle: { source: { fileName: 'synthetic.csv' }, primaryTableId: 'entity-id', tables: output.tables.map((t, i) => ({ ...t, tableId: i ? 'metric-id' : 'entity-id' })) },
        replayManifest: { validationBinding: { contract: { tables: [{ name: 'entities', metrics: [{ column: 'Amount', scale: 2, unit: 'USD' }] }, { name: 'metrics', metrics: [{ column: 'Value', scale: 2, unit: 'USD' }] }] } } } } as unknown as DatasetCommitMarker;
    return { output, marker, data: { fileName: 'synthetic.csv', data: output.tables[0].rows } };
};
const ownedFixture = () => {
    const f = fixture();
    f.marker.bundle.acceptedCommit = { sessionId: f.marker.sessionId, commitId: f.marker.commitId, revision: 1 };
    let state: any = { sessionId: f.marker.sessionId, datasetBundle: structuredClone(f.marker.bundle), csvData: f.data };
    const store = { getState: () => state, setState: (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } } as StoreApi;
    return { ...f, store };
};
const activateOwned = async (f: ReturnType<typeof ownedFixture>) => {
    const p = await prepareAcceptedTablesBinding(f.marker, f.output, () => {});
    p.activate(f.data, acceptedQueryOwner(f.store, f.marker, f.data)); p.finish(); return p;
};
describe('isolated accepted grain queries', () => {
    it('has no precommit query route; atomically selects each native table, exact nullable decimals and no raw SQL/joins', async () => {
        const f = fixture(), p = await prepareAcceptedTablesBinding(f.marker, f.output, () => {});
        await expect(executeManagedDataQuery(f.data, { tableId: 'metric-id', select: ['Value'] }, [])).rejects.toThrow('accepted_table_unavailable');
        p.activate(f.data, () => true); p.finish();
        const primary = await executeManagedDataQuery(f.data, { aggregates: [{ function: 'sum', column: 'Amount', as: 'n' }] }, []);
        const metric = await executeManagedDataQuery(f.data, { tableId: 'metric-id', aggregates: [{ function: 'sum', column: 'Value', as: 'n' }] }, []);
        expect(primary.result.rows[0].worker).toBe(0); expect(metric.result.rows[0].worker).toBe(1);
        expect(metric.sqlPreview).toContain('SUM("Value")');
        expect(io.clients[1].payload.exactColumns[1]).toEqual({ name: 'Value', type: 'DECIMAL(24,2)', nullable: true });
        expect(await io.clients[1].payload.file.text()).toContain('"one",');
        await expect(executeManagedDataQuery(f.data, { tableId: 'missing', select: ['Id'] }, [])).rejects.toThrow('accepted_table_unavailable');
        await expect(executeRawSqlQuery(f.data, 'SELECT * FROM session_clean_dataset', [])).rejects.toThrow('accepted_dual_joins_sql_unsupported');
        await expect(executeManagedDataQuery(f.data, { rawSql: 'SELECT 1' }, [])).rejects.toThrow('accepted_dual_joins_sql_unsupported');
    });
    it('does not expose an old detail table to an unrelated same-primary dataset', async () => {
        const f = fixture(), p = await prepareAcceptedTablesBinding(f.marker, f.output, () => {});
        p.activate(f.data, () => true); p.finish();
        const unrelated = { fileName: f.data.fileName, data: structuredClone(f.data.data) };
        await expect(executeManagedDataQuery(unrelated, { tableId: 'metric-id', select: ['Value'] }, []))
            .rejects.toThrow('accepted_table_unavailable');
    });
    it('requires explicit host rebinding for a legitimate clone; serialized claims grant nothing', async () => {
        const f = ownedFixture(), p = await activateOwned(f), clone = structuredClone(f.data);
        await expect(executeManagedDataQuery(clone, { tableId: 'metric-id', select: ['Value'] }, [])).rejects.toThrow('accepted_table_unavailable');
        p.bind(clone);
        expect((await executeManagedDataQuery(clone, { tableId: 'metric-id', select: ['Value'] }, [])).result.rows[0].worker).toBe(1);
        f.store.setState({ datasetBundle: { ...f.marker.bundle, relationshipSetId: 'replaced-relationship-generation' } });
        await expect(executeManagedDataQuery(clone, { select: ['Id'] }, [])).rejects.toThrow('accepted_table_unavailable');
        expect(() => p.bind(structuredClone(clone))).toThrow('accepted_table_unavailable');
    });
    it('explicit verified restore binds the journal commit into a fresh tab session, not a serialized old owner', async () => {
        const f = ownedFixture(); await activateOwned(f);
        beginSessionTransition(f.store); f.store.setState({ sessionId: 'history-tab-session' });
        const csv = structuredClone(f.data), restored = await prepareAcceptedTablesBinding(f.marker, f.output, () => {});
        restored.activate(csv, acceptedQueryOwner(f.store, f.marker, csv));
        f.store.setState({ csvData: csv, datasetBundle: structuredClone(f.marker.bundle) }); restored.finish();
        expect((await executeManagedDataQuery(csv, { tableId: 'metric-id', select: ['Value'] }, [])).result.rows[0].worker).toBe(3);
        await expect(executeManagedDataQuery(f.data, { tableId: 'metric-id', select: ['Value'] }, [])).rejects.toThrow('accepted_table_unavailable');
    });
    it('same-primary new dual commit selects only its own detail and rejects old data/IDs', async () => {
        const f = ownedFixture(); await activateOwned(f);
        const next = ownedFixture(); next.marker.bundle.tables[1].tableId = 'metric-next';
        next.output.tables[1].rows[0].Value = 19;
        const p = await prepareAcceptedTablesBinding(next.marker, next.output, () => {});
        p.activate(next.data, acceptedQueryOwner(f.store, next.marker, next.data));
        f.store.setState({ datasetBundle: structuredClone(next.marker.bundle), csvData: next.data }); p.finish();
        expect((await executeManagedDataQuery(next.data, { tableId: 'metric-next', select: ['Value'] }, [])).result.rows[0].worker).toBe(3);
        expect(await io.clients[3].payload.file.text()).toContain('"19"');
        await expect(executeManagedDataQuery(next.data, { tableId: 'metric-id', select: ['Value'] }, [])).rejects.toThrow('accepted_table_unavailable');
        await expect(executeManagedDataQuery(f.data, { select: ['Id'] }, [])).rejects.toThrow('accepted_table_unavailable');
        expect(io.clients.slice(0, 2).every(c => c.retired)).toBe(true);
    });
    it.each(['ordinary', 'spill'])('atomically retires dual on %s publication; raw SQL returns, rollback preserves dual', async lane => {
        const f = ownedFixture(); await activateOwned(f);
        const data = structuredClone(f.data);
        const prepare = () => lane === 'ordinary' ? prepareOrdinaryDatasetBinding(data, () => {}) : prepareAcceptedSpillBinding(new File(['Id,Amount\\none,4'], 'ordinary.csv'), {
            digest: 'next-spill', rowCount: 1, meaning: { columns: [{ name: 'Id', conversion: 'text' }, { name: 'Amount', conversion: 'decimal', scale: 2 }] },
        } as any, () => {});
        const rolledBack = await prepare(); rolledBack.activate(data, () => true); rolledBack.rollback();
        expect((await executeManagedDataQuery(f.data, { tableId: 'metric-id', select: ['Value'] }, [])).result.rows[0].worker).toBe(1);
        const next = await prepare(); next.activate(data, () => true, 'current-primary'); next.finish();
        await expect(executeManagedDataQuery(data, { tableId: 'metric-id', select: ['Value'] }, [])).rejects.toThrow('accepted_table_unavailable');
        expect((await executeManagedDataQuery(data, { tableId: 'current-primary', select: ['Id'] }, ['Id', 'Amount'])).engine).toBe('duckdb');
        const raw = await executeRawSqlQuery(data, 'SELECT * FROM session_clean_dataset', ['Id', 'Amount']);
        expect(raw.engine).toBe('duckdb'); expect(raw.result.rows[0].worker).toBe(3);
        await expect(executeRawSqlQuery(f.data, 'SELECT 1', [])).rejects.toThrow('accepted_table_unavailable');
    });
    it('failed ordinary preparation and uncertain acknowledgement leave prior dual queries available', async () => {
        const f = ownedFixture(); await activateOwned(f);
        io.fail = true;
        await expect(prepareOrdinaryDatasetBinding(structuredClone(f.data), () => {})).rejects.toThrow('ordinary_load_failed');
        io.fail = false; f.store.setState({ datasetCommitBindingStatus: 'commit_unknown' });
        expect((await executeManagedDataQuery(f.data, { tableId: 'metric-id', select: ['Value'] }, [])).result.rows[0].worker).toBe(1);
        expect(io.clients.slice(0, 2).every(c => !c.retired)).toBe(true);
    });
    it.each(['upload', 'new-session', 'bundle', 'tables'])('revokes complete host custody on %s, without trusting editable claims', async mode => {
        const f = ownedFixture(); await activateOwned(f);
        if (mode === 'upload') f.store.setState({ csvData: structuredClone(f.data) });
        if (mode === 'new-session') beginSessionTransition(f.store);
        if (mode === 'bundle') f.store.setState({ datasetBundle: { ...f.marker.bundle, bundleId: 'another-bundle' } });
        if (mode === 'tables') f.store.getState().datasetBundle!.tables[1].rowCount++;
        retireInactiveAcceptedTables();
        await expect(executeManagedDataQuery(f.data, { tableId: 'metric-id', select: ['Value'] }, [])).rejects.toThrow('accepted_table_unavailable');
        expect(io.clients.every(c => c.retired)).toBe(true);
    });
    it('rejects an in-flight detail result after successful replacement', async () => {
        const f = ownedFixture(); await activateOwned(f);
        let release!: () => void;
        io.wait = new Promise<void>(r => { release = r; });
        const running = executeManagedDataQuery(f.data, { tableId: 'metric-id', select: ['Value'] }, []);
        const assertion = expect(running).rejects.toThrow('replaced');
        await new Promise(r => setTimeout(r, 0));
        const data = structuredClone(f.data), next = await prepareOrdinaryDatasetBinding(data, () => {});
        next.activate(data, () => true); next.finish(); release(); await assertion;
    });
    it('also fences late ordinary/raw results when the host owner changes without a store subscription', async () => {
        const f = ownedFixture(), data = f.data;
        const p = await prepareOrdinaryDatasetBinding(data, () => {});
        p.activate(data, acceptedQueryOwner(f.store, f.marker, data), f.marker.bundle.primaryTableId); p.finish();
        let release!: () => void;
        io.wait = new Promise<void>(r => { release = r; });
        const running = executeRawSqlQuery(data, 'SELECT * FROM session_clean_dataset', ['Id', 'Amount']);
        const assertion = expect(running).rejects.toThrow('accepted_table_unavailable');
        await new Promise(r => setTimeout(r, 0));
        f.store.setState({ csvData: structuredClone(data) }); release(); await assertion;
    });
    it('second-table failure or rollback never retires the prior accepted workers', async () => {
        const f = fixture(), p = await prepareAcceptedTablesBinding(f.marker, f.output, () => {}); p.activate(f.data, () => true); p.finish();
        io.fail = true;
        await expect(prepareAcceptedTablesBinding(f.marker, f.output, () => {})).rejects.toThrow('second_table_failed');
        expect(io.clients.slice(0, 2).every(c => !c.retired)).toBe(true);
        expect(io.clients.slice(2).every(c => c.retired)).toBe(true);
        io.fail = false;
        const next = await prepareAcceptedTablesBinding(f.marker, f.output, () => {}); next.activate(structuredClone(f.data), () => true); next.rollback();
        expect((await executeManagedDataQuery(f.data, { select: ['Id'] }, [])).result.rows[0].worker).toBe(0);
    });
});
