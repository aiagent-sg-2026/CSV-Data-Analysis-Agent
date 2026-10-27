// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { qualifySpillCandidate } from '../services/agent/execution/spillCandidateQualification';
import { qualifySourceStream } from '../services/agent/execution/codeSourceStreamQualification';
import { createCandidateStaging } from '../services/data/candidateStaging';
import { bindSpillCandidateValidationContract, spillRow, type SpillCandidateMeaning } from '../services/data/spillCandidateValidation';
import { createCandidateCommitService } from '../services/data/candidateCommit';
import { executeCandidateAction } from '../services/agent/execution/executorCandidateActions';
import { beginSessionTransition } from '../services/session/sessionOwnership';
import { createTaskInspection, readTaskCandidateDraft } from '../services/agent/runtime/pi/piTaskInspection';
import type { CandidateSpillFactory } from '../services/data/candidateSpill';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const wasm = newQuickJSWASMModuleFromVariant(variant);
const guest = { run: (code: string, inputJson: string, options: Parameters<NonNullable<Parameters<typeof qualifySourceStream>[1]>['run']>[2]) =>
    executeQuickJsGuest({ generation: 1, code, inputJson, limits: resolveGuestLimits(options?.limits) }, () => wasm, options?.onStarted), cancel() {}, dispose() {} };
const disk = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spill-candidate-')); dirs.push(dir); let path = '';
    const factory: CandidateSpillFactory = async (_session, generation) => {
        const owned = join(dir, generation); path = owned; await mkdir(owned);
        return { put: (name, text) => writeFile(join(owned, name), text, { flag: 'wx' }), get: name => readFile(join(owned, name), 'utf8'), remove: () => rm(owned, { recursive: true, force: true }) };
    };
    return { factory, get path() { return path; } };
};
const read = (s: Awaited<ReturnType<typeof qualifySpillCandidate>>, id: string, offset = 0, limit = 20) => executeCandidateAction({ type: 'tool_call', toolName: 'candidate.read', args: { candidateId: id, table: 'records', offset, limit } }, s.store);

