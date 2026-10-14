import type { AnalysisEngine, ColumnRegistry, CsvData, DataQueryResult, DuckDbFallbackStage, QueryPlan } from '../../types';
import { shouldEnableDuckDbQueryEngine } from '../../config/runtimeConfig';
import { getCsvDatasetLoadVersion } from '../../utils/datasetId';
import { executeDataQuery } from '../agent/execution/dataOperationRunner';
import { executeArqueroQuery } from '../data/arqueroEngine';
import { isRuntimeAbortError, throwIfAborted } from '../agent/runtime/runtimeAbort';
import { compileQueryPlanToDuckDbSql } from './queryCompiler';
import type { DimensionNormalizationConfig } from './dimensionNormalization';
import { duckDbWorkerClient } from '../workers/duckDbWorkerClient';
import type { WorkerDiagnosticsReporter } from '../workers/workerDiagnostics';
import { collectOrderedColumnNames } from '../data/columnRegistry';
import { DUCKDB_QUERY_TIMEOUT_MS, resolveDuckDbQueryTimeoutMs } from './queryTimeout';
import { validateSqlLimit, validateSqlText, SQL_POLICY_VERSION } from './sqlSecurity';

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_COLUMNS = 50;
const DEFAULT_MAX_ORDER_BY = 3;
export const DUCKDB_INIT_TIMEOUT_MS = 45000;
export const DUCKDB_LOAD_TIMEOUT_MS = 45000;
export const DUCKDB_FILE_LOAD_TIMEOUT_MS = 180000;
export const DUCKDB_SLOW_LOAD_WARNING_MS = 10000;
export { DUCKDB_QUERY_TIMEOUT_MS } from './queryTimeout';
export const DUCKDB_DISPOSE_TIMEOUT_MS = 5000;
const DUCKDB_TABLE_NAME = 'session_clean_dataset';

export interface ManagedDataQueryExecution {
    result: DataQueryResult;
    engine: AnalysisEngine;
    sqlPreview: string | null;
    tableName: string | null;
    loadVersion: string | null;
    fallbackReason: string | null;
    fallbackStage: DuckDbFallbackStage | null;
}

export interface DuckDbDatasetBinding {
    engine: AnalysisEngine;
    tableName: string | null;
    loadVersion: string | null;
    fallbackReason: string | null;
    fallbackStage: DuckDbFallbackStage | null;
}

export interface ManagedDataQueryExecutionOptions {
    allowNativeFallback?: boolean;
    bypassCache?: boolean;
    abortSignal?: AbortSignal;
    reportDiagnostics?: WorkerDiagnosticsReporter;
    columnRegistry?: ColumnRegistry | null;
    /** Called once if the dataset load exceeds SLOW_LOAD_WARNING_MS (10s). */
    onSlowLoad?: () => void;
    /** Dimension normalization config for GROUP BY columns. */
    dimensionNormalization?: DimensionNormalizationConfig | null;
}

type CachedDuckDbPrime = {
    loadVersion: string;
    promise: Promise<DuckDbDatasetBinding>;
};

const getColumns = (rows: CsvData['data'], columnRegistry?: ColumnRegistry | null): string[] =>
    columnRegistry?.columns?.map(entry => entry.physicalName) ?? collectOrderedColumnNames(rows);

const escapeCsvValue = (value: unknown) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
};

const serializeRowsToCsv = (rows: CsvData['data'], columns: string[]) => {
    const lines = [columns.map(escapeCsvValue).join(',')];
    rows.forEach(row => {
        lines.push(columns.map(column => escapeCsvValue(row[column] ?? '')).join(','));
    });
    return lines.join('\n');
};

const getNativeResult = (
    rows: CsvData['data'],
    plan: QueryPlan,
    allowedColumns: string[],
    fallback?: { reason?: string | null; stage?: DuckDbFallbackStage | null },
): ManagedDataQueryExecution => ({
    result: executeDataQuery(rows, plan, {
        allowedColumns,
        maxRows: DEFAULT_MAX_ROWS,
        maxColumns: DEFAULT_MAX_COLUMNS,
        maxOrderBy: DEFAULT_MAX_ORDER_BY,
    }),
    engine: 'native',
    sqlPreview: null,
    tableName: null,
    loadVersion: null,
    fallbackReason: fallback?.reason ?? null,
    fallbackStage: fallback?.stage ?? null,
});

