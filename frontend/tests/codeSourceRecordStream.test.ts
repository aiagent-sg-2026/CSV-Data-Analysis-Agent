// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { qualifySourceStream } from '../services/agent/execution/codeSourceStreamQualification';
import { createCandidateSpill, openCandidateSpill, type CandidateSpillFactory } from '../services/data/candidateSpill';
import { createCandidateStaging } from '../services/data/candidateStaging';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import type { CodeExecutionReceipt } from '../services/agent/execution/codeExecutionContract';
import { createSourceRecordStream } from '../services/agent/execution/codeSourceRecordStream';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const disk = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-stream-')); directories.push(dir);
    const paths: string[] = [];
    const factory: CandidateSpillFactory = async (_session, generation) => {
        const path = join(dir, generation); paths.push(path);
        const { mkdir } = await import('node:fs/promises'); await mkdir(path);
        return { put: (name, text) => writeFile(join(path, name), text, { flag: 'wx' }),
            get: name => readFile(join(path, name), 'utf8'), remove: () => rm(path, { recursive: true, force: true }) };
    };
    return { factory, paths };
};
const realGuest = () => ({
    run: (code: string, inputJson: string, options: Parameters<NonNullable<Parameters<typeof qualifySourceStream>[1]>['run']>[2]) =>
        executeQuickJsGuest({ generation: 1, code, inputJson, limits: resolveGuestLimits(options?.limits) }, () => newQuickJSWASMModuleFromVariant(variant), options?.onStarted),
    cancel() {}, dispose() {},
});

