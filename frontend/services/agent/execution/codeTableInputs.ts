import type { CsvRow, DatasetScopeBinding } from '../../../types';
import type { StoreApi } from '../types';
import { getPreferredAnalysisDataset } from '../reportStructureState';
import { getCsvDatasetVersion } from '../../../utils/datasetId';
import { getSandboxTableRows } from '../../data/sandboxTableRegistry';
import { sha256Bytes } from '../../data/sourceDigest';
import type { CodeInputCoverage, CodeTableRef } from './codeExecutionContract';

export const CODE_TABLE_LIMITS = Object.freeze({ rows: 50_000, columns: 256, stateBytes: 64 * 1024, streamSteps: 128 });
const encode = (text: string) => new TextEncoder().encode(text);
export const codeDigest = (value: unknown) => sha256Bytes(encode(JSON.stringify(value)));

/** Complete rows only. A preview/backing that cannot materialize here is refused, never substituted. */
const resolveRows = (store: StoreApi, binding: DatasetScopeBinding): CsvRow[] => {
    const state = store.getState(), bundle = state.datasetBundle;
    const table = bundle?.tables.find(table => table.tableId === binding.tableId);
    if (!bundle || !table || table.datasetVersion !== binding.datasetVersion || bundle.relationshipSetId !== binding.relationshipSetId) throw new Error('input_version_changed');
    if (!Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || table.rowCount > CODE_TABLE_LIMITS.rows
        || !Array.isArray(table.schema) || table.schema.length > CODE_TABLE_LIMITS.columns) throw new Error('resource_limit');
    if (table.storage.mode !== 'memory') throw new Error('complete_input_unavailable');
    if (table.tableId === bundle.primaryTableId) {
        const data = getPreferredAnalysisDataset(state);
        if (!data || data.backing) throw new Error('complete_input_unavailable');
        if (getCsvDatasetVersion(data) !== table.datasetVersion) throw new Error('input_version_changed');
        if (data.data.length !== table.rowCount) throw new Error('complete_input_unavailable');
        return data.data;
    }
    const rows = getSandboxTableRows(bundle.bundleId, table.tableId, table.datasetVersion);
    if (!rows || rows.length !== table.rowCount) throw new Error('complete_input_unavailable');
    return rows;
};

export const captureCodeTables = async (store: StoreApi, refs: CodeTableRef[], bindings: DatasetScopeBinding[],
    inputByteLimit: number, assertCurrent: () => void) => {
    const tables: Record<string, { rows: CsvRow[]; columns: string[] }> = Object.create(null);
    const coverage: CodeInputCoverage[] = [];
    const snapshots: Array<{binding: DatasetScopeBinding; json: string}> = [];
    let rowsTotal = 0, bytes = 2;
    for (const ref of refs) {
        assertCurrent();
        const binding = bindings.find(item => item.tableId === ref.tableId);
        if (!binding) throw new Error('approval_invalid');
        const rows = resolveRows(store, binding);
        rowsTotal += rows.length;
        if (rowsTotal > CODE_TABLE_LIMITS.rows) throw new Error('resource_limit');
        const rowJson: string[] = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length > CODE_TABLE_LIMITS.columns
                || Object.keys(row).some(key=>key.length>240)
                || Object.values(row).some(value => value !== null && !['string','number','boolean'].includes(typeof value)
                    || typeof value === 'number' && !Number.isFinite(value))) throw new Error('validation_failed');
            if(Object.values(row).some(value=>typeof value==='string'&&value.length>inputByteLimit))throw new Error('resource_limit');
            const text = JSON.stringify(row); bytes += encode(text).length + 1;
            if (bytes > inputByteLimit) throw new Error('resource_limit');
            rowJson.push(text);
            // Yield to Stop before spending another bounded preparation slice.
            if ((i+1) % 5000 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); assertCurrent(); }
        }
        const json = `[${rowJson.join(',')}]`;
        const sha256 = await sha256Bytes(encode(json));
        assertCurrent();
        if (JSON.stringify(resolveRows(store, binding)) !== json) throw new Error('input_version_changed');
        snapshots.push({binding, json}); tables[ref.name] = { rows: JSON.parse(json),
            columns:store.getState().datasetBundle!.tables.find(table=>table.tableId===ref.tableId)!.schema.map(column=>column.name) };
        coverage.push({...binding,...ref,rowCount:rows.length,deliveredRows:0,sha256,complete:false});
    }
    const checkBinding = (target: StoreApi) => {
        for (const snapshot of snapshots) if (JSON.stringify(resolveRows(target, snapshot.binding)) !== snapshot.json) throw new Error('input_version_changed');
    };
    const check = () => { assertCurrent(); checkBinding(store); };
    return {tables,coverage,check,checkBinding};
};
