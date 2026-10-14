// @vitest-environment node
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { beginMcpOAuth, forgetMcpCredential, mcpAuthorization, setMcpBearerCredential } from '../services/agent/connectors/mcpCredentials';
import { deferred } from './fixtures/httpMcpServer';
const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(close=>close()));});
const oauthServer=async()=>{
    let origin='';const state={fault:'',challenge:'',received:[] as string[],tokens:0,entered:deferred(),release:deferred()};
    const server=createServer(async(req,res)=>{
        res.setHeader('Content-Type','application/json');
        const url=new URL(req.url!,origin);
        if(url.pathname==='/.well-known/oauth-protected-resource/mcp'){res.end(JSON.stringify({resource:state.fault==='resource'?'https://wrong.example/mcp':origin+'/mcp',authorization_servers:[origin+'/']}));return;}
        if(url.pathname==='/.well-known/oauth-authorization-server'){res.end(JSON.stringify({issuer:state.fault==='issuer'?'https://wrong.example/':origin+'/',authorization_endpoint:state.fault==='endpoint'?'https://wrong.example/authorize':origin+'/authorize',token_endpoint:origin+'/token',code_challenge_methods_supported:state.fault==='pkce'?['plain']:['S256'],authorization_response_iss_parameter_supported:state.fault!=='iss'}));return;}
        if(url.pathname==='/authorize'){
            state.challenge=url.searchParams.get('code_challenge')!;expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('resource')).toBe(origin+'/mcp');
            const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('code','synthetic-code');callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('iss',origin+'/');
            res.writeHead(302,{Location:callback.href});res.end();return;
        }
        if(url.pathname==='/token'){
            let raw='';for await(const chunk of req)raw+=chunk;const body=new URLSearchParams(raw);state.received.push(raw);state.tokens++;state.entered.resolve();
            if(state.fault==='deferred')await state.release.promise;
            if(body.get('resource')!==origin+'/mcp'||createHash('sha256').update(body.get('code_verifier')??'').digest('base64url')!==state.challenge){res.writeHead(400);res.end('{}');return;}
            res.end(JSON.stringify({token_type:'Bearer',access_token:'synthetic-opaque-access',expires_in:60}));return;
        }
        res.writeHead(404);res.end('{}');
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    cleanup.push(async()=>{forgetMcpCredential(origin+'/mcp');state.release.resolve();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
    return {origin,state,config:{endpoint:origin+'/mcp',issuer:origin+'/',clientId:'synthetic-public-client',redirectUri:origin+'/index.html'}};
};
const authorize=async(flow:Awaited<ReturnType<typeof beginMcpOAuth>>)=>{
    const response=await fetch(flow.authorizationUrl,{redirect:'manual'});const callback=new URL(response.headers.get('Location')!);
    return {code:callback.searchParams.get('code')!,state:callback.searchParams.get('state')!,iss:callback.searchParams.get('iss')!};
};
describe('MCP credentials stay in host custody',()=>{
    it('completes a real public-client S256/resource-bound exchange exactly once',async()=>{
        const s=await oauthServer(),flow=await beginMcpOAuth(s.config),callback=await authorize(flow);
        await flow.complete(callback);const token=mcpAuthorization(s.config.endpoint);expect(token()).toBe('synthetic-opaque-access');
        expect(mcpAuthorization(s.origin+'/another')()).toBeUndefined();expect(s.state.tokens).toBe(1);expect(s.state.received[0]).not.toContain('client_secret');
        await expect(flow.complete(callback)).rejects.toThrow('mcp_oauth_flow_expired');forgetMcpCredential(s.config.endpoint);expect(token()).toBeUndefined();
    });
    it.each(['resource','issuer','endpoint','pkce','iss'])('rejects %s metadata before authorization',async fault=>{
        const s=await oauthServer();s.state.fault=fault;await expect(beginMcpOAuth(s.config)).rejects.toThrow('mcp_oauth');expect(s.state.tokens).toBe(0);
    });
    it.each(['state','iss'])('rejects wrong %s callback before token request',async field=>{
        const s=await oauthServer(),flow=await beginMcpOAuth(s.config),callback=await authorize(flow);
        await expect(flow.complete({...callback,[field]:'wrong'})).rejects.toThrow('mcp_oauth_callback_mismatch');expect(s.state.tokens).toBe(0);
    });
    it('cancellation during token exchange publishes no credential and never retries uncertain requests',async()=>{
        const s=await oauthServer(),flow=await beginMcpOAuth(s.config),callback=await authorize(flow);s.state.fault='deferred';
        const promise=flow.complete(callback);const refused=expect(promise).rejects.toThrow('mcp_oauth_flow_expired');await s.state.entered.promise;flow.cancel();s.state.release.resolve();await refused;
        expect(s.state.tokens).toBe(1);expect(mcpAuthorization(s.config.endpoint)()).toBeUndefined();
    });
    it('binds operator bearer credentials to exact resource and invalidates old closures',async()=>{
        const s=await oauthServer();setMcpBearerCredential(s.config.endpoint,'synthetic-key-one');const first=mcpAuthorization(s.config.endpoint);
        expect(first()).toBe('synthetic-key-one');expect(mcpAuthorization(s.origin+'/other')()).toBeUndefined();
        setMcpBearerCredential(s.config.endpoint,'synthetic-key-two');expect(first()).toBeUndefined();
        expect(()=>setMcpBearerCredential(s.config.endpoint,'bad\nheader')).toThrow('mcp_invalid_credential');
    });
});
