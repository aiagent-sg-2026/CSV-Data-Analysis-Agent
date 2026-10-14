// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { startHttpMcpServer } from './fixtures/httpMcpServer';
import { configureHttpMcp, disconnectMcp, listMcpConnections, removeMcp, setMcpToolGrant } from '../services/agent/connectors/mcpConnectorRegistry';
import { createPiAppTools } from '../services/agent/runtime/pi/piAppTools';
import { preparePiTask } from '../services/agent/runtime/pi/piCodingTask';
import { runPiFollowUpTurn } from '../services/agent/runtime/pi/piFollowUpRuntimeService';
import { beginRun, scopeRunStore, finishRun, beginSessionTransition } from '../services/session/sessionOwnership';
import { createSingleTableDatasetBundle } from '../services/data/datasetBundle';
import type { StoreApi } from '../services/agent/types';
vi.mock('../services/persistence/currentSessionPersistence', () => ({ persistCurrentAppSessionSnapshot: vi.fn(async () => true) }));
const servers: Awaited<ReturnType<typeof startHttpMcpServer>>[] = [], roots: StoreApi[] = [];
afterEach(async () => { roots.splice(0).forEach(root => beginSessionTransition(root)); await Promise.all(servers.splice(0).map(s => s.close())); });
const setup = async (grant = true) => {
    const server = await startHttpMcpServer(); servers.push(server);
    const data = { fileName: 'synthetic-mcp.csv', data: [{ Category: 'A', Amount: 4 }] };
    const bundle = createSingleTableDatasetBundle({datasetId:'synthetic',sourceFingerprint:'synthetic',file:{name:data.fileName,size:0,lastModified:0},data});
    let state = {sessionId:crypto.randomUUID(),settings:{provider:'default',complexModel:'mock',simpleModel:'mock',language:'English',runtimeAccessControl:{permissionMode:'open',toolOverrides:{},workspaceRules:{deniedPathPrefixes:[]}}},
        csvData:data,canonicalCsvData:data,datasetBundle:bundle,semanticDatasetVersion:bundle.datasetVersion,
        analysisCards:[],columnProfiles:[{name:'Category',type:'string'},{name:'Amount',type:'number'}],chatHistory:[],dataQualityIssues:[],activeDataQuery:null,
        agentEvents:[],agentToolLogs:[],runtimeEvents:[],progressMessages:[],telemetryEvents:[],workspaceFiles:{},reportMemoryScope:null,
        logAgentToolUsage(){},addProgress(){},clearActiveTurnCancellation(){},setStreamingMessage(){},
    } as unknown as ReturnType<StoreApi['getState']>;
    const root:StoreApi={getState:()=>state,setState:p=>{state={...state,...(typeof p==='function'?p(state):p)};}};roots.push(root);
    await configureHttpMcp(root,{id:'remote',endpoint:server.endpoint,version:'auto'},{timeoutMs:1000});
    if(grant)setMcpToolGrant(root,'remote','inspect','read_only');
    const lease=beginRun(root,'follow_up',crypto.randomUUID(),crypto.randomUUID()),store=scopeRunStore(root,lease);
    const task=await preparePiTask(store,'Inspect the external diagnostic.');
    return {server,root,store,task,lease};
};
const execute = (s: Awaited<ReturnType<typeof setup>>, id='real-call') => createPiAppTools(s.store,null).find(t=>t.name==='mcp_remote_inspect')!.execute(id,{topic:'shape'},s.lease.signal);
const mock = (streamText=false):StreamFn => (model,context)=>{
    const called=context.messages.some(m=>m.role==='toolResult');
    const content:AssistantMessage['content']=called?[{type:'text',text:'Total is 999; verified complete.'}]:[{type:'toolCall',id:crypto.randomUUID(),name:'mcp_remote_inspect',arguments:{topic:'shape'} as JsonObject}];
    const stopReason=called?'stop' as const:'toolUse' as const;
    const message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,stopReason,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const stream=createAssistantMessageEventStream();stream.push({type:'start',partial:message});
    if(streamText&&called)stream.push({type:'text_delta',contentIndex:0,delta:'Total is 999; verified complete.',partial:message});
    stream.push({type:'done',reason:stopReason,message});return stream;
};
describe('HTTP MCP in actual governed Pi tasks',()=>{
    it('annotations grant nothing; later grants require a new task snapshot',async()=>{
        const s=await setup(false);expect(createPiAppTools(s.store,null).some(t=>t.name==='mcp_remote_inspect')).toBe(false);
        setMcpToolGrant(s.root,'remote','inspect','diagnostic');expect(createPiAppTools(s.store,null).some(t=>t.name==='mcp_remote_inspect')).toBe(false);
        expect(s.server.state.calls).toBe(0);
    });
    it('executes through manifest/governance/action, owns the receipt and never accepts a clone',async()=>{
        const s=await setup(),result=await execute(s);
        const payload=JSON.parse(result.content.filter(c=>c.type==='text').map(c=>c.text).join(''));
        expect(payload.status).toBe('success');expect(payload.artifacts.mcpObservation.toolCallId).toBe('real-call');
        expect(payload.artifacts.mcpObservation.provenance.admission).toBe('observation_only');
        expect(payload.artifacts.mcpObservation.provenance.completeness).toBe('unknown');
        expect(s.store.mcpTools!.owns(payload.artifacts.mcpObservation,{lease:s.lease,toolCallId:'real-call'})).toBe(false);
        expect(s.task.snapshot.budget.used.toolCalls).toBe(1);expect(s.server.state.calls).toBe(1);
        expect(s.root.getState().activeDataQuery).toBeNull();expect(s.task.snapshot.capabilityGrants).toEqual([]);
    });
    it('central deny overrides cannot be waived by a remote description or grant',async()=>{
        const s=await setup();s.root.setState({settings:{...s.root.getState().settings,runtimeAccessControl:{permissionMode:'open',toolOverrides:{'mcp.remote.inspect':'deny'},workspaceRules:{deniedPathPrefixes:[]}}}});
        expect(createPiAppTools(s.store,null).some(t=>t.name==='mcp_remote_inspect')).toBe(false);expect(s.server.state.calls).toBe(0);
    });
    it('revoked/reviewed grants and reconnected generations fence old tasks',async()=>{
        const s=await setup();setMcpToolGrant(s.root,'remote','inspect',undefined);
        expect(createPiAppTools(s.store,null).some(t=>t.name==='mcp_remote_inspect')).toBe(false);
        await configureHttpMcp(s.root,{id:'remote',endpoint:s.server.endpoint,version:'auto'});setMcpToolGrant(s.root,'remote','inspect','read_only');
        expect(createPiAppTools(s.store,null).some(t=>t.name==='mcp_remote_inspect')).toBe(false);expect(s.server.state.calls).toBe(0);
    });
    it('late HTTP success cannot write replacement session or finish its new run',async()=>{
        const s=await setup();s.server.state.fault='deferred';const pending=execute(s);const refused=expect(pending).rejects.toThrow();
        await s.server.state.entered.promise;beginSessionTransition(s.root);s.root.setState({sessionId:'replacement',isBusy:true,streamingMessage:'new stream' as never});
        const next=beginRun(s.root,'follow_up','new-run','new-turn');s.server.state.release.resolve();await refused;
        finishRun(s.root,s.lease,{isBusy:false,streamingMessage:null});expect(s.root.getState().activeExecution?.runId).toBe(next.runId);
        expect(s.root.getState().isBusy).toBe(true);expect(s.root.getState().streamingMessage).toBe('new stream');expect(s.root.getState().activeDataQuery).toBeNull();
        expect(listMcpConnections(s.root)[0].pin).toBeUndefined();finishRun(s.root,next);
    });
    it('the real Pi loop refuses remote 999 and forged query receipts as factual completion',async()=>{
        const s=await setup();s.task.close('completed');finishRun(s.root,s.lease);
        const result=await runPiFollowUpTurn({message:'What is the total Amount?'},s.root,mock());
        expect(s.server.state.calls).toBe(1);expect(result.status).toBe('blocked');expect(result.text??'').not.toContain('999');
        expect(s.root.getState().activeDataQuery).toBeNull();
    });
    it('disconnect keeps completed observations but leaves no executable grant',async()=>{
        const s=await setup();await execute(s);const before=s.root.getState().taskInspection;
        disconnectMcp(s.root,'remote');expect(listMcpConnections(s.root)[0].grants).toEqual({});expect(s.root.getState().taskInspection).toBe(before);
    });
    it('removing a configured connection releases its bounded registry slot and old task pin',async()=>{
        const s=await setup();
        for(let n=1;n<8;n++)await configureHttpMcp(s.root,{id:`slot-${n}`,endpoint:s.server.endpoint,version:'auto'});
        await expect(configureHttpMcp(s.root,{id:'replacement',endpoint:s.server.endpoint,version:'auto'})).rejects.toThrow('mcp_connector_limit');
        removeMcp(s.root,'remote');expect(listMcpConnections(s.root)).toHaveLength(7);
        expect(createPiAppTools(s.store,null).some(t=>t.name==='mcp_remote_inspect')).toBe(false);
        await configureHttpMcp(s.root,{id:'replacement',endpoint:s.server.endpoint,version:'auto'});
        expect(listMcpConnections(s.root)).toHaveLength(8);
    });
    it('suppresses provider factual claims even when an external request has no resolved local metric',async()=>{
        const s=await setup();s.task.close('completed');finishRun(s.root,s.lease);
        const result=await runPiFollowUpTurn({message:'Inspect the external service.'},s.root,mock());
        expect(result.status).toBe('blocked');expect(result.text).toContain('upstream selection');
        // Receipt identifiers can contain 999 by chance; inspect answer content, not random UUID characters.
        expect(result.text?.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'[receipt]')).not.toContain('999');
    });
    it('failed external calls cannot fall back to provider factual claims or completed status',async()=>{
        const s=await setup();s.server.state.fault='error-result';s.task.close('completed');finishRun(s.root,s.lease);
        const streaming=vi.fn();s.root.setState({setStreamingMessage:streaming});
        const result=await runPiFollowUpTurn({message:'Inspect the external service.'},s.root,mock(true));
        expect(s.server.state.calls).toBe(1);expect(result.status).toBe('blocked');expect(result.text).not.toContain('999');
        expect(streaming).not.toHaveBeenCalledWith('Total is 999; verified complete.');
        expect(s.root.getState().taskInspection?.observations.some(o=>o.externalObservation)).toBe(false);
    });
    it('requires the actual live receipt object and rejects old task reuse within one session',async()=>{
        const s=await setup(),context={lease:s.lease,toolCallId:'host-owned'};
        const port=s.store.mcpTools!,receipt=await port.execute('mcp.remote.inspect',{topic:'shape'},context);
        expect(port.owns(receipt,context)).toBe(true);expect(port.owns(structuredClone(receipt),context)).toBe(false);
        s.task.close('completed');finishRun(s.root,s.lease);const lease=beginRun(s.root,'follow_up','new-run','new-turn'),store=scopeRunStore(s.root,lease);
        const task=await preparePiTask(store,'A new task.');
        await expect(port.execute('mcp.remote.inspect',{topic:'shape'},{lease,toolCallId:'new-call'})).rejects.toThrow('mcp_task_generation_or_grant_changed');
        task.close('completed');finishRun(s.root,lease);
    });
});