/**
 * Try Arquero first, fall back to native JS engine if unsupported or failed.
 * This is the primary fallback path when DuckDB is unavailable.
 */
const getFallbackResult = (
    rows: CsvData['data'],
    plan: QueryPlan,
    allowedColumns: string[],
    fallback?: { reason?: string | null; stage?: DuckDbFallbackStage | null },
): ManagedDataQueryExecution => {
    try {
        const arqueroExecution = executeArqueroQuery(rows, plan, {
            allowedColumns,
            maxRows: DEFAULT_MAX_ROWS,
            maxColumns: DEFAULT_MAX_COLUMNS,
            maxOrderBy: DEFAULT_MAX_ORDER_BY,
        });
        if (arqueroExecution.supported) {
            console.log(`[Engine] Arquero fallback executed (${arqueroExecution.result.returnedRows} rows, ${arqueroExecution.result.durationMs}ms)`);
            return {
                result: arqueroExecution.result,
                engine: 'arquero',
                sqlPreview: null,
                tableName: null,
                loadVersion: null,
                fallbackReason: fallback?.reason ?? null,
                fallbackStage: fallback?.stage ? 'arquero_fallback' : null,
            };
        }
        console.log(`[Engine] Arquero unsupported: ${arqueroExecution.unsupportedReason}, falling back to native`);
    } catch (error) {
        console.warn('[Engine] Arquero execution failed, falling back to native:', error instanceof Error ? error.message : error);
    }
    return getNativeResult(rows, plan, allowedColumns, fallback);
};

let engineGeneration = 0;
let queryQueue: Promise<unknown> = Promise.resolve();
const assertGeneration = (generation: number) => {
    if (generation !== engineGeneration) {
        const error = new Error('The query engine session was replaced.');
        error.name = 'AbortError';
        throw error;
    }
};
const inEngineScope = <T>(operation: () => Promise<T>): Promise<T> => {
    const generation = engineGeneration;
    const next = queryQueue.then(async () => {
        assertGeneration(generation);
        const result = await operation();
        assertGeneration(generation);
        return result;
    });
    queryQueue = next.catch(() => undefined);
    return next;
};

let cachedDuckDbBinding: DuckDbDatasetBinding | null = null;
let cachedDuckDbPrime: CachedDuckDbPrime | null = null;
// Cache the last serialized CSV payload so re-prime after worker reset
// (timeout/crash) skips the expensive serialization when data hasn't changed.
let cachedSerializedPayload: { loadVersion: string; csvText: string; csvFileName: string } | null = null;

// --- Query result cache (AGENT-306) ---
const QUERY_CACHE_MAX_SIZE = 50;
interface CachedQueryEntry { result: DataQueryResult; timestamp: number }
let queryResultCache = new Map<string, CachedQueryEntry>();

const tryQueryCache = (loadVersion: string, sql: string): ManagedDataQueryExecution | null => {
    const cacheKey = `${SQL_POLICY_VERSION}::${engineGeneration}::${loadVersion}::${sql}`;
    const cached = queryResultCache.get(cacheKey);
    if (!cached) return null;
    console.log(`[Perf:DuckDB] Query cache: HIT (key: ${cacheKey.slice(0, 30)}…)`);
    return {
        result: cached.result,
        engine: 'duckdb',
        sqlPreview: sql,
        tableName: DUCKDB_TABLE_NAME,
        loadVersion,
        fallbackReason: null,
        fallbackStage: null,
    };
};

const storeQueryCache = (loadVersion: string, sql: string, result: DataQueryResult): void => {
    const cacheKey = `${SQL_POLICY_VERSION}::${engineGeneration}::${loadVersion}::${sql}`;
    if (queryResultCache.size >= QUERY_CACHE_MAX_SIZE) {
        const oldestKey = queryResultCache.keys().next().value;
        if (oldestKey) queryResultCache.delete(oldestKey);
    }
    queryResultCache.set(cacheKey, { result, timestamp: Date.now() });
    console.log(`[Perf:DuckDB] Query cache: MISS → stored (size: ${queryResultCache.size})`);
};

const clearCachedDuckDbBinding = () => {
    cachedDuckDbBinding = null;
    cachedDuckDbPrime = null;
    queryResultCache.clear();
    // Intentionally keep cachedSerializedPayload — the serialized text is
    // still valid even when the binding is cleared (e.g. after worker reset).
};