describe('real original-record stream through governed executor, QuickJS and disk spill', () => {
    it.each([9000, 27000])('repairs and independently checks %i records including ragged UTF-8/multiline tail without full Blob reads', async rows => {
        const storage = await disk(), s = await qualifySourceStream(rows, realGuest(), storage.factory);
        const result = await s.dispatch();
        const receipt = result.artifacts?.codeExecution as CodeExecutionReceipt | undefined;
        expect(receipt, JSON.stringify(result)).toMatchObject({ status: 'succeeded', mode: 'source_records', sourceStream: {
            manifest: { sourceRows: rows + 1, sourceBytes: s.source.byteSize, semanticValidation: 'not_performed', commitAllowed: false },
            metrics: { validatedRows: rows + 1 },
        } });
        expect(s.source.byteSize).toBeGreaterThan(rows === 9000 ? 8 * 1024 * 1024 : 25 * 1024 * 1024);
        expect(s.scan.counts.width_mismatch).toBe(1);
        expect(s.reads.fullReads).toBe(0); expect(s.reads.maxBytes).toBeLessThanOrEqual(65536);
        expect(receipt!.workerGenerations!.length).toBeLessThanOrEqual(20);
        expect(receipt!.sourceStream!.metrics.peakSourceRecords).toBeLessThanOrEqual(50);
        expect(receipt!.sourceStream!.metrics.peakInputJsonBytes).toBeLessThan(256 * 1024);
        const files = await readdir(storage.paths[0]); expect(files).toContain('manifest.json'); expect(files.length).toBeGreaterThan(100);
        const last = JSON.parse(await readFile(join(storage.paths[0], `chunk-${receipt!.sourceStream!.manifest.chunks - 1}.json`), 'utf8'));
        expect(last.rows.at(-1)).toMatchObject({ sourceRow: rows, cells: [String(rows - 1), expect.stringContaining('α\r\n末尾'), rows % 2 ? '0' : '-1'] });
        expect(() => s.adapter.assertCommitEligible(receipt!.jobId, s.context)).toThrow('approval_invalid');
        expect(() => s.adapter.captureCommitCheck(receipt!.jobId, s.context)).toThrow('approval_invalid');
        const staging = createCandidateStaging(s.store, s.workspace, s.getTask, s.adapter);
        await expect(staging.stage(receipt!.jobId, s.context)).rejects.toThrow('candidate_stream_semantic_contract_required');
        expect(s.root.getState().datasetBundle!.tables[0].datasetVersion).toBe('v1');
        console.log(JSON.stringify({ rows, bytes: s.source.byteSize, reads: s.reads, metrics: receipt!.sourceStream!.metrics }));
        s.adapter.dispose();
    }, 180000);
    it('rejects forged stream options/cursors and preserves the default exact request contract', async () => {
        const storage = await disk(), s = await qualifySourceStream(4, realGuest(), storage.factory);
        for (const extra of [{ nextRow: 2 }, { generation: 'forged' }, { width: 257 }]) {
            const receipt = await s.adapter.run({ ...s.request, sourceRecords: { ...s.request.sourceRecords!, ...extra } }, s.context);
            expect(receipt.reasonCode).toBe('validation_failed');
        }
        s.adapter.dispose();
    });
    it('resumes only its private pre-write frontier after cancellation, without replaying rows', async () => {
        const storage = await disk(); let s: Awaited<ReturnType<typeof qualifySourceStream>>, calls = 0;
        const guest = realGuest(), run = guest.run;
        guest.run = async (...args) => {
            calls++;
            if (calls === 2) { const [job] = s.adapter.inspect(undefined, s.context) as Array<{ jobId: string }>; s.adapter.cancel(job.jobId, s.context); }
            return run(...args);
        };
        s = await qualifySourceStream(200, guest, storage.factory);
        expect((await s.adapter.run(s.request, s.context)).status).toBe('cancelled');
        const result = await s.adapter.run(s.request, s.context);
        expect(result).toMatchObject({ status: 'succeeded', sourceStream: { manifest: { sourceRows: 201 } } });
        expect(storage.paths.length).toBe(1); s.adapter.dispose();
    });
    it('exhausts repeated cancelled attempts at the same batch instead of reopening its no-progress budget', async () => {
        const storage = await disk(); let s: Awaited<ReturnType<typeof qualifySourceStream>>;
        const guest = realGuest(), run = guest.run;
        guest.run = async (...args) => {
            const jobs = s.adapter.inspect(undefined, s.context) as Array<{ jobId: string }>;
            s.adapter.cancel(jobs.at(-1)!.jobId, s.context); return run(...args);
        };
        s = await qualifySourceStream(3, guest, storage.factory);
        for (let i = 0; i < 3; i++) expect((await s.adapter.run(s.request, s.context)).status).toBe('cancelled');
        expect(await s.adapter.run(s.request, s.context)).toMatchObject({ status: 'blocked', reasonCode: 'source_stream_no_progress_exhausted' });
        expect(storage.paths.length).toBe(1); s.adapter.dispose();
    });
    it.each(['chunk-write', 'chunk-read', 'manifest-write'] as const)('fences program changes during spill %s awaits', async point => {
        const storage = await disk(); let s: Awaited<ReturnType<typeof qualifySourceStream>>, changed = false;
        const mutate = async () => { if (!changed) { changed = true; await s.workspace.write(s.request.program.path, 'return {};', 1); } };
        const factory: CandidateSpillFactory = async (...args) => {
            const io = await storage.factory(...args);
            return { ...io, async put(name, text) {
                await io.put(name, text);
                if (point === 'chunk-write' && name.startsWith('chunk-') || point === 'manifest-write' && name === 'manifest.json') await mutate();
            }, async get(name) { const text = await io.get(name); if (point === 'chunk-read') await mutate(); return text; } };
        };
        s = await qualifySourceStream(3, realGuest(), factory);
        expect(await s.adapter.run(s.request, s.context)).toMatchObject({ status: 'blocked', reasonCode: 'workspace_conflict' });
        expect(s.workspace.revision(s.request.output.path)).toBe(0); s.adapter.dispose();
    });
    it.each(['program', 'source', 'session', 'task'] as const)('fences %s replacement after guest await without publishing', async change => {
        const storage = await disk(); let s: Awaited<ReturnType<typeof qualifySourceStream>>;
        const guest = realGuest(), run = guest.run;
        guest.run = async (...args) => {
            const result = await run(...args);
            if (change === 'program') await s.workspace.write(s.request.program.path, 'return {};', 1);
            if (change === 'source') s.root.setState({ datasetBundle: { ...s.root.getState().datasetBundle!, source: { ...s.root.getState().datasetBundle!.source, inspection: { ...s.source, sha256: 'f'.repeat(64) } } } });
            if (change === 'session') beginSessionTransition(s.root);
            if (change === 'task') s.setTask({ ...s.getTask(), revision: 2 });
            return result;
        };
        s = await qualifySourceStream(10, guest, storage.factory);
        const result = await s.adapter.run(s.request, s.context);
        expect(result.status).not.toBe('succeeded'); expect(result.output).toBeUndefined(); s.adapter.dispose();
    });
    it.each(['quota', 'read', 'corruption', 'cancel-write'] as const)('fails closed for persistent spill %s and preserves accepted data', async fault => {
        const storage = await disk(); let s: Awaited<ReturnType<typeof qualifySourceStream>>;
        const factory: CandidateSpillFactory = async (...args) => {
            const io = await storage.factory(...args);
            return { ...io,
                async put(name, text) {
                    if (fault === 'quota' && name.startsWith('chunk-')) throw new DOMException('disk full', 'QuotaExceededError');
                    await io.put(name, text);
                    if (fault === 'cancel-write' && name.startsWith('chunk-')) {
                        const [job] = s.adapter.inspect(undefined, s.context) as Array<{ jobId: string }>; s.adapter.cancel(job.jobId, s.context);
                    }
                },
                async get(name) {
                    if (fault === 'read') throw new Error('read failed');
                    const text = await io.get(name);
                    return fault === 'corruption' ? text.replace('identity', 'forged').replace('"previous":"', '"previous":"forged') : text;
                },
            };
        };
        s = await qualifySourceStream(3, realGuest(), factory);
        const result = await s.adapter.run(s.request, s.context);
        expect(result.status).not.toBe('succeeded'); expect(result.output).toBeUndefined();
        if (fault === 'quota') expect(result.reasonCode).toBe('spill_storage_quota');
        expect(s.root.getState().datasetBundle!.tables[0].datasetVersion).toBe('v1');
        expect((await s.adapter.run(s.request, s.context)).status).not.toBe('succeeded'); s.adapter.dispose();
    });
    it('does not mislabel a failed native Blob read as a too-large record', async () => {
        const storage = await disk(), s = await qualifySourceStream(3, realGuest(), storage.factory);
        vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new DOMException('unreadable', 'NotReadableError'));
        expect(await s.adapter.run(s.request, s.context)).toMatchObject({ status: 'blocked', reasonCode: 'source_record_scan_failed' });
        s.adapter.dispose();
    });
    it('revalidates every persisted chunk before reusing a sealed private frontier', async () => {
        const storage = await disk(), s = await qualifySourceStream(3, realGuest(), storage.factory);
        const stream = await createSourceRecordStream(s.store, s.request.sourceRecords!, { task: 'same' }, () => {}, storage.factory);
        const guest = realGuest(), code = s.workspace.read(s.request.program.path).content;
        await stream.execute(json => guest.run(code, json, { limits: resolveGuestLimits() }), () => {});
        const path = join(storage.paths[0], 'chunk-0.json');
        const text = await readFile(path, 'utf8'); await writeFile(path, text.replace('"key"', '"forged"'));
        await expect(stream.execute(json => guest.run(code, json, { limits: resolveGuestLimits() }), () => {})).rejects.toThrow();
        s.adapter.dispose();
    });
    it('rejects guest data loss, no-progress and oversize state rather than certifying execution', async () => {
        for (const code of ['return {state:{},rows:[]};', 'return {state:{},rows:input.records.map(r=>({sourceRow:r.sourceRow,cells:["forged","",""]}))};',
            'return {state:"x".repeat(70000),rows:input.records};']) {
            const storage = await disk(), s = await qualifySourceStream(2, realGuest(), storage.factory);
            const program = await s.workspace.write(s.request.program.path, code, 1);
            const result = await s.adapter.run({ ...s.request, program: { path: program.path, revision: program.revision, sha256: program.sha256 } }, s.context);
            expect(result.status).not.toBe('succeeded'); expect(result.output).toBeUndefined(); s.adapter.dispose();
        }
    });
    it('pins the retained original metadata, not just a projected SHA/source ID', async () => {
        const storage = await disk(), s = await qualifySourceStream(3, realGuest(), storage.factory);
        s.root.setState({ datasetBundle: { ...s.root.getState().datasetBundle!, source: { ...s.root.getState().datasetBundle!.source,
            inspection: { ...s.source, dialect: { delimiter: ';', quoteChar: '"' } } } } });
        expect(await s.adapter.run(s.request, s.context)).toMatchObject({ status: 'blocked', reasonCode: 'source_stream_binding_invalid' });
        expect(storage.paths).toEqual([]); s.adapter.dispose();
    });
    it('cannot reset source attempt budgets by A → B → A or creating a new owner', async () => {
        const storage = await disk(), s = await qualifySourceStream(2, realGuest(), storage.factory);
        for (const goal of ['A', 'B', 'A']) {
            const stream = await createSourceRecordStream(s.store, s.request.sourceRecords!, { goal }, () => {}, storage.factory);
            await stream.dispose();
        }
        await expect(createSourceRecordStream(s.store, s.request.sourceRecords!, { goal: 'A' }, () => {}, storage.factory)).rejects.toThrow('source_stream_attempts_exhausted');
        s.adapter.dispose();
    });
});

