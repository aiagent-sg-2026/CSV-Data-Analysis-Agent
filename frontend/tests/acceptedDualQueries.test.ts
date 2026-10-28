// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAcceptedTablesBinding, executeManagedDataQuery, executeRawSqlQuery, disposeDuckDbQueryEngine } from '../services/duckdb/queryEngine';
import type { DatasetCommitMarker } from '../types/datasetCommit';
import type { CandidateOutput } from '../services/data/candidateContract';
const io = vi.hoisted(() => ({ clients: [] as any[], fail: false }));
vi.mock('../services/workers/duckDbWorkerClient', () => ({
    duckDbWorkerClient: { retireSession() {} },
    DuckDbWorkerClient: class {
        id = io.clients.length; retired = false; payload: any;
        constructor() { io.clients.push(this); }
        async initDuckDb() {}
        async loadFileDataset(payload: any) { this.payload = payload; if (io.fail && this.id % 2) throw new Error('second_table_failed'); return { rowCount: 1 }; }
        async executeCompiledQuery(payload: any) { return { rows: [{ worker: this.id, sql: payload.sql }], selectedColumns: [], returnedRows: 1, totalMatchedRows: 1, truncated: false, durationMs: 1, appliedLimit: 500, appliedOrderBy: [] }; }
        retireSession() { this.retired = true; }
    },
}));
afterEach(async () => { io.fail = false; await disposeDuckDbQueryEngine(); io.clients.length = 0; });
const fixture = () => {
    const output = { schemaVersion: 1, complete: true, tables: [
        { name: 'entities', rows: [{ Id: 'one', Amount: 4 }], schema: [{ name: 'Id', dataType: 'string', nullable: false }, { name: 'Amount', dataType: 'number', nullable: false }], rowCount: 1 },
        { name: 'metrics', rows: [{ Id: 'one', Value: null }], schema: [{ name: 'Id', dataType: 'string', nullable: false }, { name: 'Value', dataType: 'number', nullable: true }], rowCount: 1 },
    ], relationships: [], excludedRows: [] } as unknown as CandidateOutput;
    const marker = { commitId: crypto.randomUUID(), bundle: { source: { fileName: 'synthetic.csv' }, primaryTableId: 'entity-id', tables: output.tables.map((t, i) => ({ ...t, tableId: i ? 'metric-id' : 'entity-id' })) },
        replayManifest: { validationBinding: { contract: { tables: [{ name: 'entities', metrics: [{ column: 'Amount', scale: 2, unit: 'USD' }] }, { name: 'metrics', metrics: [{ column: 'Value', scale: 2, unit: 'USD' }] }] } } } } as unknown as DatasetCommitMarker;
    return { output, marker, data: { fileName: 'synthetic.csv', data: output.tables[0].rows } };
};
describe('isolated accepted grain queries', () => {
    it('has no precommit query route; atomically selects each native table, exact nullable decimals and no raw SQL/joins', async () => {
        const f = fixture(), p = await prepareAcceptedTablesBinding(f.marker, f.output, () => {});
        await expect(executeManagedDataQuery(f.data, { tableId: 'metric-id', select: ['Value'] }, [])).rejects.toThrow('accepted_table_unavailable');
        p.activate(); p.finish();
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
    it('second-table failure or rollback never retires the prior accepted workers', async () => {
        const f = fixture(), p = await prepareAcceptedTablesBinding(f.marker, f.output, () => {}); p.activate(); p.finish();
        io.fail = true;
        await expect(prepareAcceptedTablesBinding(f.marker, f.output, () => {})).rejects.toThrow('second_table_failed');
        expect(io.clients.slice(0, 2).every(c => !c.retired)).toBe(true);
        expect(io.clients.slice(2).every(c => c.retired)).toBe(true);
        io.fail = false;
        const next = await prepareAcceptedTablesBinding(f.marker, f.output, () => {}); next.activate(); next.rollback();
        expect((await executeManagedDataQuery(f.data, { select: ['Id'] }, [])).result.rows[0].worker).toBe(0);
    });
});