const primeDuckDbDatasetUnlocked = async (
    data: CsvData | null,
    abortSignal?: AbortSignal,
    reportDiagnostics?: WorkerDiagnosticsReporter,
    onSlowLoad?: () => void,
    columnRegistry?: ColumnRegistry | null,
): Promise<DuckDbDatasetBinding> => {
    const generation = engineGeneration;
    assertGeneration(generation);
    throwIfAborted(abortSignal);
    if (!data || !shouldEnableDuckDbQueryEngine()) {
        clearCachedDuckDbBinding();
        return {
            engine: 'native' as const,
            tableName: null,
            loadVersion: null,
            fallbackReason: shouldEnableDuckDbQueryEngine() ? 'no_dataset' : 'duckdb_disabled',
            fallbackStage: shouldEnableDuckDbQueryEngine() ? 'no_dataset' : 'duckdb_disabled',
        };
    }

    const loadVersion = getCsvDatasetLoadVersion(data);
    if (cachedDuckDbBinding?.engine === 'duckdb' && cachedDuckDbBinding.loadVersion === loadVersion) {
        return cachedDuckDbBinding;
    }
    if (cachedDuckDbPrime?.loadVersion === loadVersion) {
        return cachedDuckDbPrime.promise;
    }
    if (cachedDuckDbBinding?.loadVersion !== loadVersion) {
        cachedDuckDbBinding = null;
    }
    if (data.backing?.mode === 'duckdb_file') {
        return {
            engine: 'native',
            tableName: DUCKDB_TABLE_NAME,
            loadVersion,
            fallbackReason: 'large_dataset_requires_reimport',
            fallbackStage: 'bind_failed',
        };
    }
    let csvText: string;
    let csvFileName: string;
    if (cachedSerializedPayload?.loadVersion === loadVersion) {
        csvText = cachedSerializedPayload.csvText;
        csvFileName = cachedSerializedPayload.csvFileName;
        console.log(`[Perf:DuckDB] CSV serialization: cache hit (version: ${loadVersion})`);
    } else {
        const serializeStart = performance.now();
        const columns = getColumns(data.data, columnRegistry);
        csvText = serializeRowsToCsv(data.data, columns);
        csvFileName = `${loadVersion}.csv`;
        cachedSerializedPayload = { loadVersion, csvText, csvFileName };
        console.log(`[Perf:DuckDB] CSV serialization: ${Math.round(performance.now() - serializeStart)}ms, ${(csvText.length / 1024).toFixed(0)}KB, ${data.data.length} rows`);
    }

    const primePromise = (async (): Promise<DuckDbDatasetBinding> => {
        const primeStart = performance.now();
        try {
            assertGeneration(generation);
            throwIfAborted(abortSignal);
            const tInit = performance.now();
            await duckDbWorkerClient.initDuckDb(DUCKDB_INIT_TIMEOUT_MS, abortSignal, reportDiagnostics);
            console.log(`[Perf:DuckDB] initDuckDb (await): ${Math.round(performance.now() - tInit)}ms`);
            assertGeneration(generation);
            throwIfAborted(abortSignal);
            let slowLoadTimer: ReturnType<typeof setTimeout> | undefined;
            if (onSlowLoad) {
                slowLoadTimer = setTimeout(onSlowLoad, DUCKDB_SLOW_LOAD_WARNING_MS);
            }
            try {
                const tLoad = performance.now();
                await duckDbWorkerClient.loadCleanDataset({
                    csvText,
                    csvFileName,
                    loadVersion,
                    tableName: DUCKDB_TABLE_NAME,
                }, DUCKDB_LOAD_TIMEOUT_MS, abortSignal, reportDiagnostics);
                console.log(`[Perf:DuckDB] loadCleanDataset (await): ${Math.round(performance.now() - tLoad)}ms`);
            } finally {
                clearTimeout(slowLoadTimer);
            }
            assertGeneration(generation);
            throwIfAborted(abortSignal);
            console.log(`[Perf:DuckDB] Prime completed: ${Math.round(performance.now() - primeStart)}ms (version: ${loadVersion})`);
            const binding: DuckDbDatasetBinding = {
                engine: 'duckdb',
                tableName: DUCKDB_TABLE_NAME,
                loadVersion,
                fallbackReason: null,
                fallbackStage: null,
            };
            cachedDuckDbBinding = binding;
            return binding;
        } catch (error) {
            assertGeneration(generation);
            if (isRuntimeAbortError(error, abortSignal)) {
                throw error;
            }
            if (cachedDuckDbBinding?.loadVersion === loadVersion) {
                cachedDuckDbBinding = null;
            }
            return {
                engine: 'native' as const,
                tableName: DUCKDB_TABLE_NAME,
                loadVersion,
                fallbackReason: error instanceof Error ? error.message : String(error),
                fallbackStage: 'bind_failed',
            };
        }
    })();
    cachedDuckDbPrime = { loadVersion, promise: primePromise };
    try {
        return await primePromise;
    } finally {
        if (cachedDuckDbPrime?.promise === primePromise) {
            cachedDuckDbPrime = null;
        }
    }
};