describe('host spill candidate semantics and read-only draft', () => {
    it.each([9000, 27000])('connects %i ragged records through real tools/QuickJS/disk/semantic validation/paginated draft without accepted mutation', async rows => {
        const started = Date.now(), storage = await disk();
        const samples = { heapUsed: 0, rss: 0, external: 0, arrayBuffers: 0, count: 0 };
        const sample = () => { const value = process.memoryUsage(); samples.count++; for (const k of ['heapUsed', 'rss', 'external', 'arrayBuffers'] as const) samples[k] = Math.max(samples[k], value[k]); };
        const timer = setInterval(sample, 25);
        const s = await qualifySpillCandidate(rows, guest, storage.factory), before = JSON.stringify(s.root.getState());
        try {
            const result = await s.run(), c = s.port.read(result.candidateId), v = result.validation!;
            expect(s.source.byteSize).toBeGreaterThan((rows === 9000 ? 8 : 25) * 1024 * 1024);
            expect(v.decision).toBe('validated'); expect(v.checks).toContain('source-cell-lineage'); expect(Object.isFrozen(v.groups)).toBe(true);
            expect(c.tables[0]).toMatchObject({ rowCount: rows, rows: [], lineage: [] });
            expect(c.spill?.manifest).toMatchObject({ semanticValidation: 'not_performed', commitAllowed: false });
            expect(s.reads).toMatchObject({ bytes: s.source.byteSize * 4 + 3, fullReads: 0, maxBytes: 65536 });
            const sourceBytes = s.reads.bytes;
            const page = await read(s, c.candidateId, 0); expect(page.status, JSON.stringify(page)).toBe('success');
            const payload = (page.payload as {candidate: {rows: unknown[]; nextRow: number; label: string}}).candidate;
            expect(page.status).toBe('success'); expect(payload.label).toBe('draft_uncommitted'); expect(payload.rows.length).toBeGreaterThan(0);
            expect(payload.nextRow).toBe(payload.rows.length); expect(payload.rows.length).toBeLessThanOrEqual(20);
            const tail = await read(s, c.candidateId, rows - 1);
            expect(tail.status).toBe('success'); expect((tail.payload as {candidate: unknown}).candidate).toMatchObject({ rows: [{ key: String(rows - 1), payload: expect.stringContaining('α\r\n末尾'), value: -1 }], complete: true, nextRow: rows, answerEvidence: false });
            expect(s.reads.bytes).toBe(sourceBytes); // draft uses authenticated random-access spill only
            expect(JSON.stringify(s.root.getState())).toBe(before);
            // A structural manifest or copied object still cannot authorize commit. Connected exact
            // commit tests use the full task/bundle fixture, not this intentionally minimal stream fixture.
            expect(()=>createCandidateCommitService(s.store).approve({} as never)).toThrow('approval_invalid');
            expect(typeof s.port.captureCommitCheck(c.candidateId)).toBe('function');
            expect(JSON.stringify(s.root.getState())).toBe(before);
            console.log(JSON.stringify({ qualification: 'spill-candidate-draft-only', rows, bytes: s.source.byteSize, reads: s.reads, elapsedMs: Date.now() - started, sampledNodeMemory: samples, memoryScope: '25ms whole test-worker samples; includes fixture/QuickJS, not a peak or browser memory; no commit qualification' }));
        } finally { clearInterval(timer); sample(); s.adapter.dispose(); }
    }, 180000);
    it('rejects forged receipt, advances short byte-limited pages by actual returned rows and expires old validation', async () => {
        const storage = await disk(), file = new File(['key,payload,value\n' + Array.from({length:100},(_,i)=>`${i},${'x'.repeat(8000)},-1\n`).join('')], 'long-cells.csv');
        const s = await qualifySpillCandidate(100, guest, storage.factory, file);
        try {
            const r = await s.run();
            await expect(s.port.previewAsync(r.candidateId, 'records', 'forged')).rejects.toThrow('validation_failed');
            let offset = 0, count = 0;
            while (offset < 100) { const page = await read(s, r.candidateId, offset); expect(page.status,JSON.stringify(page)).toBe('success');
                const p = (page.payload as {candidate: {rows: Array<{key: string}>; nextRow: number}}).candidate;
                expect(p.rows[0].key).toBe(String(offset)); expect(p.nextRow).toBeGreaterThan(offset); count += p.rows.length; offset = p.nextRow;
                expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(64 * 1024);
            }
            expect(count).toBe(100);
            const next = await s.port.validate(r.candidateId, s.context);
            expect(next.receiptDigest).not.toBe(r.validation!.receiptDigest);
            await expect(s.port.previewAsync(r.candidateId, 'records', r.validation!.receiptDigest)).rejects.toThrow('validation_failed');
            await expect(s.port.previewAsync(r.candidateId, 'records', next.receiptDigest, 101)).rejects.toThrow('preview_bounds_invalid');
        } finally { s.adapter.dispose(); }
    });
    it.each(['chunk', 'manifest', 'missing'] as const)('fails closed on %s backing after PASS; saved metadata cannot restore a capability', async mode => {
        const storage = await disk(), s = await qualifySpillCandidate(3, guest, storage.factory);
        try {
            const r = await s.run();
            if (mode === 'chunk') { const path = join(storage.path, 'chunk-0.json'), text = await readFile(path, 'utf8'); await writeFile(path, text.replace('xxx', 'yyy')); }
            if (mode === 'manifest') await writeFile(join(storage.path, 'manifest.json'), '{}');
            if (mode === 'missing') await rm(storage.path, { recursive: true });
            expect((await read(s, r.candidateId)).status).toBe('blocked');
            await expect(s.port.validate(r.candidateId, s.context)).rejects.toThrow();
            expect(s.port.validationError(r.candidateId)).toBeTruthy(); expect(s.port.validationReceipt(r.candidateId)).toBeUndefined();
            const fresh = createCandidateStaging(s.store, s.workspace, s.getTask, s.adapter);
            expect(() => fresh.read(r.candidateId)).toThrow('candidate_unavailable');
            expect(s.root.getState().datasetBundle!.tables[0].datasetVersion).toBe('v1');
        } finally { s.adapter.dispose(); }
    });
    it.each(['source', 'task', 'program', 'session'] as const)('fences %s mutation during independent semantic source reads', async mode => {
        const storage = await disk(), s = await qualifySpillCandidate(3, guest, storage.factory);
        try {
            const executed = await s.dispatch(), jobId = (executed.artifacts!.codeExecution as {jobId: string}).jobId;
            const c = await s.port.stage(jobId, s.context), original = Blob.prototype.arrayBuffer;
            vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function(this: Blob) {
                const bytes = await original.call(this);
                if (mode === 'source') s.root.setState({ datasetBundle: { ...s.root.getState().datasetBundle!, source: { ...s.root.getState().datasetBundle!.source, inspection: { ...s.source, sha256: 'f'.repeat(64) } } } });
                if (mode === 'task') s.setTask({ ...s.getTask(), revision: s.getTask().revision + 1 });
                if (mode === 'program') await s.workspace.write(s.request.program.path, 'return {};', 1);
                if (mode === 'session') beginSessionTransition(s.root);
                return bytes;
            });
            await expect(s.port.validate(c.candidateId, s.context)).rejects.toThrow();
            expect(s.root.getState().datasetBundle!.tables[0].datasetVersion).toBe('v1');
        } finally { s.adapter.dispose(); }
    });
    it('charges cancelled semantic passes, clears prior PASS and limits restart attempts', async () => {
        const storage = await disk(), s = await qualifySpillCandidate(3, guest, storage.factory);
        try {
            const r = await s.run(), original = Blob.prototype.arrayBuffer;
            let cancelled = false;
            vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function(this: Blob) { cancelled = true; return original.call(this); });
            const originalTask = s.getTask;
            // Fence via task revision while retaining the same valid staging identity on each retry.
            const task = originalTask();
            s.setTask(new Proxy(task, { get(target, key) { if (key === 'revision' && cancelled) throw new Error('scope_revoked'); return Reflect.get(target, key); } }));
            for (let i = 0; i < 2; i++) { cancelled = false; await expect(s.port.validate(r.candidateId, s.context)).rejects.toThrow('scope_revoked'); }
            cancelled = false;
            await expect(s.port.validate(r.candidateId, s.context)).rejects.toThrow('source_stream_attempts_exhausted');
            expect(s.port.validationReceipt(r.candidateId)).toBeUndefined();
            expect(s.reads.bytes).toBe(6 * s.source.byteSize + 3);
        } finally { s.adapter.dispose(); }
    });
    it.each([true, false])('independently reconciles a declared numeric footer (matching=%s)', async matches => {
        const storage = await disk(), file = new File([`key,payload,value\n0,a,-2\n1,b,0\nSUM,,${matches ? '-2' : '-3'}\n`], 'synthetic.csv');
        const s = await qualifySourceStream(2, guest, storage.factory, file);
        const meaning: SpillCandidateMeaning = { version: 1, kind: 'ordered-source-records', table: 'records', grain: 'source_record', headerRow: 0, summary: 'last_record_sum', columns: [{ name: 'key', sourceColumn: 0, conversion: 'identity' }, { name: 'payload', sourceColumn: 1, conversion: 'identity' }, { name: 'value', sourceColumn: 2, conversion: 'decimal', scale: 0, unit: 'count' }] };
        s.root.candidateValidationContract = await bindSpillCandidateValidationContract(s.store, s.getTask().goal, meaning);
        const port = createCandidateStaging(s.store, s.workspace, s.getTask, s.adapter); s.store.candidateStaging = port;
        try { const e = await s.dispatch(), c = await port.stage((e.artifacts!.codeExecution as {jobId: string}).jobId, s.context), v = await port.validate(c.candidateId, s.context);
            expect(v.decision).toBe(matches ? 'validated' : 'blocked'); expect(c.tables[0].rowCount).toBe(2);
            if (matches) expect((await port.previewAsync(c.candidateId, 'records', v.receiptDigest)).rows).toEqual([{ key: '0', payload: 'a', value: -2 }, { key: '1', payload: 'b', value: 0 }]);
            else { expect(v.reasonCodes).toContain('validation_summary_reconciliation_failed'); await expect(port.previewAsync(c.candidateId, 'records', v.receiptDigest)).rejects.toThrow('validation_failed'); }
        } finally { s.adapter.dispose(); }
    });
    it('connects the actual Task inspection read port and surfaces active validation failures instead of an old PASS', async () => {
        const storage = await disk(), s = await qualifySpillCandidate(3, guest, storage.factory);
        try {
            s.root.setState({activeAgentTask:s.getTask()});
            const inspector=createTaskInspection(s.store,s.context.lease,s.workspace,s.getTask().taskId);
            const r=await s.run();
            inspector.observe(s.getTask(),'candidate.validate',r.validated,'validated',s.port);
            expect((await readTaskCandidateDraft(s.root,s.getTask().taskId,r.candidateId,'records',r.validation!.receiptDigest)).rows).toHaveLength(3);
            await writeFile(join(storage.path,'manifest.json'),'{}');
            await expect(s.port.validate(r.candidateId,s.context)).rejects.toThrow('spill_manifest_corrupt');
            inspector.observe(s.getTask(),'candidate.validate',{status:'blocked',toolName:'candidate.validate',message:'spill_manifest_corrupt',shouldStop:false},'failed',s.port);
            expect(inspector.snapshot.candidate).toMatchObject({validationError:'spill_manifest_corrupt'});
            expect(inspector.snapshot.candidate?.validation).toBeUndefined();
            await expect(readTaskCandidateDraft(s.root,s.getTask().taskId,r.candidateId,'records',r.validation!.receiptDigest)).rejects.toThrow('candidate_draft_unavailable');
        } finally { s.adapter.dispose(); }
    });
    it('shows an actively failed older candidate instead of a newer historical PASS', async () => {
        const s=await qualifySpillCandidate(3,guest,(await disk()).factory);
        try {
            const first=await s.run();
            const grant=await s.adapter.issueGrant({readPaths:[s.request.program.path],writePaths:['/workspace/second.json'],sources:[{sourceId:s.source.sourceId,sha256:s.source.sha256}],expiresAt:Date.now()+60000});
            s.setTask({...s.getTask(),capabilityGrants:[...s.getTask().capabilityGrants,grant]});
            const second=await s.adapter.run({...s.request,output:{...s.request.output,path:'/workspace/second.json'}},s.context);
            expect(second.status).toBe('succeeded');
            const c=await s.port.stage(second.jobId,s.context);expect((await s.port.validate(c.candidateId,s.context)).decision).toBe('validated');
            s.root.setState({activeAgentTask:s.getTask()});const inspector=createTaskInspection(s.store,s.context.lease,s.workspace,s.getTask().taskId);
            const failed=await executeCandidateAction({type:'tool_call',toolName:'candidate.validate',args:{candidateId:first.candidateId}},s.store);
            expect(failed).toMatchObject({status:'blocked',message:'source_stream_stale'});
            inspector.observe(s.getTask(),'candidate.validate',failed,'older-active-failure',s.port);
            expect(inspector.snapshot.candidate?.candidateId).toBe(first.candidateId);
            expect(inspector.snapshot.candidate?.validation).toBeUndefined();
            expect(inspector.snapshot.candidateError).toBe('source_stream_stale');
            expect(s.port.validationReceipt(c.candidateId)?.decision).toBe('validated');
        }finally{s.adapter.dispose();}
    });
    it.each(['bad_header','bad_decimal','oversize_row'] as const)('fails closed on %s rather than producing a misleading draft or stalled pagination', async mode => {
        const storage=await disk(), file=new File([`${mode==='bad_header'?'wrong':'key'},payload,value\n0,${mode==='oversize_row'?'x'.repeat(62000):'ok'},${mode==='bad_decimal'?'N/A':'-1'}\n`],'negative.csv');
        const s=await qualifySpillCandidate(1,guest,storage.factory,file);
        try {
            if(mode==='oversize_row'){
                const result=await s.dispatch();
                expect(result.artifacts?.codeExecution).toMatchObject({status:'blocked',reasonCode:'source_stream_record_capacity'});
                expect(s.port.list()).toEqual([]);
            }else{
                const r=await s.run();
                expect(r.validation?.decision).toBe('blocked');
                expect((await read(s,r.candidateId)).message).toBe('candidate_validation_required');
                expect(r.validation?.reasonCodes).toContain(mode==='bad_header'?'validation_header_evidence_mismatch':'validation_numeric_invalid');
            }
        }finally{s.adapter.dispose();}
    });
    it.each(['byteSize','recordCount','dialect'] as const)('expires a receipt on source %s mutation even when its ID and SHA stay unchanged', async field => {
        const s=await qualifySpillCandidate(3,guest,(await disk()).factory);
        try {
            const r=await s.run(), bundle=s.root.getState().datasetBundle!;
            const source={...s.source,...(field==='dialect'?{dialect:{delimiter:';',quoteChar:'"'}}:{[field]:s.source[field]+1})};
            s.root.setState({datasetBundle:{...bundle,source:{...bundle.source,inspection:source}}});
            expect(()=>s.port.validationReceipt(r.candidateId)).toThrow('input_version_changed');
            await expect(s.port.previewAsync(r.candidateId,'records',r.validation!.receiptDigest)).rejects.toThrow('input_version_changed');
        }finally{s.adapter.dispose();}
    });
    it('rechecks current source-path policy on a previously captured spill capability', async () => {
        const s=await qualifySpillCandidate(3,guest,(await disk()).factory);
        try {
            const r=await s.run(), settings=s.root.getState().settings;
            s.root.setState({settings:{...settings,runtimeAccessControl:{...settings.runtimeAccessControl,workspaceRules:{deniedPathPrefixes:['/dataset/source.bytes']}}} as never});
            expect((await read(s,r.candidateId)).message).toBe('capability_unavailable');
            await expect(s.port.validate(r.candidateId,s.context)).rejects.toThrow('capability_unavailable');
            expect(s.port.validationReceipt(r.candidateId)).toBeUndefined();
        }finally{s.adapter.dispose();}
    });
    it('does not let a superseded validation overwrite the latest active error', async () => {
        const storage=await disk();let gated=false,release!:()=>void,entered!:()=>void;
        const wait=new Promise<void>(resolve=>{release=resolve;}), started=new Promise<void>(resolve=>{entered=resolve;});
        const factory:CandidateSpillFactory=async(...args)=>{const io=await storage.factory(...args);return {...io,get:async name=>{
            if(gated&&name==='chunk-0.json'){entered();await wait;}return io.get(name);
        }};};
        const s=await qualifySpillCandidate(3,guest,factory);
        try {
            const e=await s.dispatch(),c=await s.port.stage((e.artifacts!.codeExecution as {jobId:string}).jobId,s.context);
            gated=true;const first=s.port.validate(c.candidateId,s.context);const rejected=expect(first).rejects.toThrow('candidate_validation_superseded');await started;
            await expect(s.port.validate(c.candidateId,s.context)).rejects.toThrow('source_stream_unavailable');
            release();await rejected;
            expect(s.port.validationError(c.candidateId)).toBe('source_stream_unavailable');expect(s.port.validationReceipt(c.candidateId)).toBeUndefined();
        }finally{release();s.adapter.dispose();}
    });
    it('rejects lossy decimal projection even when the minor integer is safe, and locks meaning after execution', async () => {
        const s=await qualifySpillCandidate(3,guest,(await disk()).factory);
        try {
            const meaning={...s.meaning,columns:s.meaning.columns.map(c=>c.conversion==='decimal'?{...c,scale:6}:c)};
            expect(()=>spillRow(meaning,['0','a','9007199254.740991'])).toThrow('validation_decimal_precision');
            expect(spillRow(meaning,['0','a','-0.000001']).value).toBe(-0.000001);
            await s.dispatch();
            await expect(bindSpillCandidateValidationContract(s.store,s.getTask().goal,meaning)).rejects.toThrow('meaning_contract_locked');
        }finally{s.adapter.dispose();}
    });
    it('rejects duplicate/missing column lineage and unresolved units before creating a candidate', async () => {
        const s = await qualifySpillCandidate(3, guest, (await disk()).factory);
        try { for (const columns of [[s.meaning.columns[0], s.meaning.columns[0]], [{ ...s.meaning.columns[2], unit: undefined }], [{ ...s.meaning.columns[0], sourceColumn: 9 }]])
            await expect(bindSpillCandidateValidationContract(s.store, s.getTask().goal, { ...s.meaning, columns })).rejects.toThrow('candidate_spill_meaning_invalid');
        } finally { s.adapter.dispose(); }
    });
});
