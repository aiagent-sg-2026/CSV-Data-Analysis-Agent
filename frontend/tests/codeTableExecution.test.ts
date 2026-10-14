// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import type { CsvRow } from '../types';
import type { StoreApi } from '../services/agent/types';
import { createCodeExecutionAdapter } from '../services/agent/execution/codeExecutionAdapter';
import { createTaskWorkspace } from '../services/agent/taskWorkspace';
import { createAgentTask, transitionAgentTask } from '../services/agent/runtime/pi/piTaskContract';
import { beginRun, scopeRunStore, beginSessionTransition, cancelOwnedRun } from '../services/session/sessionOwnership';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { registerSandboxTableRows, clearSandboxTableRows } from '../services/data/sandboxTableRegistry';
import { inferDatasetTableSchema } from '../services/data/datasetBundle';

afterEach(() => { vi.restoreAllMocks(); clearSandboxTableRows(); });
const module = newQuickJSWASMModuleFromVariant(variant);
type Guest = Parameters<typeof createCodeExecutionAdapter>[3];
const setup = async (rows: CsvRow[], code: string, options: Record<string, unknown> = {}, guest?: Guest, dimensions?: CsvRow[]) => {
    const data = { fileName: 'synthetic.csv', data: rows };
    const bundle = createSingleTableDatasetBundle({ datasetId: 'synthetic', sourceFingerprint: 'synthetic',
        file: { name: data.fileName, size: 0, lastModified: 0 }, data });
    if (dimensions) {
        bundle.tables.push({ ...bundle.tables[0], tableId: 'dimensions', role: 'dimension', name: 'dimensions',
            rowCount: dimensions.length, schema: inferDatasetTableSchema(dimensions) });
        registerSandboxTableRows(bundle.bundleId, { tables: [{tableId:'dimensions',name:'dimensions',role:'dimension',rows:dimensions}],
            lineage:[],relationships:[] },bundle.datasetVersion);
    }
    let state = { sessionId: 's', csvData: data, canonicalCsvData: null, datasetBundle: bundle, columnProfiles: [], analysisCards: [],
        settings: { runtimeAccessControl: { permissionMode: 'open', toolOverrides: {}, workspaceRules: { deniedPathPrefixes: [] } } },
    } as unknown as ReturnType<StoreApi['getState']>;
    const root: StoreApi = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    const lease = beginRun(root, 'follow_up', 'run', 'turn'), store = scopeRunStore(root, lease);
    const binding = { tableId: bundle.primaryTableId, datasetVersion: bundle.datasetVersion, relationshipSetId: bundle.relationshipSetId };
    let task = transitionAgentTask(store, createAgentTask(store, lease, { goal: 'Stage complete synthetic data', kind: 'artifact',
        inputBindings: bundle.tables.map(table=>({...binding,tableId:table.tableId})), requiredOutputs: [{ id: 'out', kind: 'artifact', required: true }], protectedInvariants: [], capabilityGrants: [],
        scope: { digest: 'a'.repeat(64), intentDigest: 'a'.repeat(64), answer: { requiresEvidence: false, queries: [], unresolved: [], complete: true } },
    }), lease, 'inspecting');
    const workspace = createTaskWorkspace(store, task.taskId, { allowedPrefixes: ['/workspace/'] });
    const program = await workspace.write('/workspace/program.js', code, 0);
    const realGuest = { run: vi.fn((source: string, inputJson: string, opts: Parameters<NonNullable<Guest>['run']>[2]) =>
        executeQuickJsGuest({ generation: 1, code: source, inputJson, limits: resolveGuestLimits(opts.limits) }, () => module, opts.onStarted)), cancel() {}, dispose() {} };
    const adapter = createCodeExecutionAdapter(store, workspace, () => task, guest ?? realGuest);
    const grant = await adapter.issueGrant({ readPaths: [program.path], writePaths: ['/workspace/result.json'], expiresAt: Date.now()+60000,
        tableIds: bundle.tables.map(table=>table.tableId),
    } as never);
    task = { ...task, capabilityGrants: [grant] };
    const context = { lease, toolCallId: 'host-call', stepId: 'host-step' };
    const request = { program: { path: program.path, revision: program.revision, sha256: program.sha256 }, inputs: [],
        tables: [{ name: 'facts', tableId: binding.tableId }, ...(dimensions?[{name:'dims',tableId:'dimensions'}]:[])], output: { path: '/workspace/result.json', expectedRevision: 0, format: 'json' }, ...options };
    return { root, store, lease, workspace, adapter, context, request, realGuest, task, binding,
        run: () => adapter.run(request as never, context), output: () => JSON.parse(workspace.read('/workspace/result.json').content) };
};

