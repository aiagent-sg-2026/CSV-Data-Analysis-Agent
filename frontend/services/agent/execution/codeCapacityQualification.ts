import type { CsvRow } from '../../../types';
import { createCodeTableQualificationFixture } from './codeTableExecutionQualification';
import { createTaskWorkspace } from '../taskWorkspace';
import { cancelOwnedRun } from '../../session/sessionOwnership';
import { createJavaScriptGuest } from '../../sandbox/javascriptGuestClient';
import { DuckDbWorkerClient } from '../../workers/duckDbWorkerClient';
import { createTaskBudget } from '../runtime/pi/piTaskBudget';

export const CAPACITY_CASE_IDS = Object.freeze([
    'global-sort-dedup-join-50000', 'stateful-tail-50000', 'wide-whole-table', 'wide-stateful-stream',
    'rows-overflow', 'columns-overflow', 'input-overflow', 'joint-envelope-refusal',
    'state-exact', 'state-overflow', 'steps-exact', 'steps-overflow',
    'file-output-exact', 'file-output-overflow', 'stream-output-overflow', 'workspace-total', 'workspace-artifacts',
    'program-exact', 'program-overflow', 'heap-pressure', 'heap-control', 'log-pressure',
    'provider-budget', 'skill-budget', 'tool-budget', 'attempt-budget', 'active-time-budget',
    'native-stop', 'post-stop-job', 'job-deadline', 'sql-million-row-file', 'sql-stop', 'sql-recovery',
]);
export interface CapacityObservation {
    id: string; passed: boolean; elapsedMs: number; maxHeartbeatGapMs: number; details?: Record<string, unknown>;
}
export const resolveCapacityVerdict = (observations: CapacityObservation[], cancelled = false) => {
    const ids = observations.map(item => item.id);
    const valid = !cancelled && ids.length === CAPACITY_CASE_IDS.length && new Set(ids).size === ids.length
        && CAPACITY_CASE_IDS.every(id => ids.includes(id))
        && observations.every(item => item.passed === true && Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0
            && Number.isFinite(item.maxHeartbeatGapMs) && item.maxHeartbeatGapMs >= 0 && item.maxHeartbeatGapMs <= 1000);
    return { passed: valid, cancelled, observations };
};

