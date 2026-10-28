// @vitest-environment jsdom

/**
 * A query timeout terminates the DuckDB worker (the only way to stop a runaway query), which used to
 * discard the loaded table: every later query failed with "Table ... does not exist". The client now
 * remembers the last successful load and restores it before the next query.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
    type Message = { id: number; task: string; payload?: unknown; resourceGeneration: number };
    const instances: FakeWorker[] = [];
    let hangTask: string | null = null;

    class FakeWorker {
        tasks: string[] = [];
        messages: Message[] = [];
        held: Message[] = [];
        release() { for (const message of this.held.splice(0)) this.onmessage?.({ data: { id: message.id, success: true, result: { ok: true } } }); }
        terminate = vi.fn();
        onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
        onerror: unknown = null;
        constructor() { instances.push(this); }
        postMessage = (message: Message) => {
            this.tasks.push(message.task);
            this.messages.push(message);
            if (message.task === hangTask) { this.held.push(message); return; }
            const result = message.task === 'executeCompiledQuery'
                ? { rows: [], totalRows: 0 }
                : { ok: true, loaded: true };
            setTimeout(() => this.onmessage?.({ data: { id: message.id, success: true, result } }), 0);
        };
    }
    return { instances, FakeWorker, setHangTask: (task: string | null) => { hangTask = task; }, reset: () => { instances.length = 0; hangTask = null; } };
});

vi.mock('../services/workers/duckDbWorkerFactory', () => ({
    createDuckDbWorker: () => new harness.FakeWorker(),
}));
vi.mock('../services/workers/workerDiagnostics', () => ({
    buildWorkerDiagnosticsEntry: vi.fn().mockReturnValue({}),
    estimateSerializableBytes: vi.fn().mockReturnValue(0),
    getNowMs: vi.fn().mockReturnValue(Date.now()),
    reportWorkerDiagnostics: vi.fn(),
}));

const query = {
    sql: 'SELECT 1', countSql: 'SELECT 1', selectedColumns: [], appliedOrderBy: [], appliedLimit: 10,
};
const cleanPayload = { csvText: 'a\n1\n', csvFileName: 'a.csv', loadVersion: 'v1', tableName: 'session_clean_dataset' };

describe('DuckDbWorkerClient restores the dataset after a worker reset', () => {
    beforeEach(() => {
        harness.reset();
        vi.useFakeTimers();
        vi.resetModules();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retires only an idle exact owned dataset, never a newer binding or in-flight query', async () => {
        const { duckDbWorkerClient } = await import('../services/workers/duckDbWorkerClient');
        const run = async <T,>(promise: Promise<T>) => { await vi.advanceTimersByTimeAsync(100); return promise; };
        await run(duckDbWorkerClient.initDuckDb(5000));
        await run(duckDbWorkerClient.loadCleanDataset(cleanPayload, 5000));
        await run(duckDbWorkerClient.loadCleanDataset({ ...cleanPayload, loadVersion: 'new' }, 5000));
        expect(duckDbWorkerClient.retireDatasetIfOwned('v1')).toBe(false);
        expect(harness.instances[0].terminate).not.toHaveBeenCalled();
        harness.setHangTask('executeCompiledQuery');
        const pending = duckDbWorkerClient.executeCompiledQuery(query, 5000);
        await vi.advanceTimersByTimeAsync(1);
        expect(duckDbWorkerClient.retireDatasetIfOwned('new')).toBe(false);
        expect(harness.instances[0].terminate).not.toHaveBeenCalled();
        harness.instances[0].release();
        await pending;
        expect(duckDbWorkerClient.retireDatasetIfOwned('new')).toBe(true);
        expect(harness.instances[0].terminate).toHaveBeenCalledOnce();
        expect(duckDbWorkerClient.retireDatasetIfOwned('new')).toBe(false);
    });

    it('reloads the last dataset on a fresh worker before the next query', async () => {
        const { duckDbWorkerClient } = await import('../services/workers/duckDbWorkerClient');
        const run = async <T,>(promise: Promise<T>) => { const settled = promise.then(v => ({ v }), e => ({ e })); await vi.advanceTimersByTimeAsync(100); return settled; };

        await run(duckDbWorkerClient.initDuckDb(5000));
        await run(duckDbWorkerClient.loadCleanDataset(cleanPayload, 5000));

        harness.setHangTask('executeCompiledQuery');
        const timedOut = duckDbWorkerClient.executeCompiledQuery(query, 500).catch(e => e);
        await vi.advanceTimersByTimeAsync(600);
        expect(((await timedOut) as Error).message).toMatch(/timed out/i);
        expect(harness.instances[0].terminate).toHaveBeenCalled();

        harness.setHangTask(null);
        const next = await run(duckDbWorkerClient.executeCompiledQuery(query, 5000));
        expect('e' in next).toBe(false);
        expect(harness.instances).toHaveLength(2);
        expect(harness.instances[1].tasks).toEqual(['initDuckDb', 'loadCleanDataset', 'executeCompiledQuery']);
    });

    it('does not restore after the session was disposed', async () => {
        const { duckDbWorkerClient } = await import('../services/workers/duckDbWorkerClient');
        const run = async <T,>(promise: Promise<T>) => { const settled = promise.then(v => ({ v }), e => ({ e })); await vi.advanceTimersByTimeAsync(100); return settled; };

        await run(duckDbWorkerClient.initDuckDb(5000));
        await run(duckDbWorkerClient.loadCleanDataset(cleanPayload, 5000));
        await run(duckDbWorkerClient.disposeDuckDbSession(5000));
        await run(duckDbWorkerClient.executeCompiledQuery(query, 5000));

        const last = harness.instances.at(-1)!;
        expect(last.tasks).not.toContain('loadCleanDataset');
    });
    it('fences a late old load and dispose from the replacement worker', async () => {
        const { duckDbWorkerClient } = await import('../services/workers/duckDbWorkerClient');
        const run = async <T,>(promise: Promise<T>) => { const result = promise.catch(error => error); await vi.advanceTimersByTimeAsync(100); return result; };
        await run(duckDbWorkerClient.initDuckDb(5000));
        harness.setHangTask('loadCleanDataset');
        const oldLoad = duckDbWorkerClient.loadCleanDataset(cleanPayload, 5000).catch(error => error);
        harness.setHangTask('disposeDuckDbSession');
        const oldDispose = duckDbWorkerClient.disposeDuckDbSession(5000).catch(error => error);
        const oldWorker = harness.instances[0];
        duckDbWorkerClient.retireSession();
        harness.setHangTask(null);
        await run(duckDbWorkerClient.initDuckDb(5000));
        await run(duckDbWorkerClient.loadCleanDataset({ ...cleanPayload, loadVersion: 'new-version' }, 5000));
        const replacement = harness.instances[1];
        oldWorker.release();
        await oldLoad;
        await oldDispose;
        await run(duckDbWorkerClient.executeCompiledQuery(query, 5000));
        expect(replacement.terminate).not.toHaveBeenCalled();
        expect(replacement.tasks).toEqual(['initDuckDb', 'loadCleanDataset', 'executeCompiledQuery']);
    });

    it('attaches the captured resource binding and refuses stale caller versions before posting', async () => {
        const { DuckDbWorkerClient } = await import('../services/workers/duckDbWorkerClient');
        const client = new DuckDbWorkerClient();
        const run = async <T,>(promise: Promise<T>) => {const result = promise.catch(error => error); await vi.advanceTimersByTimeAsync(100); return result;};
        await run(client.loadCleanDataset(cleanPayload, 5000));
        await run(client.executeRawQuery({sql: 'SELECT 1', selectedColumns: [], limit: 500}, 5000));
        const worker = harness.instances[0];
        expect(worker.messages.at(-1)).toMatchObject({resourceGeneration: 0,
            payload: {expectedBinding: {tableName: cleanPayload.tableName, loadVersion: 'v1'}}});
        const before = worker.messages.length;
        await expect(client.executeRawQuery({sql: 'SELECT 1', selectedColumns: [], limit: 500,
            expectedBinding: {tableName: cleanPayload.tableName, loadVersion: 'old'}}, 5000)).rejects.toThrow('sql_binding_mismatch');
        expect(worker.messages).toHaveLength(before);
        client.retireSession();
    });

    it('refuses a deferred old query after a same-worker dataset replacement', async () => {
        const { DuckDbWorkerClient } = await import('../services/workers/duckDbWorkerClient');
        const client = new DuckDbWorkerClient();
        const run = async <T,>(promise: Promise<T>) => {const result = promise.catch(error => error); await vi.advanceTimersByTimeAsync(100); return result;};
        await run(client.loadCleanDataset(cleanPayload, 5000));
        harness.setHangTask('executeRawQuery');
        const oldQuery = client.executeRawQuery({sql: 'SELECT 1', selectedColumns: [], limit: 500}, 5000).catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        harness.setHangTask(null);
        await run(client.loadCleanDataset({...cleanPayload, loadVersion: 'v2'}, 5000));
        harness.instances[0].release();
        expect((await oldQuery).message).toBe('sql_binding_mismatch');
        await run(client.executeCompiledQuery(query, 5000));
        expect(harness.instances[0].messages.at(-1)).toMatchObject({payload: {expectedBinding: {loadVersion: 'v2'}}});
        expect(harness.instances[0].terminate).not.toHaveBeenCalled();
        client.retireSession();
    });

    it('terminates a hanging SQL request at the host ceiling even when a caller requests longer', async () => {
        const { DuckDbWorkerClient } = await import('../services/workers/duckDbWorkerClient');
        const client = new DuckDbWorkerClient();
        harness.setHangTask('executeRawQuery');
        const pending = client.executeRawQuery({sql: 'SELECT 1', selectedColumns: [], limit: 500}, 180000).catch(error => error);
        await vi.advanceTimersByTimeAsync(60001);
        expect((await pending).message).toMatch(/timed out after 60000ms/);
        expect(harness.instances[0].terminate).toHaveBeenCalledOnce();
        client.retireSession();
    });

});