describe('complete-table admission and semantics', () => {
    it('joins complete versioned dimension inputs and preserves group grain across the boundary', async()=>{
        const rows=Array.from({length:5003},(_,i)=>({id:i,code:i%2?'B':'A',value:i===5002?-5:1}));
        const s=await setup(rows,`const names=new Map(input.dims.rows.map(r=>[r.code,r.name])); return input.facts.rows.map(r=>({...r,name:names.get(r.code)}));`,{},undefined,[{code:'A',name:'Alpha'},{code:'B',name:'Beta'}]);
        try{const receipt=await s.run();expect(receipt.status,JSON.stringify(receipt)).toBe('succeeded');
            const out=s.output() as CsvRow[];expect(out.length).toBe(5003);expect(new Set(out.map(r=>r.id)).size).toBe(5003);
            expect(out.filter(r=>r.name==='Alpha').reduce((s,r)=>s+Number(r.value),0)).toBe(2496);
            expect(out.filter(r=>r.name==='Beta').reduce((s,r)=>s+Number(r.value),0)).toBe(2501);
            expect(receipt.coverage).toHaveLength(2);
            clearSandboxTableRows();expect((await s.adapter.run({...s.request,output:{...s.request.output,expectedRevision:1}} as never,s.context)).reasonCode).toBe('complete_input_unavailable');
        }finally{s.adapter.dispose();}
    });
    it('executes the advertised 50,000-row envelope without substituting a sample',async()=>{
        const s=await setup(Array.from({length:50000},(_,i)=>({v:i===49999?-3:1})),`return {rows:input.facts.rows.length,total:input.facts.rows.reduce((s,r)=>s+r.v,0)};`);
        try{expect((await s.run()).status).toBe('succeeded');expect(s.output()).toEqual({rows:50000,total:49996});}finally{s.adapter.dispose();}
    });
    it('does not relabel an output committed before the deadline when terminal inspection crosses it', async () => {
        const s = await setup([{ id: 1 }], 'return 1;');
        const started = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => started
            + (s.workspace.revision('/workspace/result.json') === 1 ? 30001 : 0));
        try {
            const receipt = await s.run();
            expect(receipt.status).toBe('succeeded');
            expect(receipt.output?.revision).toBe(1);
            expect(s.output()).toBe(1);
        } finally { s.adapter.dispose(); }
    });
    it('defaults arbitrary source to the whole table and detects a tail fault beyond 5,000 rows', async () => {
        const rows = Array.from({ length: 10003 }, (_, i) => ({ id: i, value: i === 10002 ? -7 : 1 }));
        const s = await setup(rows, 'return {count: input.facts.rows.length, total: input.facts.rows.reduce((s,r)=>s+r.value,0), tail:input.facts.rows.at(-1).id};');
        try {
            const receipt = await s.run();
            expect(receipt.status, JSON.stringify(receipt)).toBe('succeeded');
            expect(s.output()).toEqual({ count: 10003, total: 9995, tail: 10002 });
            expect(receipt).toMatchObject({ mode: 'whole_table', coverage: [{ ...s.binding, name: 'facts', rowCount: 10003, deliveredRows: 10003, complete: true }] });
            expect(s.root.getState().csvData!.data).toEqual(rows);
        } finally { s.adapter.dispose(); }
    });
    it('preserves global dedup, sort, subtotal and reshape semantics', async () => {
        const rows = Array.from({ length: 5004 }, (_, i) => ({ id: i === 5000 ? 0 : i, kind: i === 5002 ? 'subtotal' : 'fact', amount: i === 5003 ? -5 : 1, other: 2 }));
        const s = await setup(rows, `const seen=new Set(); return input.facts.rows.filter(r=>r.kind==='fact' && !seen.has(r.id) && seen.add(r.id)).sort((a,b)=>b.id-a.id).flatMap(r=>[{id:r.id,metric:'amount',value:r.amount},{id:r.id,metric:'other',value:r.other}]);`);
        try {
            expect((await s.run()).status).toBe('succeeded');
            const out = s.output() as Array<{id: number; metric: string; value: number}>;
            const expectedIds = Array.from({length:5004}, (_,i)=>i).filter(i=>i!==5000 && i!==5002).reverse();
            expect(out.filter(r=>r.metric==='amount').map(r=>r.id)).toEqual(expectedIds);
            expect(out.length).toBe(10004);
            expect(out.reduce((sum,r)=>sum+r.value,0)).toBe(15000);
        } finally { s.adapter.dispose(); }
    });
    it.each(['row_map', 'backing', 'missing', 'rows', 'bytes', 'denied'] as const)('refuses %s before guest dispatch and keeps accepted data', async kind => {
        const rows = kind === 'bytes' ? [{ text: 'x'.repeat(8*1024*1024) }] : [{ id: 1 }];
        const s = await setup(rows, 'return input.facts.rows;', kind === 'row_map' ? { mode: 'row_map' } : {});
        const state = s.root.getState(), bundle = state.datasetBundle!;
        if (kind === 'backing') s.root.setState({csvData:{...state.csvData!,backing:{mode:'duckdb_file',rowCount:9000,datasetVersion:bundle.datasetVersion,loadVersion:'backing',sampleRowCount:1,byteSize:1,ephemeral:true,readOnly:true}}});
        if (kind === 'missing') s.root.setState({csvData:null});
        if (kind === 'rows') s.root.setState({datasetBundle:{...bundle,tables:[{...bundle.tables[0],rowCount:50001}]}});
        if (kind === 'denied') s.root.setState({settings:{...state.settings,runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:['/dataset']}}}});
        try {
            const before = s.root.getState().csvData;
            const receipt = await s.run();
            expect(receipt.status).toBe('blocked'); expect(receipt.output).toBeUndefined();
            expect(s.realGuest.run).not.toHaveBeenCalled();
            expect(s.workspace.revision('/workspace/result.json')).toBe(0);
            expect(s.root.getState().csvData).toBe(before);
        } finally { s.adapter.dispose(); }
    });
});