const primeDuckDbFileDatasetUnlocked = async (
    file: File,
    loadVersion: string,
    options?: {
        previewRows?: number;
        abortSignal?: AbortSignal;
        reportDiagnostics?: WorkerDiagnosticsReporter;
    },
): Promise<{ binding: DuckDbDatasetBinding; rowCount: number; preview: CsvData['data'] }> => {
    const generation = engineGeneration;
    assertGeneration(generation);
    throwIfAborted(options?.abortSignal);
    const loadFile = async () => {
        await duckDbWorkerClient.initDuckDb(
            DUCKDB_INIT_TIMEOUT_MS,
            options?.abortSignal,
            options?.reportDiagnostics,
        );
        assertGeneration(generation);
        throwIfAborted(options?.abortSignal);
        return duckDbWorkerClient.loadFileDataset({
            file,
            csvFileName: `${loadVersion}.csv`,
            loadVersion,
            tableName: DUCKDB_TABLE_NAME,
            previewRows: options?.previewRows ?? 1000,
        }, DUCKDB_FILE_LOAD_TIMEOUT_MS, options?.abortSignal, options?.reportDiagnostics);
    };
    let result = await loadFile();
    assertGeneration(generation);
    throwIfAborted(options?.abortSignal);
    if (result.rowCount > 0 && result.preview.length === 0) {
        // A hot reload or same-file re-import can preserve the worker table
        // while resetting app state. Recover once instead of handing an empty
        // preview to report intake and falsely reporting "no body rows".
        await duckDbWorkerClient.disposeDuckDbSession(DUCKDB_DISPOSE_TIMEOUT_MS, options?.reportDiagnostics);
        assertGeneration(generation);
        throwIfAborted(options?.abortSignal);
        result = await loadFile();
        assertGeneration(generation);
        throwIfAborted(options?.abortSignal);
    }
    if (result.rowCount > 0 && result.preview.length === 0) {
        throw new Error('The large CSV loaded, but its preview rows could not be recovered. Re-import the file and try again.');
    }
    const binding: DuckDbDatasetBinding = {
        engine: 'duckdb',
        tableName: DUCKDB_TABLE_NAME,
        loadVersion,
        fallbackReason: null,
        fallbackStage: null,
    };
    cachedDuckDbBinding = binding;
    cachedDuckDbPrime = null;
    cachedSerializedPayload = null;
    queryResultCache.clear();
    return { binding, rowCount: result.rowCount, preview: result.preview };
};

export const disposeDuckDbQueryEngine = async () => {
    engineGeneration += 1;
    queryQueue = Promise.resolve();
    clearCachedDuckDbBinding();
    cachedSerializedPayload = null;
    if (typeof duckDbWorkerClient.retireSession === 'function') duckDbWorkerClient.retireSession();
    else await duckDbWorkerClient.disposeDuckDbSession(DUCKDB_DISPOSE_TIMEOUT_MS);
};

/** Diagnostic cleanup must not retire a later dataset binding. */
export const retireDuckDbQueryBinding = (binding: DuckDbDatasetBinding): Promise<void> => {
    if (binding.engine !== 'duckdb' || !binding.loadVersion || cachedDuckDbBinding?.loadVersion !== binding.loadVersion
        || cachedDuckDbBinding.tableName !== binding.tableName) return Promise.resolve();
    return disposeDuckDbQueryEngine();
};