/** Synthetic capacity observations; the existing task/dispatch/guest remains the execution authority. */
export const qualifyCodeCapacity = async (signal: AbortSignal, onObservation?: (value: CapacityObservation) => void,
    guestFactory = createJavaScriptGuest) => {
    const observations: CapacityObservation[] = [];
    let cleanup = () => {};
    let starts = 0;
    let sql: DuckDbWorkerClient | undefined;
    let sqlStarted: (() => void) | undefined;
    const sqlBinding = {tableName: 'session_clean_dataset', loadVersion: `capacity-sql-${crypto.randomUUID()}`};
    const abortSql = () => sql?.retireSession();
    signal.addEventListener('abort', abortSql, {once:true});
    const fixture = async (rows: CsvRow[], dimensions?: CsvRow[], activeMs?: number) => {
        const f = await createCodeTableQualificationFixture(signal, rows, dimensions, guestFactory,
            activeMs === undefined ? undefined : createTaskBudget({ toolCalls: 40, skillReads: 8, providerTurns: 32,
                transformationAttempts: 3, activeMs }));
        cleanup = f.dispose;
        starts = 0;
        f.setStarted(() => { starts++; });
        return f;
    };
    const check = async (id: string, work: () => Promise<{ passed: boolean; details?: Record<string, unknown> }>) => {
        if (signal.aborted) throw new Error('scope_revoked');
        const start = performance.now();
        let last = start, gap = 0;
        const tick = () => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; };
        const heartbeat = setInterval(tick, 20);
        try {
            const result = await work(); tick();
            const value = { id, ...result, elapsedMs: Math.round(performance.now() - start), maxHeartbeatGapMs: Math.round(gap) };
            observations.push(value);
            if (!signal.aborted) onObservation?.(value);
        } catch (error) {
            if (signal.aborted) throw error;
            observations.push({ id, passed: false, elapsedMs: Math.round(performance.now() - start),
                maxHeartbeatGapMs: Math.round(gap), details: { error: error instanceof Error ? error.message.slice(0, 120) : 'unavailable' } });
            onObservation?.(observations.at(-1)!);
        } finally { clearInterval(heartbeat); cleanup(); cleanup = () => {}; }
    };
    const stream = (partitionBy: string[] = [], batchRows = 5000, initialState: unknown = null) => ({
        mode: 'stateful_stream' as const, stream: { table: 'facts', partitionBy, batchRows, initialState },
    });
    const unchanged = (f: Awaited<ReturnType<typeof fixture>>, before: string) =>
        JSON.stringify([f.root.getState().canonicalCsvData, f.root.getState().datasetBundle, f.root.getState().analysisCards]) === before;
    const snapshot = (f: Awaited<ReturnType<typeof fixture>>) =>
        JSON.stringify([f.root.getState().canonicalCsvData, f.root.getState().datasetBundle, f.root.getState().analysisCards]);
    try {
        await check('global-sort-dedup-join-50000', async () => {
            const f = await fixture(Array.from({ length: 49998 }, (_, i) => ({ id: i === 49996 ? 0 : i,
                k: i % 2 ? 'B' : 'A', v: i === 49997 ? -5 : 1 })), [{ k: 'A', name: 'Alpha' }, { k: 'B', name: 'Beta' }]);
            const before = snapshot(f);
            const receipt = await f.run(`const unique=[...new Map(input.facts.rows.map(r=>[r.id,r])).values()].sort((a,b)=>b.id-a.id);const names=new Map(input.dims.rows.map(r=>[r.k,r.name]));const by={Alpha:0,Beta:0};for(const r of unique)by[names.get(r.k)]+=r.v;return {count:unique.length,total:by.Alpha+by.Beta,by,tail:unique[0].id};`);
            const output = f.output();
            return { passed: receipt.status === 'succeeded' && JSON.stringify(output) === '{"count":49997,"total":49991,"by":{"Alpha":24998,"Beta":24993},"tail":49997}'
                && receipt.coverage?.every(c => c.complete && c.deliveredRows === c.rowCount) === true && unchanged(f, before), details: { receipt, output } };
        });
        await check('stateful-tail-50000', async () => {
            const f = await fixture(Array.from({ length: 50000 }, (_, i) => ({ v: i === 49999 ? -3 : 1 })));
            const receipt = await f.run('const state=(input.stream.state||0)+input.facts.rows.reduce((s,r)=>s+r.v,0);return {state,rows:input.stream.phase==="finish"?[{rows:input.stream.endRow,total:state}]:[]};', stream());
            return { passed: receipt.status === 'succeeded' && JSON.stringify(f.output()) === '[{"rows":50000,"total":49996}]'
                && receipt.coverage?.[0].deliveredRows === 50000, details: { receipt, output: f.output() } };
        });
        for (const mode of ['whole_table', 'stateful_stream'] as const) await check(mode === 'whole_table' ? 'wide-whole-table' : 'wide-stateful-stream', async () => {
            const cols = Array.from({ length: 256 }, (_, i) => `c${i}`);
            const f = await fixture(Array.from({ length: 128 }, () => Object.fromEntries(cols.map(c => [c, 'x'.repeat(240)]))));
            const receipt = await f.run(mode === 'whole_table' ? 'return {rows:input.facts.rows.length,columns:input.facts.columns.length};'
                : 'return {state:null,rows:input.stream.phase==="finish"?[{rows:input.stream.endRow,columns:input.facts.columns.length}]:[]};', mode === 'whole_table' ? {} : stream());
            const output = mode === 'whole_table' ? f.output() : f.output()[0];
            return { passed: receipt.status === 'succeeded' && JSON.stringify(output) === '{"rows":128,"columns":256}' && receipt.coverage?.[0].complete === true,
                details: { receipt, inputRowBytes: 8178177, output } };
        });
        for (const id of ['rows-overflow', 'columns-overflow', 'input-overflow', 'joint-envelope-refusal']) await check(id, async () => {
            const rows = id === 'rows-overflow' ? Array.from({ length: 50001 }, () => ({ v: 1 }))
                : id === 'columns-overflow' ? [Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`c${i}`, 0]))]
                : id === 'input-overflow' ? [{ v: 'x'.repeat(8 * 1024 * 1024) }]
                : Array.from({ length: 50000 }, () => ({ v: 'x'.repeat(170) }));
            const f = await fixture(rows), before = snapshot(f);
            const receipt = await f.run('return input.facts.rows.length;');
            return { passed: receipt.status === 'blocked' && receipt.reasonCode === 'resource_limit' && !receipt.output && starts === 0
                && f.store.codeExecution!.workspace.revision('/workspace/output.json') === 0 && unchanged(f, before), details: { receipt, workerStarts: starts } };
        });
        for (const exact of [true, false]) await check(exact ? 'state-exact' : 'state-overflow', async () => {
            const f = await fixture([{ v: 1 }]);
            const receipt = await f.run('return {state:input.stream.state,rows:[]};', stream([], 5000, 'x'.repeat(exact ? 65534 : 65535)));
            return { passed: exact ? receipt.status === 'succeeded' && receipt.checkpoints?.every(c => c.stateBytes === 65536) === true
                : receipt.status === 'blocked' && receipt.reasonCode === 'resource_limit' && !receipt.output && starts === 0, details: { receipt } };
        });
        for (const exact of [true, false]) await check(exact ? 'steps-exact' : 'steps-overflow', async () => {
            const f = await fixture(Array.from({ length: exact ? 64 : 65 }, (_, p) => ({ p })));
            const receipt = await f.run('return {state:null,rows:input.stream.phase==="finish"?[1]:[]};', stream(['p']));
            return { passed: exact ? receipt.status === 'succeeded' && receipt.checkpoints?.length === 128 && f.output().length === 64
                : receipt.status === 'blocked' && receipt.reasonCode === 'resource_limit' && !receipt.output && starts === 0, details: { receipt } };
        });
        for (const exact of [true, false]) await check(exact ? 'file-output-exact' : 'file-output-overflow', async () => {
            const f = await fixture([{ v: 1 }]);
            const receipt = await f.run(`return "x".repeat(${1048576 - (exact ? 2 : 1)});`);
            return { passed: exact ? receipt.status === 'succeeded' && receipt.output?.byteSize === 1048576
                : receipt.status !== 'succeeded' && !receipt.output && f.store.codeExecution!.workspace.revision('/workspace/output.json') === 0, details: { receipt } };
        });
        await check('stream-output-overflow', async () => {
            const f = await fixture(Array.from({ length: 6 }, () => ({ v: 1 })));
            const receipt = await f.run('return {state:null,rows:input.stream.phase==="batch"?["x".repeat(200000)]:[]};', stream([], 1));
            return { passed: receipt.status === 'blocked' && receipt.reasonCode === 'resource_limit' && !receipt.output && Boolean(receipt.checkpoints?.length)
                && f.store.codeExecution!.workspace.revision('/workspace/output.json') === 0, details: { receipt } };
        });
        for (const artifacts of [false, true]) await check(artifacts ? 'workspace-artifacts' : 'workspace-total', async () => {
            const f = await fixture([{ v: 1 }]);
            const w = createTaskWorkspace(f.root, crypto.randomUUID(), { allowedPrefixes: ['/workspace/'] });
            const count = artifacts ? 100 : 16, content = artifacts ? '' : 'x'.repeat(1048576);
            for (let i = 0; i < count; i++) await w.write(`/workspace/a${i}`, content, 0);
            let reason = ''; try { await w.write('/workspace/overflow', artifacts ? '' : 'x', 0); } catch (e) { reason = (e as Error).message; }
            const passed = reason === 'resource_limit' && w.list().length === count && w.revision('/workspace/overflow') === 0 && w.read('/workspace/a0').content === content;
            w.dispose(); return { passed, details: { reason, files: count, bytes: content.length * count } };
        });
        for (const exact of [true, false]) await check(exact ? 'program-exact' : 'program-overflow', async () => {
            const f = await fixture([{ v: 1 }]);
            const end = '*/return 5;', code = `/*${'x'.repeat(262144 - 2 - end.length + (exact ? 0 : 1))}${end}`;
            const receipt = await f.run(code);
            return { passed: exact ? receipt.status === 'succeeded' && f.output() === 5 : receipt.status !== 'succeeded' && !receipt.output && starts === 0,
                details: { receipt, codeBytes: code.length, workerStarts: starts } };
        });
        for (const pressure of [true, false]) await check(pressure ? 'heap-pressure' : 'heap-control', async () => {
            const f = await fixture([{ v: 1 }]);
            const receipt = await f.run(pressure ? 'return "x".repeat(256*1024*1024).length;'
                : 'const a=[];for(let i=0;i<100000;i++)a.push({v:i});return a.length;');
            return { passed: pressure ? receipt.status === 'failed' && !receipt.output && receipt.reasonCode !== 'execution_deadline'
                : receipt.status === 'succeeded' && f.output() === 100000, details: { receipt } };
        });
        await check('log-pressure', async () => {
            const f = await fixture([{ v: 1 }]);
            const receipt = await f.run('for(let i=0;i<10000;i++){console.log("中");console.error("中");}return 5;');
            return { passed: receipt.status === 'succeeded' && receipt.logsTruncated && new TextEncoder().encode(receipt.stdout).length <= 16384
                && new TextEncoder().encode(receipt.stderr).length <= 16384 && f.output() === 5, details: { receipt } };
        });
        for (const id of ['provider-budget', 'skill-budget', 'tool-budget', 'attempt-budget']) await check(id, async () => {
            const f = await fixture([{ v: 1 }]), before = snapshot(f);
            if(id==='skill-budget')await f.task.beforeTool('workspace.write',{path:'/workspace/activate.js'},crypto.randomUUID());
            const count = id === 'provider-budget' ? 32 : id === 'skill-budget' ? 8 : id === 'tool-budget' ? 40 : 3;
            const use = async () => { if (id === 'provider-budget') f.task.providerTurn(); else if (id === 'skill-budget') f.task.skillRead(crypto.randomUUID());
                else if (id === 'tool-budget') await f.task.beforeTool('workspace.read', { path: '/workspace/missing' }, crypto.randomUUID()); else await f.run('return 5;'); };
            for (let i = 0; i < count; i++) await use();
            let reason = ''; try { await use(); } catch (e) { reason = (e as Error).message; }
            const dimension = id === 'provider-budget' ? 'providerTurns' : id === 'skill-budget' ? 'skillReads' : id === 'tool-budget' ? 'toolCalls' : 'transformationAttempts';
            return { passed: reason === `task_budget_exhausted:${dimension}` && f.task.snapshot.budget.used[dimension] === count && unchanged(f, before),
                details: { reason, budget: f.task.snapshot.budget, accountingOnly: id !== 'attempt-budget' } };
        });
        await check('active-time-budget', async () => {
            const f = await fixture([{ v: 1 }], undefined, 1500), before = snapshot(f);
            const receipt = await f.run('while(true){}');
            return { passed: receipt.status === 'cancelled' && !receipt.output && f.task.blockedReason === 'task_budget_exhausted:activeMs'
                && f.task.snapshot.budget.used.activeMs === 1500 && unchanged(f, before), details: { receipt, budget: f.task.snapshot.budget, scaledActiveLimitMs: 1500 } };
        });
        await check('native-stop', async () => {
            const f = await fixture([{ v: 1 }]), before = snapshot(f);
            let enter!: () => void; const entered = new Promise<void>(r => { enter = r; }); f.setStarted(enter);
            const pending = f.run('return /^(a+)+$/.test("a".repeat(40)+"!");');
            await Promise.race([entered, pending.then(() => { throw new Error('guest_not_started'); })]);
            await new Promise<void>(r => setTimeout(r, 100));
            const start = performance.now(), stopAtEpochMs = Date.now(); cancelOwnedRun(f.root); const acknowledgementMs = performance.now() - start;
            const receipt = await pending, settlementMs = performance.now() - start;
            return { passed: receipt.status === 'cancelled' && acknowledgementMs <= 1000 && settlementMs <= 3000 && !receipt.output && unchanged(f, before),
                details: { receipt, stopAtEpochMs, acknowledgementMs, settlementMs, terminationVerification: 'external browser worker-close collector required' } };
        });
        await check('post-stop-job', async () => { const f = await fixture([{ v: 2 }, { v: 3 }]); const receipt = await f.run('return input.facts.rows.reduce((s,r)=>s+r.v,0);');
            return { passed: receipt.status === 'succeeded' && f.output() === 5, details: { receipt, output: f.output() } }; });
        await check('job-deadline', async () => { const f = await fixture([{ v: 1 }]), before = snapshot(f); const receipt = await f.run('while(true){}');
            return { passed: receipt.status !== 'succeeded' && ['guest_deadline', 'guest_worker_deadline', 'execution_deadline'].includes(receipt.reasonCode)
                && !receipt.output && unchanged(f, before), details: { receipt, defaultJobLimitMs: 30000 } }; });
        await check('sql-million-row-file', async () => {
            const chunks: string[] = ['id,g,v,pad\n'];
            let bytes = chunks[0].length;
            for (let start=0;start<1000000;start+=5000) {
                let chunk='';
                for (let i=start;i<start+5000;i++) {
                    const prefix=`${i===999998?0:i},${i%2?'B':'A'},${i===999999?-5:1},`;
                    const line=prefix+'x'.repeat(103-prefix.length)+'\n'; chunk+=line;
                }
                chunks.push(chunk);bytes+=chunk.length;
                await new Promise<void>(resolve=>setTimeout(resolve,0));
                if(signal.aborted)throw new Error('scope_revoked');
            }
            // Extend the last field to the exact 100 MiB intake byte boundary.
            const last=chunks.pop()!;chunks.push(last.slice(0,-1)+'x'.repeat(104857600-bytes)+'\n');
            const file=new File(chunks,'synthetic-capacity.csv',{type:'text/csv'});
            sql=new DuckDbWorkerClient(()=>sqlStarted?.());
            await sql.initDuckDb(45000,signal);
            const loaded=await sql.loadFileDataset({...sqlBinding,file,csvFileName:file.name,previewRows:10},180000,signal);
            const result=await sql.executeRawQuery({sql:'SELECT COUNT(*) n,COUNT(DISTINCT id) distinct_ids,SUM(TRY_CAST(v AS BIGINT)) total FROM session_clean_dataset',limit:500,selectedColumns:[],expectedBinding:sqlBinding},60000,signal);
            const row=result.rows[0];
            return {passed:file.size===104857600&&loaded.rowCount===1000000&&Number(row?.n)===1000000&&Number(row?.distinct_ids)===999999
                &&Number(row?.total)===999994&&!result.truncated,details:{fileBytes:file.size,loadedRows:loaded.rowCount,previewRows:loaded.preview.length,result}};
        });
        await check('sql-stop', async () => {
            if(!sql)throw new Error('sql_not_initialized');
            const stop=new AbortController();let stopAtEpochMs=0,acknowledgementMs=0;
            let timer:ReturnType<typeof setTimeout>|undefined;
            sqlStarted=()=>{if(timer)return;timer=setTimeout(()=>{stopAtEpochMs=Date.now();const start=performance.now();stop.abort();acknowledgementMs=performance.now()-start;},100);};
            let cancelled=false;
            try{await sql.executeRawQuery({sql:'SELECT SUM(sin(a.range+b.range)) n FROM range(1000000) a CROSS JOIN range(1000000) b',limit:500,selectedColumns:[],expectedBinding:sqlBinding},60000,stop.signal);}
            catch{cancelled=stop.signal.aborted;}
            finally{clearTimeout(timer);sqlStarted=undefined;}
            const settlementMs=Date.now()-stopAtEpochMs;
            return {passed:cancelled&&stopAtEpochMs>0&&acknowledgementMs<=1000&&settlementMs<=3000,
                details:{cancelled,stopAtEpochMs,acknowledgementMs,settlementMs,terminationVerification:'external worker-close collector required'}};
        });
        await check('sql-recovery', async () => {
            if(!sql)throw new Error('sql_not_initialized');
            const result=await sql.executeRawQuery({sql:'SELECT COUNT(*) n,SUM(TRY_CAST(v AS BIGINT)) total FROM session_clean_dataset',limit:500,selectedColumns:[],expectedBinding:sqlBinding},60000,signal);
            return {passed:Number(result.rows[0]?.n)===1000000&&Number(result.rows[0]?.total)===999994&&result.executionBoundary?.locked===true,details:{result}};
        });
        return resolveCapacityVerdict(observations, signal.aborted);
    } finally { cleanup(); signal.removeEventListener('abort',abortSql);sql?.retireSession(); }
};
