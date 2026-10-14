import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { sha256Bytes } from '../../data/sourceDigest';
import { freezeMcp, HTTP_MCP_VERSIONS, normalizeHttpMcpConfig, type HttpMcpConfig, type McpConnectionPin, type McpToolPin } from './httpMcpContract';
import { mcpSchemaValidator, validateMcpArguments, validateMcpSchema } from './mcpSchema';

const MAX_BODY = 262_144;
const MAX_PAGES = 8;
const MAX_TOOLS = 64;
export const mcpDigest = (value: unknown): Promise<string> => sha256Bytes(new TextEncoder().encode(JSON.stringify(value)));
export interface HttpMcpAdapter {
    readonly pin: Readonly<McpConnectionPin>;
    call(tool: McpToolPin, args: unknown, signal?: AbortSignal): Promise<unknown>;
    assertCurrent(signal?: AbortSignal): Promise<void>;
    close(): void;
}

/** Credentials and fetch remain host-owned closures, never tool arguments or persisted metadata. */
export const connectHttpMcp = async (configuration: HttpMcpConfig, options: {
    signal?: AbortSignal; timeoutMs?: number; token?: () => string | undefined;
    fetch?: typeof fetch; onInvalidated?: () => void;
} = {}): Promise<HttpMcpAdapter> => {
    const config = normalizeHttpMcpConfig(configuration);
    const timeoutMs = Math.min(30_000, Math.max(50, options.timeoutMs ?? 10_000));
    const lifetime = new AbortController();
    let client: Client, active = true, legacySession: string | undefined;
    const retire = () => { if (!active) return; active = false; options.signal?.removeEventListener('abort', retire); lifetime.abort(); void client?.close().catch(() => undefined); options.onInvalidated?.(); };
    options.signal?.addEventListener('abort', retire, { once: true });
    const assertActive = () => { if (!active || options.signal?.aborted) throw new Error('mcp_generation_revoked'); };
    const redactCredential = <T>(value: T): T => {
        const token = options.token?.(); if (!token) return value;
        const scrub = (item: unknown, depth: number): unknown => {
            if (depth > 32) throw new Error('mcp_result_nesting_exceeded');
            if (typeof item === 'string') return item.split(token).join('[redacted]').split(encodeURIComponent(token)).join('[redacted]');
            if (Array.isArray(item)) return item.map(child => scrub(child, depth + 1));
            if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child, depth + 1)]));
            return item;
        };
        return scrub(value, 0) as T;
    };
    const boundedFetch: typeof fetch = async (input, init) => {
        assertActive();
        if (new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).href !== config.endpoint) throw new Error('mcp_unapproved_destination');
        const headers = new Headers(init?.headers);
        let request: { method?: string; params?: { name?: string; _meta?: Record<string, unknown> } } | undefined;
        if (init?.body && typeof init.body === 'string') {
            request = JSON.parse(init.body);
            const metaVersion = request?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
            if (metaVersion && (metaVersion !== headers.get('MCP-Protocol-Version') || !HTTP_MCP_VERSIONS.some(version => version === metaVersion))) throw new Error('mcp_body_header_version_mismatch');
            if (metaVersion === '2026-07-28' && (headers.get('Mcp-Method') !== request?.method
                || (request?.method === 'tools/call' && headers.get('Mcp-Name') !== request.params?.name))) throw new Error('mcp_body_header_method_or_name_mismatch');
        }
        const token = options.token?.();
        if (token) headers.set('Authorization', `Bearer ${token}`);
        // Opaque CORS failures are not protocol-era evidence; the SDK must not silently downgrade them.
        let response: Response;
        try {
            response = await (options.fetch ?? fetch)(input, { ...init, headers, credentials: 'omit', redirect: 'error',
                signal: AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]) });
        } catch { throw new Error('mcp_transport_cancelled_timeout_cors_or_network'); }
        if (response.redirected || (response.url && response.url !== config.endpoint)) throw new Error('mcp_response_identity_changed');
        if (response.status === 401 || response.status === 403) throw new Error(`mcp_authentication_required:${response.status}`);
        if (response.status >= 500 || response.status === 404) throw new Error(`mcp_server_unavailable:${response.status}`);
        const responseVersion = response.headers.get('MCP-Protocol-Version');
        if (responseVersion && responseVersion !== headers.get('MCP-Protocol-Version')) throw new Error('mcp_response_version_mismatch');
        const session = response.headers.get('MCP-Session-Id');
        if (session) {
            if (request?.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'
                || session.length > 128 || !/^[\x20-\x7e]+$/.test(session)
                || (request?.method !== 'initialize' && session !== legacySession)) throw new Error('mcp_unexpected_session_binding');
            if (request?.method === 'initialize') legacySession = session;
        }
        if (Number(response.headers.get('content-length')) > MAX_BODY) throw new Error('mcp_response_too_large');
        if (!response.body) return response;
        const reader = response.body.getReader(); let bytes = 0;
        if (response.headers.get('content-type')?.split(';')[0].trim() === 'application/json') {
            const chunks: Uint8Array[] = [];
            while (true) {
                const next = await reader.read(); if (next.done) break; bytes += next.value.length;
                if (bytes > MAX_BODY) { await reader.cancel(); throw new Error('mcp_response_too_large'); }
                chunks.push(next.value);
            }
            const combined = new Uint8Array(bytes); let offset = 0;
            chunks.forEach(chunk => { combined.set(chunk, offset); offset += chunk.length; });
            let parsed: {error?:{code?:number;data?:{supported?:unknown}};result?:{supportedVersions?:unknown}};
            try { parsed = JSON.parse(new TextDecoder().decode(combined)); } catch { throw new Error('mcp_invalid_json'); }
            // The SDK's auto mode otherwise treats arbitrary protocol errors as legacy signals.
            if (request?.method === 'server/discover' && parsed.error && parsed.error.code !== -32601
                && !(parsed.error.code === -32022 && Array.isArray(parsed.error.data?.supported)
                    && parsed.error.data.supported.some(version => HTTP_MCP_VERSIONS.includes(version)))) throw new Error('mcp_discovery_rejected');
            if (request?.method === 'server/discover' && parsed.result
                && (!Array.isArray(parsed.result.supportedVersions) || !parsed.result.supportedVersions.includes('2026-07-28'))) throw new Error('mcp_unsupported_discovery_versions');
            return new Response(combined, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const next = await reader.read();
                    if (next.done) { controller.close(); return; }
                    bytes += next.value.byteLength;
                    if (bytes > MAX_BODY) { await reader.cancel(); throw new Error('mcp_response_too_large'); }
                    controller.enqueue(next.value);
                } catch (error) { controller.error(error); }
            },
            cancel: reason => reader.cancel(reason),
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    client = new Client({ name: 'csv-data-analysis-agent', version: '1.0.0' }, {
        supportedProtocolVersions: [...HTTP_MCP_VERSIONS], capabilities: {},
        inputRequired: { autoFulfill: false }, listMaxPages: MAX_PAGES,
        versionNegotiation: { mode: config.version === 'auto' ? 'auto' : config.version === '2026-07-28' ? { pin: config.version } : 'legacy', probe: { timeoutMs, maxRetries: 0 } },
        jsonSchemaValidator: mcpSchemaValidator,
    });
    const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), { fetch: boundedFetch,
        redirectPolicy: 'same-origin', reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } });
    const requestOptions = (signal?: AbortSignal) => ({ signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]), timeout: timeoutMs, maxTotalTimeout: timeoutMs });
    const readTools = async (signal?: AbortSignal): Promise<McpToolPin[]> => {
        const tools: McpToolPin[] = [], cursors = new Set<string>(); let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            // Public typed request validates the wire page without the SDK's auto-aggregation/loop shortcut.
            const result = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, requestOptions(signal));
            assertActive();
            for (const tool of result.tools as Tool[]) {
                if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name) || tools.some(t => t.remoteName === tool.name) || tools.length >= MAX_TOOLS) throw new Error('mcp_invalid_or_duplicate_tool_name');
                if (options.token?.() && JSON.stringify(tool).includes(options.token!()!)) throw new Error('mcp_credential_in_tool_definition');
                const inputSchema = validateMcpSchema(tool.inputSchema);
                const outputSchema = tool.outputSchema ? validateMcpSchema(tool.outputSchema) : undefined;
                const description = typeof tool.description === 'string' ? tool.description.slice(0, 1000) : '';
                const schemaDigest = await mcpDigest({ name: tool.name, inputSchema, outputSchema, description });
                tools.push({ remoteName: tool.name, name: `mcp.${config.id}.${tool.name}`, description, inputSchema, outputSchema, schemaDigest });
            }
            cursor = result.nextCursor;
            if (!cursor) return tools;
            if (cursor.length > 512 || cursors.has(cursor)) throw new Error('mcp_invalid_pagination');
            cursors.add(cursor);
        }
        throw new Error('mcp_discovery_incomplete');
    };
    try {
        const connectSignal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeoutMs)]);
        await client.connect(transport, requestOptions(connectSignal)); assertActive();
        const protocol = client.getNegotiatedProtocolVersion();
        if (!HTTP_MCP_VERSIONS.some(version => version === protocol) || (config.version !== 'auto' && protocol !== config.version)) throw new Error('mcp_unsupported_protocol_version');
        const server = client.getServerVersion();
        if (!server || !server.name || !server.version || server.name.length > 100 || server.version.length > 100 || !client.getServerCapabilities()?.tools) throw new Error('mcp_missing_server_identity_or_tools');
        const tools = await readTools(connectSignal);
        const identity = { connectorId: config.id, generation: crypto.randomUUID(), endpoint: config.endpoint,
            protocol: protocol as McpConnectionPin['protocol'], server: { name: server.name, version: server.version }, tools };
        const pin = freezeMcp({ ...identity, digest: await mcpDigest(identity) }); assertActive();
        client.onclose = retire;
        const assertCurrent = async (signal?: AbortSignal) => {
            assertActive();
            try {
                if (protocol === '2026-07-28') {
                    await client.discover(requestOptions(signal));
                    const currentServer = client.getDiscoverResult()?._meta?.['io.modelcontextprotocol/serverInfo'];
                    if ((!currentServer || typeof currentServer !== 'object' || (currentServer as {name?:unknown}).name !== pin.server.name || (currentServer as {version?:unknown}).version !== pin.server.version)) throw new Error('mcp_server_identity_changed');
                }
                const current = await readTools(signal);
                if (await mcpDigest(current) !== await mcpDigest(pin.tools)) throw new Error('mcp_schema_changed');
                assertActive();
            } catch (error) { retire(); throw error; }
        };
        return { pin, assertCurrent, close: retire, async call(tool, args, signal) {
            if (!pin.tools.includes(tool)) throw new Error('mcp_tool_pin_not_owned');
            const errors = validateMcpArguments(tool.inputSchema, args); if (errors.length) throw new Error(errors.join(','));
            signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
            await assertCurrent(signal);
            try {
                const result = await client.callTool({ name: tool.remoteName, arguments: args as Record<string, unknown> }, {
                    ...requestOptions(signal), toolDefinition: { name: tool.remoteName, inputSchema: tool.inputSchema as Tool['inputSchema'],
                        ...(tool.outputSchema ? {outputSchema:tool.outputSchema} : {}) },
                });
                assertActive();
                if (result.isError || !Array.isArray(result.content) || result.content.some(block => block.type !== 'text')
                    || result.inputRequests || JSON.stringify(result).length > 65_536) throw new Error('mcp_unusable_or_oversized_result');
                if (tool.outputSchema && !mcpSchemaValidator.getValidator(tool.outputSchema)(result.structuredContent).valid) throw new Error('mcp_output_schema_mismatch');
                // Recheck drift after execution, including a server that changes its schema while a call is in flight.
                await assertCurrent(signal); return freezeMcp(structuredClone(redactCredential(result)));
            } catch (error) { retire(); throw error; }
        } };
    } catch (error) { retire(); throw error; }
};
