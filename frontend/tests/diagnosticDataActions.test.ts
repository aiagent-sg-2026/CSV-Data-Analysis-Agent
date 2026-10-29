// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDataDescribeAction } from '../services/agent/execution/diagnosticDataActions';
import { createRuntimeTestStore } from './runtimeTestStore';
import { getCsvDatasetVersion, buildDatasetId } from '../utils/datasetId';

const { executeUnifiedQueryMock, executeBoundDuckDbQueryMock } = vi.hoisted(() => ({
    executeUnifiedQueryMock: vi.fn(),
    executeBoundDuckDbQueryMock: vi.fn(),
}));

vi.mock('../services/duckdb/unifiedQueryExecutor', () => ({
    executeUnifiedQuery: executeUnifiedQueryMock,
}));

vi.mock('../services/duckdb/queryEngine', () => ({
    executeBoundDuckDbQuery: executeBoundDuckDbQueryMock,
}));

describe('diagnostic data actions', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('resolves data.describe against the preferred canonical dataset binding', async () => {
        const prepared = {
            fileName: 'prepared.csv',
            data: [{ Amount: 999 }],
        };
        const canonical = {
            fileName: 'canonical.csv',
            data: [{ Amount: 10 }, { Amount: 20 }],
        };
        const canonicalLoadVersion = buildDatasetId(canonical.fileName, canonical.data);
        const store = createRuntimeTestStore({
            csvData: prepared,
            columnProfiles: [{ name: 'Amount', type: 'numerical' }],
        } as never);
        // A stale session status must not matter: the action binds the preferred dataset itself.
        store.setState({ canonicalCsvData: canonical } as never);
        executeBoundDuckDbQueryMock.mockImplementation((data: { fileName: string; data: [] }, execute: (binding: unknown) => unknown) => execute({
            engine: 'duckdb',
            tableName: 'session_clean_dataset',
            loadVersion: buildDatasetId(data.fileName, data.data),
            fallbackReason: null,
            fallbackStage: null,
        }));
        executeUnifiedQueryMock.mockResolvedValue({
            rows: [{
                column: 'Amount',
                count: 2,
                min: 10,
                max: 20,
            }],
            selectedColumns: ['column', 'count', 'min', 'max'],
            totalMatchedRows: 1,
            returnedRows: 1,
            engine: 'duckdb',
            sqlPreview: 'SELECT ...',
            durationMs: 5,
            injectedDirectives: [],
        });

        const result = await executeDataDescribeAction({
            type: 'tool_call',
            thought: 'Describe Amount.',
            toolName: 'data.describe',
            args: {
                columns: ['Amount'],
                explanation: 'Describe Amount.',
            },
        }, store as never);

        expect(result.status).toBe('success');
        expect(executeBoundDuckDbQueryMock).toHaveBeenCalledWith(canonical, expect.any(Function), undefined);
        expect(executeUnifiedQueryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'describe',
                params: { columns: ['Amount'] },
            }),
            expect.objectContaining({
                binding: {
                    tableName: 'session_clean_dataset',
                    loadVersion: canonicalLoadVersion,
                },
            }),
        );
    });
    const describeAction = { type: 'tool_call', thought: 'Describe.', toolName: 'data.describe', args: {} } as const;
    const mockQueries = () => {
        executeBoundDuckDbQueryMock.mockImplementation((_data: unknown, execute: (binding: unknown) => unknown) =>
            execute({ tableName: 'session_clean_dataset', loadVersion: 'bound-version' }));
        executeUnifiedQueryMock.mockResolvedValue({ rows: [], selectedColumns: [], totalMatchedRows: 0,
            returnedRows: 0, engine: 'duckdb', durationMs: 1 });
    };

    it('filters lineage profiles using backing columns rather than the preview row', async () => {
        mockQueries();
        const store = createRuntimeTestStore({
            csvData: { fileName: 'large.csv', data: [{ price: 1, SourceRowIndex: 9 }],
                backing: { mode: 'duckdb_file', loadVersion: 'lv', datasetVersion: 'dv', rowCount: 982589,
                    sampleRowCount: 1, byteSize: 1, columnNames: ['price', 'area'], readOnly: true, ephemeral: true } },
            columnProfiles: [{ name: 'price', type: 'currency' }, { name: 'area', type: 'numerical' },
                { name: 'SourceRowIndex', type: 'numerical' }],
        } as never);
        await executeDataDescribeAction(describeAction, store as never);
        expect(executeUnifiedQueryMock).toHaveBeenCalledWith(expect.objectContaining({
            params: { columns: ['price', 'area'] }, options: { timeout: 27651 },
        }), expect.objectContaining({ allowedColumns: ['price', 'area'] }));
    });

    it('uses the exact semantic dataset columns and preserves cancellation wiring', async () => {
        mockQueries();
        const data = { fileName: 'semantic.csv', data: [{ totalOnly: 999 }, { price: 12 }] };
        const version = getCsvDatasetVersion(data as never);
        const store = createRuntimeTestStore({ csvData: data,
            columnProfiles: [{ name: 'price', type: 'numerical' }, { name: 'totalOnly', type: 'numerical' }],
        } as never);
        store.setState({ datasetSemanticSnapshot: { sourceDatasetVersion: version, columnAnnotations: [], rowAnnotations: [],
            recommendedAnalysisView: { mode: 'soft_exclude', includedRowIndices: [1], excludedRowIndices: [0],
                includedRowCount: 1, excludedRowCount: 1, reason: 'Exclude synthetic total.' } },
            semanticDatasetVersion: version, semanticStatus: 'ready' } as never);
        const signal = new AbortController().signal;
        await executeDataDescribeAction(describeAction, store as never, signal);
        expect(executeBoundDuckDbQueryMock).toHaveBeenCalledWith(expect.objectContaining({ data: [{ price: 12 }] }),
            expect.any(Function), signal);
        expect(executeUnifiedQueryMock).toHaveBeenCalledWith(expect.objectContaining({ params: { columns: ['price'] },
            options: { timeout: 8000 } }), expect.objectContaining({ allowedColumns: ['price'], abortSignal: signal }));
    });

    it.each([[0, 8000], [49, 8000], [50, 8001], [2000000, 30000]])(
        'bounds the describe timeout for %i backing rows at %i ms', async (rowCount, timeout) => {
            mockQueries();
            const store = createRuntimeTestStore({ csvData: { fileName: 'bounds.csv', data: [{ price: 1 }],
                backing: { mode: 'duckdb_file', rowCount, columnNames: ['price'] } },
                columnProfiles: [{ name: 'price', type: 'numerical' }] } as never);
            await executeDataDescribeAction(describeAction, store as never);
            expect(executeUnifiedQueryMock.mock.calls[0][0].options.timeout).toBe(timeout);
        });

    it('does not query when only missing numeric columns were requested', async () => {
        mockQueries();
        const store = createRuntimeTestStore({ csvData: { fileName: 'small.csv', data: [{ label: 'x' }] },
            columnProfiles: [{ name: 'SourceRowIndex', type: 'numerical' }] } as never);
        const result = await executeDataDescribeAction(describeAction, store as never);
        expect(result.status).toBe('error');
        expect(executeBoundDuckDbQueryMock).not.toHaveBeenCalled();
    });

    it('keeps physical columns that occur only after the first in-memory row', async () => {
        mockQueries();
        const store = createRuntimeTestStore({ csvData: { fileName: 'sparse.csv', data: [{ label: 'x' }, { price: 12 }] },
            columnProfiles: [{ name: 'price', type: 'numerical' }] } as never);
        const result = await executeDataDescribeAction(describeAction, store as never);
        expect(result.status).toBe('success');
        expect(executeUnifiedQueryMock.mock.calls[0][1].allowedColumns).toEqual(['label', 'price']);
    });

});