describe('immutable bounded persistent spill', () => {
    const chunk = { startRow: 0, nextRow: 1, startByte: 0, endByte: 4, rows: [{ sourceRow: 0, cells: ['a'] }] };
    it('rejects storage unavailable and quota failure, never seals partial output', async () => {
        await expect(openCandidateSpill('s', crypto.randomUUID(), () => {})).rejects.toThrow('spill_storage_unavailable');
        const spill = await createCandidateSpill('s', 'identity', () => {}, async () => ({
            put: async () => { throw new DOMException('full', 'QuotaExceededError'); }, get: async () => '', remove: async () => {},
        }));
        await expect(spill.append(chunk)).rejects.toThrow('full');
        await expect(spill.seal(1, 4)).rejects.toThrow('spill_poisoned');
    });
    it('rejects skipped/replayed cursors, corrupt chunk chain and corrupt manifest', async () => {
        const storage = await disk(), spill = await createCandidateSpill('s', 'identity', () => {}, storage.factory);
        await expect(spill.append({ ...chunk, startRow: 1 })).rejects.toThrow('spill_cursor_invalid');
        await spill.append(chunk);
        await expect(spill.append(chunk)).rejects.toThrow('spill_cursor_invalid');
        const manifest = await spill.seal(1, 4);
        await expect(spill.verifyManifest({ ...manifest, chain: 'forged' })).rejects.toThrow('spill_manifest_corrupt');
        await writeFile(join(storage.paths[0], 'chunk-0.json'), JSON.stringify({ ...chunk, sequence: 0, previous: 'identity', rows: [{ sourceRow: 0, cells: ['forged'] }] }));
        await expect((async () => { for await (const _chunk of spill.read()) { /* Consume the full chain. */ } })()).rejects.toThrow('spill_corrupt');
    });
    it('cannot seal incomplete coverage or write into a sealed generation', async () => {
        const storage = await disk(), spill = await createCandidateSpill('s', 'identity', () => {}, storage.factory);
        await spill.append(chunk); await expect(spill.seal(2, 8)).rejects.toThrow('spill_incomplete');
        await spill.seal(1, 4); await expect(spill.append(chunk)).rejects.toThrow('spill_sealed');
    });
});