describe('explicit stateful carry, reset and checkpoints', () => {
    const options = { mode: 'stateful_stream', stream: { table: 'facts', batchRows: 5000, partitionBy: [], initialState: null } };
    it('executes all 50,000 rows with carry and a single final aggregate',async()=>{
        const s=await setup(Array.from({length:50000},(_,i)=>({v:i===49999?-3:1})),`const state=(input.stream.state||0)+input.facts.rows.reduce((s,r)=>s+r.v,0);return {state,rows:input.stream.phase==='finish'?[{total:state}]:[]};`,options);
        try{const receipt=await s.run();expect(receipt.status,JSON.stringify(receipt)).toBe('succeeded');expect(s.output()).toEqual([{total:49996}]);expect(receipt.checkpoints).toHaveLength(11);
            expect(receipt.checkpoints!.at(-1)?.nextRow).toBe(50000);
            expect(receipt.checkpoints!.every(check=>/^[a-f0-9]{64}$/.test(check.digest)&&/^[a-f0-9]{64}$/.test(check.stateDigest))).toBe(true);
        }finally{s.adapter.dispose();}
    });
    it('uses no hidden global or closure carry and does not carry into a second job',async()=>{
        const s=await setup([{id:1},{id:2}],`if(globalThis.hidden)throw new Error('hidden carry');globalThis.hidden=true; const state=(input.stream.state||0)+input.facts.rows.length;return {state,rows:input.stream.phase==='finish'?[state]:[]};`,{...options,stream:{...options.stream,batchRows:1}});
        try{expect((await s.run()).status).toBe('succeeded');expect(s.output()).toEqual([2]);
            const second=await s.adapter.run({...s.request,output:{...s.request.output,expectedRevision:1}} as never,s.context);
            expect(second.status).toBe('succeeded');expect(s.output()).toEqual([2]);
        }finally{s.adapter.dispose();}
    });
    it('handles zero rows as a complete input and executes one finish step',async()=>{
        const s=await setup([],`return {state:input.stream.state,rows:[]};`,options);
        try{const receipt=await s.run();expect(receipt.status).toBe('succeeded');expect(s.output()).toEqual([]);expect(receipt.checkpoints).toHaveLength(1);
            expect(receipt.coverage).toMatchObject([{rowCount:0,deliveredRows:0,complete:true}]);
        }finally{s.adapter.dispose();}
    });
    it('rejects an unknown partition column even when the complete input is empty', async () => {
        const s = await setup([], 'return {state:null,rows:[]};', {
            ...options, stream: { ...options.stream, partitionBy: ['missing'] },
        });
        try {
            expect((await s.run()).reasonCode).toBe('validation_failed');
            expect(s.realGuest.run).not.toHaveBeenCalled();
            expect(s.workspace.revision('/workspace/result.json')).toBe(0);
        } finally { s.adapter.dispose(); }
    });
    it('shares one execution deadline across batches and rejects a late result before staging', async () => {
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const timeouts: number[] = [];
        const guest = {
            run: vi.fn((_code, _json, opts) => {
                timeouts.push(opts.limits.timeoutMs);
                opts.onStarted?.();
                now += timeouts.length === 1 ? 10000 : 21000;
                return Promise.resolve({ generation: timeouts.length, status: 'completed' as const,
                    code: 'guest_completed', outputJson: '{"state":null,"rows":[]}' });
            }), cancel() {}, dispose() {},
        };
        const s = await setup([{ id: 1 }, { id: 2 }], 'return {state:null,rows:[]};', {
            ...options, stream: { ...options.stream, batchRows: 1 },
        }, guest);
        try {
            const receipt = await s.run();
            expect(receipt.reasonCode).toBe('execution_deadline');
            expect(timeouts).toEqual([30000, 20000]);
            expect(receipt.checkpoints).toHaveLength(1);
            expect(receipt.output).toBeUndefined();
            expect(s.workspace.revision('/workspace/result.json')).toBe(0);
        } finally { s.adapter.dispose(); }
    });
    it('enforces cumulative output/log limits across successful batches',async()=>{
        const s=await setup([{id:1},{id:2}],`console.log('😀'.repeat(3000));return {state:null,rows:input.stream.phase==='batch'?[{x:'x'.repeat(600000)}]:[]};`,{...options,stream:{...options.stream,batchRows:1}});
        try{const receipt=await s.run();expect(receipt.status).toBe('blocked');expect(receipt.reasonCode).toBe('resource_limit');expect(receipt.output).toBeUndefined();
            expect(receipt.checkpoints).toHaveLength(1);expect(receipt.logsTruncated).toBe(true);expect(new TextEncoder().encode(receipt.stdout).length).toBeLessThanOrEqual(16384);
            expect(s.workspace.revision('/workspace/result.json')).toBe(0);
        }finally{s.adapter.dispose();}
    });
    it('rejects invented checkpoint authority and ungranted table identity',async()=>{
        const s=await setup([{id:1}],`return {state:null,rows:[]};`,options);
        try{
            expect((await s.adapter.run({...s.request,stream:{...options.stream,checkpoint:{nextRow:5000}}} as never,s.context)).reasonCode).toBe('validation_failed');
            expect((await s.adapter.run({...s.request,tables:[{name:'facts',tableId:'foreign'}]} as never,s.context)).reasonCode).toBe('approval_invalid');
            expect(s.realGuest.run).not.toHaveBeenCalled();
        }finally{s.adapter.dispose();}
    });
    it('carries dedup identity across batch boundaries and records complete host coverage', async () => {
        const rows = Array.from({length:5003}, (_,i)=>({id:i===5000?0:i,value:i===5002?-5:1}));
        const s = await setup(rows, `const seen=input.stream.state || []; const rows=[]; for(const r of input.facts.rows) if(!seen.includes(r.id)){seen.push(r.id);rows.push(r)} return {state:seen,rows};`, options);
        try {
            const receipt = await s.run(); expect(receipt.status,JSON.stringify(receipt)).toBe('succeeded');
            expect(s.output().map((r:CsvRow)=>r.id)).toEqual(Array.from({length:5003},(_,i)=>i).filter(i=>i!==5000));
            expect(s.output().reduce((sum:number,r:CsvRow)=>sum+Number(r.value),0)).toBe(4996);
            expect(receipt).toMatchObject({mode:'stateful_stream',coverage:[{deliveredRows:5003,complete:true}]});
            expect((receipt as unknown as {checkpoints:unknown[]}).checkpoints).toHaveLength(3);
            expect(s.realGuest.run).toHaveBeenCalledTimes(3);
        } finally {s.adapter.dispose();}
    });
    it('carries forward-fill, resets at partition changes and flushes subtotal reconciliation', async () => {
        const rows = Array.from({length:10004},(_,i)=>({partition:i<5002?'A':'B',kind:i===5001||i===10003?'subtotal':'fact',
            label:i===0?'alpha':i===5002?'beta':'',value:i===5001?5001:i===10003?10002:i>=5002?2:1}));
        const code = `let state=input.stream.state || {label:'',sum:0}; const rows=[]; for(const r of input.facts.rows){ if(r.kind==='subtotal'){if(state.sum!==r.value) throw new Error('subtotal mismatch'); continue;} if(r.label)state.label=r.label;state.sum+=r.value;rows.push({partition:r.partition,label:state.label,value:r.value});} if(input.stream.phase==='finish') rows.push({partition:input.stream.partitionIndex,sum:state.sum}); return {state,rows};`;
        const s = await setup(rows,code,{...options,stream:{...options.stream,partitionBy:['partition']}});
        try {
            const receipt = await s.run(); expect(receipt.status,JSON.stringify(receipt)).toBe('succeeded');
            const out=s.output() as CsvRow[];
            expect(out.filter(r=>r.partition==='A')).toHaveLength(5001);
            expect(out.filter(r=>r.partition==='B')).toHaveLength(5001);
            expect(out.filter(r=>r.partition==='A').every(r=>r.label==='alpha')).toBe(true);
            expect(out.filter(r=>r.partition==='B').every(r=>r.label==='beta')).toBe(true);
            expect(out.filter(r=>typeof r.partition==='number').map(r=>r.sum)).toEqual([5001,10002]);
        } finally{s.adapter.dispose();}
    });
    it.each(['noncontiguous','steps','state','shape','tail'] as const)('refuses invalid %s without a partial artifact',async kind=>{
        const rows=kind==='noncontiguous'?[{p:'A'},{p:'B'},{p:'A'}]:Array.from({length:5001},(_,i)=>({id:i}));
        const code=kind==='state'?`return {state:'x'.repeat(65537),rows:[]};`:kind==='shape'?`return {state:null,rows:[],complete:true};`:kind==='tail'?`if(input.facts.rows.some(r=>r.id===5000))throw new Error('tail fault'); return {state:null,rows:input.facts.rows};`:`return {state:null,rows:[]};`;
        const s=await setup(rows,code,{...options,stream:{...options.stream,batchRows:kind==='steps'?1:5000,partitionBy:kind==='noncontiguous'?['p']:[]}});
        try{const receipt=await s.run();expect(receipt.status).not.toBe('succeeded');expect(receipt.output).toBeUndefined();expect(s.workspace.revision('/workspace/result.json')).toBe(0);
            if(kind==='noncontiguous'||kind==='steps')expect(s.realGuest.run).not.toHaveBeenCalled();
        }finally{s.adapter.dispose();}
    });
    it.each(['version','session','stop'] as const)('fences a late first batch after %s change',async kind=>{
        let release!:(value:Awaited<ReturnType<NonNullable<Guest>['run']>>)=>void, enter!:()=>void;
        const entered=new Promise<void>(resolve=>{enter=resolve;});
        const guest={run:vi.fn((_code,_json,opts)=>{opts.onStarted?.();enter();return new Promise<Awaited<ReturnType<NonNullable<Guest>['run']>>>(resolve=>{release=resolve;});}),cancel(){},dispose(){}};
        const s=await setup(Array.from({length:5001},(_,i)=>({id:i})),'return {state:null,rows:input.facts.rows};',options,guest);
        const pending=s.run();await entered;
        if(kind==='version'){const b=s.root.getState().datasetBundle!;s.root.setState({datasetBundle:{...b,tables:[{...b.tables[0],datasetVersion:'new'}]}});}
        if(kind==='session'){beginSessionTransition(s.root);s.root.setState({sessionId:'new'});}
        if(kind==='stop')cancelOwnedRun(s.root);
        release({generation:1,status:'completed',code:'guest_completed',outputJson:'{"state":null,"rows":[]}'});
        const receipt=await pending;expect(receipt.status).not.toBe('succeeded');expect(receipt.output).toBeUndefined();expect(guest.run).toHaveBeenCalledOnce();s.adapter.dispose();
    });
});
