import type { ToolManifest } from '../../../types';
import type { ExecutionContext, SessionScope } from '../../session/sessionOwnership';

export const HTTP_MCP_ADAPTER_VERSION = 'http-mcp/1;client/2.3.1';
export const HTTP_MCP_VERSIONS = ['2026-07-28', '2025-11-25'] as const;
export type HttpMcpVersion = typeof HTTP_MCP_VERSIONS[number];
export type McpEffect = 'diagnostic' | 'read_only';
export interface HttpMcpConfig { id: string; endpoint: string; version: 'auto' | HttpMcpVersion }
export interface McpToolPin {
    remoteName: string; name: `mcp.${string}.${string}`; description: string;
    inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>;
    schemaDigest: string; effect?: McpEffect;
}
export interface McpConnectionPin {
    connectorId: string; generation: string; endpoint: string; protocol: HttpMcpVersion;
    server: { name: string; version: string }; tools: readonly McpToolPin[]; digest: string;
}
export interface McpObservationReceipt {
    receiptId: string; adapter: typeof HTTP_MCP_ADAPTER_VERSION; scope: SessionScope;
    taskId: string; runId: string; turnId?: string; stepId?: string; toolCallId: string;
    connectorId: string; generation: string; connectionDigest: string; schemaDigest: string;
    protocol: HttpMcpVersion; effect: McpEffect; remoteTool: string; argumentsDigest: string; resultDigest: string;
    provenance: { endpoint: string; server: McpConnectionPin['server'];
        selection: 'server_reported_unverified'; completeness: 'unknown'; snapshot: 'unknown';
        admission: 'observation_only'; truncated: boolean };
    result: unknown;
}
export interface McpTaskPort {
    readonly manifests: readonly ToolManifest[];
    readonly digest: string;
    execute(name: string, args: unknown, context: ExecutionContext, signal?: AbortSignal): Promise<McpObservationReceipt>;
    owns(receipt: unknown, context: ExecutionContext): boolean;
}

export const normalizeHttpMcpConfig = (config: HttpMcpConfig): HttpMcpConfig => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(config.id) || !['auto', ...HTTP_MCP_VERSIONS].includes(config.version)) throw new Error('mcp_invalid_configuration');
    const url = new URL(config.endpoint);
    const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        || url.username || url.password || url.search || url.hash) throw new Error('mcp_endpoint_requires_https_or_loopback_without_credentials');
    return { id: config.id, endpoint: url.href, version: config.version };
};

export const freezeMcp = <T>(value: T): Readonly<T> => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freezeMcp); Object.freeze(value);
    }
    return value;
};
