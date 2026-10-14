import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { configureHttpMcp, disconnectMcp, listMcpConnections, removeMcp, setMcpToolGrant, subscribeMcpConnections } from '../../services/agent/connectors/mcpConnectorRegistry';
import { normalizeHttpMcpConfig, type HttpMcpConfig, type McpEffect } from '../../services/agent/connectors/httpMcpContract';
import { beginMcpOAuth, forgetMcpCredential, mcpAuthorization, setMcpBearerCredential } from '../../services/agent/connectors/mcpCredentials';
import { captureSessionScope, ownsSessionScope, registerSessionResource } from '../../services/session/sessionOwnership';

const CONFIG_KEY = 'csv-agent-http-mcp-v1';
const loadConfigs = (): HttpMcpConfig[] => { try {
    const value: unknown = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '[]');
    if (!Array.isArray(value) || value.length > 8) return [];
    return value.map(normalizeHttpMcpConfig);
} catch { return []; } };
const store = { getState: useAppStore.getState, setState: useAppStore.setState };

export const McpConnectorsSection: React.FC = () => {
    const [configs, setConfigs] = useState(loadConfigs), [connections, setConnections] = useState(() => listMcpConnections(store));
    const [id, setId] = useState(''), [endpoint, setEndpoint] = useState(''), [version, setVersion] = useState<HttpMcpConfig['version']>('auto');
    const [auth, setAuth] = useState('none'), [token, setToken] = useState(''), [issuer, setIssuer] = useState(''), [clientId, setClientId] = useState('');
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const cancelAuth = useRef<(() => void) | null>(null), mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelAuth.current?.(); }; }, []);
    useEffect(() => subscribeMcpConnections(store, () => setConnections(listMcpConnections(store))), []);
    useEffect(() => { try { localStorage.setItem(CONFIG_KEY, JSON.stringify(configs)); } catch { setError('Connection settings could not be saved.'); } }, [configs]);
    const connect = async (config: HttpMcpConfig) => {
        setBusy(true); setError('');
        try { await configureHttpMcp(store, config, { token: mcpAuthorization(config.endpoint) }); }
        catch (e) { setError(e instanceof Error ? e.message : 'Connection failed.'); }
        finally { if (mounted.current) setBusy(false); }
    };
    const add = async () => {
        setError('');
        try {
            const scope = captureSessionScope(store);
            const config = normalizeHttpMcpConfig({ id, endpoint, version });
            if (configs.length >= 8 && !configs.some(c => c.id === id)) throw new Error('Maximum eight connections.');
            disconnectMcp(store, id);
            if (auth === 'bearer') { setMcpBearerCredential(config.endpoint, token); setToken(''); }
            if (auth === 'none') forgetMcpCredential(config.endpoint);
            if (auth === 'oauth') {
                const popup = window.open('about:blank', 'csv-mcp-oauth', 'popup,width=600,height=700');
                if (!popup) throw new Error('Allow the sign-in popup to continue.');
                setBusy(true);
                try {
                    const flow = await beginMcpOAuth({ endpoint: config.endpoint, issuer, clientId,
                        redirectUri: new URL('index.html', window.location.href).href.split('?')[0] });
                    if (!mounted.current || !ownsSessionScope(store, scope)) { flow.cancel(); throw new Error('Sign-in cancelled because the session changed.'); }
                    await new Promise<void>((resolve, reject) => {
                        let unregister = () => {};
                        const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); popup.close(); unregister(); cancelAuth.current = null; };
                        const cancel = () => { flow.cancel(); cleanup(); reject(new Error('Sign-in cancelled.')); };
                        const receive = (event: MessageEvent) => {
                            if (event.origin !== window.location.origin || event.source !== popup || event.data?.kind !== 'csv-mcp-oauth') return;
                            clearTimeout(timer); window.removeEventListener('message', receive); popup.close();
                            flow.complete(event.data).then(() => { cleanup(); resolve(); }, e => { cleanup(); reject(e); });
                        };
                        const timer = setTimeout(() => { cleanup(); flow.cancel(); reject(new Error('Sign-in expired.')); }, 120_000);
                        cancelAuth.current = cancel; unregister = registerSessionResource(scope, cancel);
                        window.addEventListener('message', receive); popup.location.href = flow.authorizationUrl;
                    });
                } finally { popup.close(); if (mounted.current) setBusy(false); }
            }
            if (!mounted.current || !ownsSessionScope(store, scope)) throw new Error('Connection cancelled because the session changed.');
            setConfigs(current => [...current.filter(c => c.id !== config.id), config]);
            await connect(config);
        } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Invalid connection.'); }
    };
    return <section className="space-y-3 rounded-card border border-slate-200 bg-white p-4" aria-label="HTTP MCP connections">
        <h3 className="text-sm font-semibold text-slate-950">HTTP MCP connections</h3>
        <p className="text-xs text-slate-600">Connect a server, then review each tool and grant diagnostic or read-only access. Tool arguments are sent to this server. Remote hints do not grant access. New tasks pin the reviewed tools; changes stop their old pins. Credentials stay in memory and expire on reload.</p>
        <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">Connection ID<input aria-label="MCP connection ID" value={id} onChange={e => setId(e.target.value)} className="mt-1 w-full rounded border p-2" placeholder="data-service" /></label>
            <label className="text-xs">Server URL<input aria-label="MCP server URL" value={endpoint} onChange={e => setEndpoint(e.target.value)} className="mt-1 w-full rounded border p-2" placeholder="https://server.example/mcp" /></label>
            <label className="text-xs">Protocol<select aria-label="MCP protocol" value={version} onChange={e => setVersion(e.target.value as HttpMcpConfig['version'])} className="mt-1 w-full rounded border p-2"><option value="auto">Auto (tested versions only)</option><option>2026-07-28</option><option>2025-11-25</option></select></label>
            <label className="text-xs">Authentication<select aria-label="MCP authentication" value={auth} onChange={e => setAuth(e.target.value)} className="mt-1 w-full rounded border p-2"><option value="none">None</option><option value="bearer">Bearer token for this server</option><option value="oauth">OAuth with PKCE</option></select></label>
        </div>
        {auth === 'bearer' && <label className="block text-xs">Session token<input type="password" autoComplete="off" aria-label="MCP session token" value={token} onChange={e => setToken(e.target.value)} className="mt-1 w-full rounded border p-2" /></label>}
        {auth === 'oauth' && <div className="grid gap-2 sm:grid-cols-2"><label className="text-xs">Authorization issuer<input aria-label="MCP OAuth issuer" value={issuer} onChange={e => setIssuer(e.target.value)} className="mt-1 w-full rounded border p-2" /></label><label className="text-xs">Public client ID<input aria-label="MCP OAuth client ID" value={clientId} onChange={e => setClientId(e.target.value)} className="mt-1 w-full rounded border p-2" /></label></div>}
        <button type="button" disabled={busy || !id || !endpoint} onClick={() => void add()} className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Connecting…' : auth === 'oauth' ? 'Sign in and connect MCP' : 'Connect MCP'}</button>
        {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        {configs.map(config => {
            const connection = connections.find(c => c.config.id === config.id);
            return <div key={config.id} className="space-y-2 rounded border p-3"><p className="text-sm font-medium">{config.id} — {connection?.status ?? 'disconnected'}</p><p className="break-all text-xs text-slate-500">{config.endpoint}</p>
                {connection?.pin && <p className="text-xs">{connection.pin.server.name} / {connection.pin.protocol}</p>}
                <div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void connect(config)} className="rounded border px-2 py-1 text-xs">Reconnect {config.id}</button><button type="button" onClick={() => { disconnectMcp(store, config.id); forgetMcpCredential(config.endpoint); }} className="rounded border px-2 py-1 text-xs">Disconnect {config.id}</button><button type="button" onClick={() => { removeMcp(store, config.id); forgetMcpCredential(config.endpoint); setConfigs(current => current.filter(c => c.id !== config.id)); }} className="rounded border px-2 py-1 text-xs">Remove {config.id}</button></div>
                {connection?.pin?.tools.map(tool => <div key={tool.name} className="space-y-1 border-t pt-2"><p className="text-xs font-medium">{tool.name}</p><p className="break-words text-xs text-slate-500">Remote description: {tool.description}</p><details><summary className="text-xs">Review schema</summary><pre className="max-h-40 overflow-auto text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details><label className="text-xs">Host grant<select aria-label={`Grant ${tool.name}`} value={connection.grants[tool.remoteName] ?? ''} onChange={e => setMcpToolGrant(store, config.id, tool.remoteName, (e.target.value || undefined) as McpEffect | undefined)} className="ml-2 rounded border p-1"><option value="">Unavailable</option><option value="diagnostic">Diagnostic</option><option value="read_only">Read-only</option></select></label></div>)}
            </div>;
        })}
        <p className="text-xs text-slate-500">HTTPS and server CORS are required outside loopback. HTTP+SSE endpoints, stdio, external writes, remote images/resources and uncertain retries are unavailable. Upstream completeness and snapshot remain unknown.</p>
    </section>;
};