const executeManagedDataQueryUnlocked = async (
    data: CsvData,
    plan: QueryPlan,
    allowedColumns: string[],
    options?: ManagedDataQueryExecutionOptions,
): Promise<ManagedDataQueryExecution> => {
    const generation = engineGeneration;
    const allowNativeFallback = data.backing?.mode === 'duckdb_file'
        ? false
        : options?.allowNativeFallback ?? true;
    const abortSignal = options?.abortSignal;
    const reportDiagnostics = options?.reportDiagnostics;
    const columnRegistry = options?.columnRegistry ?? null;
    const onSlowLoad = options?.onSlowLoad;
    assertGeneration(generation);
    throwIfAborted(abortSignal);
    if (!shouldEnableDuckDbQueryEngine()) {
        if (!allowNativeFallback) {
            throw new Error('duckdb_disabled');
        }
        return getFallbackResult(data.data, plan, allowedColumns, {
            reason: 'duckdb_disabled',
            stage: 'duckdb_disabled',
        });
    }

    const loadVersion = getCsvDatasetLoadVersion(data);
    const compiled = compileQueryPlanToDuckDbSql(plan, {
        allowedColumns,
        tableName: DUCKDB_TABLE_NAME,
        maxRows: DEFAULT_MAX_ROWS,
        maxColumns: DEFAULT_MAX_COLUMNS,
        maxOrderBy: DEFAULT_MAX_ORDER_BY,
        ...(options?.dimensionNormalization ? { dimensionNormalization: options.dimensionNormalization } : {}),
    });
    assertGeneration(generation);
    throwIfAborted(abortSignal);

    // --- Query result cache lookup (AGENT-306) ---
    const hit = options?.bypassCache ? null : tryQueryCache(loadVersion, compiled.sql);
    if (hit) return hit;

    const prime = await primeDuckDbDatasetUnlocked(data, abortSignal, reportDiagnostics, onSlowLoad, columnRegistry);
    if (prime.engine !== 'duckdb') {
        if (!allowNativeFallback) {
            throw new Error(prime.fallbackReason ?? 'duckdb_unavailable');
        }
        const fallbackExecution = getFallbackResult(data.data, plan, allowedColumns, {
            reason: prime.fallbackReason,
            stage: prime.fallbackStage,
        });
        return {
            ...fallbackExecution,
            sqlPreview: compiled.sql,
            tableName: DUCKDB_TABLE_NAME,
            loadVersion,
            fallbackReason: prime.fallbackReason,
            fallbackStage: prime.fallbackStage,
        };
    }

    try {
        assertGeneration(generation);
        throwIfAborted(abortSignal);
        const result = await duckDbWorkerClient.executeCompiledQuery({
            sql: compiled.sql,
            countSql: compiled.countSql,
            selectedColumns: compiled.selectedColumns,
            appliedOrderBy: compiled.appliedOrderBy,
            appliedLimit: compiled.appliedLimit,
            expectedBinding: {tableName: DUCKDB_TABLE_NAME, loadVersion},
        }, resolveDuckDbQueryTimeoutMs(data), abortSignal, reportDiagnostics);
        assertGeneration(generation);
        throwIfAborted(abortSignal);

        storeQueryCache(loadVersion, compiled.sql, result);

        return {
            result,
            engine: 'duckdb',
            sqlPreview: compiled.sql,
            tableName: DUCKDB_TABLE_NAME,
            loadVersion,
            fallbackReason: null,
            fallbackStage: null,
        };
    } catch (error) {
        assertGeneration(generation);
        if (isRuntimeAbortError(error, abortSignal)) {
            throw error;
        }
        if (error instanceof Error && error.message.startsWith('sql_')) throw error;
        clearCachedDuckDbBinding();
        if (!allowNativeFallback) {
            throw error instanceof Error ? error : new Error(String(error));
        }
        const fallbackExecution = getFallbackResult(data.data, plan, allowedColumns, {
            reason: error instanceof Error ? error.message : String(error),
            stage: 'query_failed',
        });
        return {
            ...fallbackExecution,
            sqlPreview: compiled.sql,
            tableName: DUCKDB_TABLE_NAME,
            loadVersion,
            fallbackReason: error instanceof Error ? error.message : String(error),
            fallbackStage: 'query_failed',
        };
    }
};

