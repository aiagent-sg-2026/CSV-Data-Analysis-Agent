// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpMcpServer } from './fixtures/httpMcpServer';
import { connectHttpMcp, type HttpMcpAdapter } from '../services/agent/connectors/httpMcpAdapter';
import { normalizeHttpMcpConfig } from '../services/agent/connectors/httpMcpContract';
import { validateMcpSchema } from '../services/agent/connectors/mcpSchema';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
const opened: Awaited<ReturnType<typeof startHttpMcpServer>>[] = [], adapters: HttpMcpAdapter[] = [];
afterEach(async () => { adapters.splice(0).forEach(a => a.close()); await Promise.all(opened.splice(0).map(s => s.close())); });
const server = async () => { const s = await startHttpMcpServer(); opened.push(s); return s; };
const connect = async (s: Awaited<ReturnType<typeof server>>, version: 'auto' | '2026-07-28' | '2025-11-25' = 'auto', timeoutMs = 500) => {
    const adapter = await connectHttpMcp({ id: 'test', endpoint: s.endpoint, version }, { timeoutMs }); adapters.push(adapter); return adapter;
};
describe('pinned real HTTP MCP adapters', () => {
    it.each(['auto', '2026-07-28', '2025-11-25'] as const)('executes SDK tools in %s', async version => {
        const s = await server(), a = await connect(s, version);
        expect(a.pin.protocol).toBe(version === 'auto' ? '2026-07-28' : version);
        const result = await a.call(a.pin.tools[0], { topic: 'shape' }); expect(result).toBeTruthy(); expect(s.state.calls).toBe(1);
        expect(Object.isFrozen(a.pin.tools[0].inputSchema)).toBe(true);
        if (version !== '2025-11-25') expect(s.state.trace.filter(t => t.method !== 'notifications/cancelled').every(t => t.header === t.version && t.version === '2026-07-28')).toBe(true);
        else expect(s.state.trace.some(t => t.method === 'initialize')).toBe(true);
        if(version!=='2025-11-25')expect(s.state.trace.every(t=>t.methodHeader===t.method&&(t.method!=='tools/call'||t.nameHeader===t.name))).toBe(true);
    });
    it('detects a definitive legacy server and refuses modern pin downgrade', async () => {
        const s = await server(); s.state.era = 'legacy'; const a = await connect(s); expect(a.pin.protocol).toBe('2025-11-25');
        await expect(connect(s, '2026-07-28')).rejects.toThrow();
    });
    it('preserves a real legacy session header and refuses its loss without reinitializing or replay', async () => {
        const sdk = new McpServer({name:'stateful-synthetic',version:'1'});
        let calls=0, lost=false; const trace:{method:string;session?:string}[]=[];
        sdk.registerTool('inspect',{inputSchema:z.object({topic:z.string()})},async()=>{calls++;return {content:[{type:'text',text:'synthetic observation'}]};});
        const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:()=>crypto.randomUUID(),enableJsonResponse:true});
        await sdk.connect(transport);
        const http=createServer(async(req,res)=>{
            if(lost){res.writeHead(404);res.end();return;}
            if(req.method!=='POST'){await transport.handleRequest(req,res);return;}
            let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
            trace.push({method:body.method,session:req.headers['mcp-session-id'] as string});
            await transport.handleRequest(req,res,body);
        });
        await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
        try {
            const endpoint=`http://127.0.0.1:${(http.address() as {port:number}).port}/mcp`;
            const a=await connectHttpMcp({id:'stateful',endpoint,version:'2025-11-25'},{timeoutMs:1000});adapters.push(a);
            await a.call(a.pin.tools[0],{topic:'shape'});
            expect(transport.sessionId).toBeTruthy();expect(trace.filter(t=>t.method!=='initialize').every(t=>t.session===transport.sessionId)).toBe(true);
            lost=true;await expect(a.call(a.pin.tools[0],{topic:'shape'})).rejects.toThrow('mcp_server_unavailable:404');
            expect(calls).toBe(1);expect(trace.filter(t=>t.method==='initialize')).toHaveLength(1);
        } finally {await sdk.close();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));}
    });
    it('collects real pages completely and refuses loop/incomplete/malformed catalogs', async () => {
        const s = await server(); s.state.pagination = true; const a = await connect(s);
        expect(a.pin.tools.map(t => t.remoteName)).toEqual(['inspect', 'otherpage2']);
        await a.call(a.pin.tools[0], {topic:'shape'}); expect(s.state.trace.filter(t=>t.method==='tools/list')).toHaveLength(6);
        for (const fault of ['cursor-loop','too-many-pages','bad-tools','bad-result']) {
            s.state.fault=fault; await expect(connect(s)).rejects.toThrow();
        }
    });
    it('accepts request-scoped SSE and closes it on cancellation without replay', async () => {
        const s = await startHttpMcpServer('sse'); opened.push(s); const a = await connect(s);
        await a.call(a.pin.tools[0], {topic:'shape'}); s.state.fault='deferred';
        // Reset the entry signal after the first completed exchange.
        const {deferred}=await import('./fixtures/httpMcpServer'); s.state.entered=deferred();
        const controller=new AbortController(),pending=a.call(a.pin.tools[0],{topic:'shape'},controller.signal);
        const refused=expect(pending).rejects.toThrow(); await s.state.entered.promise;controller.abort();await refused;
        await s.state.cancelled.promise;s.state.release.resolve();expect(s.state.calls).toBe(2);
    });
    it.each(['large-result','error-result'])('refuses %s after successful execution', async fault => {
        const s=await server(),a=await connect(s);s.state.fault=fault;
        await expect(a.call(a.pin.tools[0],{topic:'shape'})).rejects.toThrow();expect(s.state.calls).toBe(1);
    });
    it.each(['version', 'unknown-discovery', 'response-version', 'mismatch', 'malformed', 'oversized', 'html', 'auth', 'redirect', 'timeout'])('rejects %s without accepting era or replaying a tool', async fault => {
        const s = await server(); s.state.fault = fault;
        await expect(connect(s, 'auto', 100)).rejects.toThrow(); expect(s.state.calls).toBe(0);
        if (fault === 'auth') expect(s.state.trace.some(t => t.method === 'initialize')).toBe(false);
    });
    it('invalidates schema drift before dispatch and restart instead of replay', async () => {
        const s = await server(), a = await connect(s); s.state.revision = 2;
        await expect(a.call(a.pin.tools[0], { topic: 'shape' })).rejects.toThrow('mcp_schema_changed'); expect(s.state.calls).toBe(0);
        s.state.revision = 1; const b = await connect(s); expect(b.pin.generation).not.toBe(a.pin.generation);
        s.state.fault = 'restart'; await expect(b.call(b.pin.tools[0], { topic: 'shape' })).rejects.toThrow(); expect(s.state.calls).toBe(0);
    });
    it('fences a real SDK server close/rebind at the same endpoint and requires new discovery', async () => {
        const first = await server(), a = await connect(first), port = Number(new URL(first.endpoint).port);
        await first.close(); opened.splice(opened.indexOf(first),1);
        const second = await startHttpMcpServer('auto',port,'2'); opened.push(second);
        await expect(a.call(a.pin.tools[0],{topic:'shape'})).rejects.toThrow(/mcp_(server_identity_changed|transport_cancelled_timeout_cors_or_network|generation_revoked)/);
        const b = await connect(second);expect(b.pin.generation).not.toBe(a.pin.generation);expect(b.pin.server.version).toBe('2');
        await b.call(b.pin.tools[0],{topic:'shape'});expect(second.state.calls).toBe(1);
    });
    it('refuses a changed live modern server identity before dispatch', async () => {
        const s=await server(),a=await connect(s);s.state.identityVersion='2';
        await expect(a.call(a.pin.tools[0],{topic:'shape'})).rejects.toThrow('mcp_server_identity_changed');expect(s.state.calls).toBe(0);
    });
    it('cancels in-flight actual HTTP work, retires generation and ignores later success', async () => {
        const s = await server(), a = await connect(s), controller = new AbortController(); s.state.fault = 'deferred';
        const call = a.call(a.pin.tools[0], { topic: 'shape' }, controller.signal); const rejected = expect(call).rejects.toThrow();
        await s.state.entered.promise; controller.abort(); await rejected; s.state.release.resolve();
        await expect(a.call(a.pin.tools[0], { topic: 'shape' })).rejects.toThrow('mcp_generation_revoked'); expect(s.state.calls).toBe(1);
    });
    it('bounds arguments and refuses remote refs/header passthrough/prototype schemas', async () => {
        const s = await server(), a = await connect(s);
        await expect(a.call(a.pin.tools[0], { topic: 42 })).rejects.toThrow('mcp_arguments');
        await expect(a.call(a.pin.tools[0], { topic: 'shape', _meta: { runId: 'forged' } })).rejects.toThrow('mcp_reserved_argument');
        for (const schema of [{type:'object',$ref:'https://example.invalid/schema'}, {type:'object',properties:{a:{type:'string','x-mcp-header':'Authorization'}}}, {type:'object',properties:{runId:{type:'string'}}}]) expect(() => validateMcpSchema(schema)).toThrow();
        expect(s.state.calls).toBe(0);
    });
    it('rejects unsafe endpoint identities', () => {
        for (const endpoint of ['http://example.com/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp?token=secret']) expect(() => normalizeHttpMcpConfig({id:'test',endpoint,version:'auto'})).toThrow();
    });
    it('validates real modern body/header mismatch and rejects CORS failures without downgrade', async () => {
        const s = await server();
        const response = await fetch(s.endpoint, {method:'POST', headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'synthetic',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
        expect(response.ok).toBe(false);
        await expect(connectHttpMcp({id:'cors',endpoint:s.endpoint,version:'auto'},{fetch:async()=>{throw new TypeError('Failed to fetch');}})).rejects.toThrow('mcp_transport');
        expect(s.state.trace.filter(t=>t.method==='initialize')).toHaveLength(0);
    });
});