/**
 * Execute a raw SQL query directly against DuckDB.
 * Used when the AI provides valid SQL that can't be expressed as a structured QueryPlan
 * (e.g., UNPIVOT, UNION ALL). The SQL must be read-only (enforced by the worker).
 */
const executeRawSqlQueryUnlocked = async (
    data: CsvData,
    rawSql: string,
    selectedColumns: string[],
    options?: {
        limit?: number;
        bypassCache?: boolean;
        abortSignal?: AbortSignal;
        reportDiagnostics?: WorkerDiagnosticsReporter;
        columnRegistry?: ColumnRegistry | null;
        onSlowLoad?: () => void;
    },
): Promise<ManagedDataQueryExecution> => {
    const generation = engineGeneration;
    const abortSignal = options?.abortSignal;
    const reportDiagnostics = options?.reportDiagnostics;
    const columnRegistry = options?.columnRegistry ?? null;
    const limit = validateSqlLimit(options?.limit ?? DEFAULT_MAX_ROWS);
    validateSqlText(rawSql);

    assertGeneration(generation);

    throwIfAborted(abortSignal);
    if (!shouldEnableDuckDbQueryEngine()) {
        throw new Error('Raw SQL queries require DuckDB to be enabled.');
    }

    const loadVersion = getCsvDatasetLoadVersion(data);

    // --- Query result cache lookup (AGENT-306) ---
    const hit = options?.bypassCache ? null : tryQueryCache(loadVersion, `${rawSql}::${limit}::${selectedColumns.join(",")}`);
    if (hit) return { ...hit, sqlPreview: rawSql };

    const prime = await primeDuckDbDatasetUnlocked(data, abortSignal, reportDiagnostics, options?.onSlowLoad, columnRegistry);
    if (prime.engine !== 'duckdb') {
        throw new Error(prime.fallbackReason ?? 'DuckDB unavailable for raw SQL query.');
    }

    assertGeneration(generation);

    throwIfAborted(abortSignal);
    const result = await duckDbWorkerClient.executeRawQuery(
        { sql: rawSql, selectedColumns, limit, expectedBinding: {tableName: DUCKDB_TABLE_NAME, loadVersion} },
        resolveDuckDbQueryTimeoutMs(data),
        abortSignal,
        reportDiagnostics,
    );
    assertGeneration(generation);
    throwIfAborted(abortSignal);

    storeQueryCache(loadVersion, `${rawSql}::${limit}::${selectedColumns.join(",")}`, result);

    return {
        result,
        engine: 'duckdb',
        sqlPreview: rawSql,
        tableName: DUCKDB_TABLE_NAME,
        loadVersion,
        fallbackReason: null,
        fallbackStage: null,
    };
};

// --- Query cache diagnostics (AGENT-306) ---
export const getQueryCacheStats = () => ({
    size: queryResultCache.size,
    maxSize: QUERY_CACHE_MAX_SIZE,
});

/** Exposed for testing only. */
export const _testClearQueryCache = () => { queryResultCache.clear(); };

export const primeDuckDbDataset = (...args: Parameters<typeof primeDuckDbDatasetUnlocked>) => inEngineScope(() => primeDuckDbDatasetUnlocked(...args));
export const primeDuckDbFileDataset = (...args: Parameters<typeof primeDuckDbFileDatasetUnlocked>) => inEngineScope(() => primeDuckDbFileDatasetUnlocked(...args));
export const executeManagedDataQuery = (...args: Parameters<typeof executeManagedDataQueryUnlocked>) => inEngineScope(() => executeManagedDataQueryUnlocked(...args));
export const executeRawSqlQuery = (...args: Parameters<typeof executeRawSqlQueryUnlocked>) => inEngineScope(() => executeRawSqlQueryUnlocked(...args));

/** Keep dataset binding and specialized worker execution in the same resource lease. */
export const executeBoundDuckDbQuery = <T>(data: CsvData, execute: (binding: DuckDbDatasetBinding) => Promise<T>, signal?: AbortSignal): Promise<T> =>
    inEngineScope(async () => {
        const generation = engineGeneration;
        const binding = await primeDuckDbDatasetUnlocked(data, signal);
        assertGeneration(generation);
        throwIfAborted(signal);
        if (binding.engine !== 'duckdb') throw new Error('This query requires DuckDB.');
        const result = await execute(binding);
        assertGeneration(generation);
        throwIfAborted(signal);
        return result;
    });
