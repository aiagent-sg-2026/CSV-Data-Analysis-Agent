// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnProfile, CsvRow } from '../types';

vi.mock('../services/privacy/cloudAiConsent', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    ensureCloudAiConsent: vi.fn(async () => undefined),
}));
vi.mock('../services/pwa/networkAvailability', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    waitForCloudAiConnectivity: vi.fn(async () => undefined),
}));

const { createSqlEvidenceQueryPlanOutputSchema, createSqlEvidenceQueryPlanSchema } = await import('../services/ai/schemas/analysisSchemas');
const { prepareSchemaForProvider } = await import('../services/ai/googleSchemaAdapter');
const { normalizeAndValidateSqlEvidenceQueryPlan } = await import('../services/agent/planning/sqlPlanValidator');
const { generateEvidenceQueryPlanWithRetry } = await import('../services/agent/planning/planGenerator');
const { profileData } = await import('../services/data/dataProfiler');
const { resetDemoGatewaySessionForTests } = await import('../services/ai/demoGatewaySession');
const { resetDemoGatewayRequestLimiterForTests } = await import('../services/ai/browserProviderFetch');
const { createTestSettings } = await import('./testSettings');

type SchemaNode = Record<string, unknown>;

// Columns of the melted transport demo table.
const COLUMNS = ['DataSeries', 'ParentSeries', 'HierarchyDepth', 'RowClass', 'SourceColumnName', 'Value', 'Period', 'SourceRowIndex', 'RowRole', 'ResolvedRowRole', 'HeaderPath', 'CarryForwardAppliedColumns'];

const rows: CsvRow[] = ['Average Daily Ridership - MRT', 'Average Daily Ridership - LRT'].flatMap((series, seriesIndex) =>
    ['2021', '2022', '2023'].map((period, periodIndex) => ({
        DataSeries: series,
        ParentSeries: null,
        HierarchyDepth: 0,
        RowClass: 'fact',
        SourceColumnName: Number(period),
        Value: 1000 * (seriesIndex + 1) + periodIndex,
        Period: period,
        SourceRowIndex: seriesIndex,
        RowRole: 'fact',
        ResolvedRowRole: 'fact',
        HeaderPath: Number(period),
        CarryForwardAppliedColumns: null,
    })));
const profiles: ColumnProfile[] = profileData(rows).profiles;

/** Object nesting depth: the gateway rejected 5 levels and accepted 4 (2026-10-23 probes). */
const objectDepth = (node: SchemaNode | undefined): number => {
    if (!node || typeof node !== 'object') return 0;
    if (node.type === 'object' || node.properties) {
        return 1 + Math.max(0, ...Object.values((node.properties ?? {}) as Record<string, SchemaNode>).map(objectDepth));
    }
    return node.items ? objectDepth(node.items as SchemaNode) : 0;
};

/** Schema-node depth; 7 is the deepest a gateway-accepted evidence schema reached. */
const nodeDepth = (node: SchemaNode | undefined): number => {
    if (!node || typeof node !== 'object') return 0;
    const children = [
        ...Object.values((node.properties ?? {}) as Record<string, SchemaNode>),
        ...(node.items ? [node.items as SchemaNode] : []),
    ];
    return 1 + Math.max(0, ...children.map(nodeDepth));
};

const collectNodes = (node: unknown, out: SchemaNode[] = []): SchemaNode[] => {
    if (!node || typeof node !== 'object') return out;
    if (!Array.isArray(node)) out.push(node as SchemaNode);
    Object.values(node).forEach(child => collectNodes(child, out));
    return out;
};

/** Constraints the Default gateway enforces on `text.format.schema`, plus OpenAI strict mode. */
const expectGatewayCompatible = (schema: SchemaNode) => {
    expect(objectDepth(schema)).toBeLessThanOrEqual(4);
    expect(nodeDepth(schema)).toBeLessThanOrEqual(7);
    const nodes = collectNodes(schema);
    // The gateway answers "JSON Schema field 'anyOf' is not supported".
    expect(nodes.filter(node => 'anyOf' in node || 'oneOf' in node || 'allOf' in node)).toEqual([]);
    for (const node of nodes.filter(entry => entry.type === 'object')) {
        expect(node.additionalProperties).toBe(false);
        expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as SchemaNode).sort());
    }
};

const sse = (text: string) => {
    const events = [
        { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'demo-auto', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text, logprobs: [] },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] } },
        { type: 'response.completed', response: { id: 'resp_1', created_at: 1, model: 'demo-auto', status: 'completed', incomplete_details: null, usage: { input_tokens: 10, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
    return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
};

// Structured output returned by the Default gateway for the transport topic
// "Average Daily Ridership - MRT by Period" with the fixed schema (2026-10-23).
const GATEWAY_PLAN_OUTPUT = {
    title: 'Average Daily Ridership - MRT by Period',
    queryMode: 'aggregate',
    intentSummary: 'Show the MRT average daily ridership series across periods.',
    preferredResultShape: 'time_series',
    preFilter: [],
    query: {
        select: ['Period', 'avg_daily_ridership_mrt'],
        groupBy: ['Period'],
        aggregates: [{ function: 'avg', column: 'Value', as: 'avg_daily_ridership_mrt', percentile: 0 }],
        where: { predicates: [{ column: 'DataSeries', operator: 'eq', value: 'Average Daily Ridership - MRT' }] },
        orderBy: [{ column: 'Period', direction: 'asc' }],
        limit: 31,
        aggregateFilters: [],
    },
};

describe('evidence plan structured output on the Default demo gateway', () => {
    beforeEach(() => {
        vi.stubEnv('VITE_DEFAULT_GATEWAY_PROJECT_ID', 'test-project');
        resetDemoGatewaySessionForTests();
        resetDemoGatewayRequestLimiterForTests();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('serializes a schema the gateway accepts and parses its plan', async () => {
        const bodies: Array<Record<string, unknown>> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            if (request.url.endsWith('/demo/session')) {
                return new Response(JSON.stringify({ token: 'dmo_test', model: 'demo-auto', expires_in: 900 }), { status: 201 });
            }
            const body = await request.json() as Record<string, unknown>;
            bodies.push(body);
            const schema = (body.text as { format: { schema: SchemaNode } }).format.schema;
            // Mirrors the gateway's rejection observed on 2026-10-23.
            if (objectDepth(schema) > 4) {
                return new Response(JSON.stringify({ error: { message: 'JSON Schema is too deep or complex', code: 'DEMO_SCHEMA_UNSUPPORTED', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
            }
            return new Response(sse(JSON.stringify(GATEWAY_PLAN_OUTPUT)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }));

        const plan = await generateEvidenceQueryPlanWithRetry(
            'Average Daily Ridership - MRT by Period',
            profiles,
            createTestSettings({ provider: 'default' }),
            undefined, undefined, undefined, undefined, rows,
        );

        expect(bodies).toHaveLength(1);
        const [body] = bodies;
        expect(body).not.toHaveProperty('max_output_tokens');
        expect(body.model).toBe('demo-auto');
        const format = (body.text as { format: { type: string; strict: boolean; schema: SchemaNode } }).format;
        expect(format).toMatchObject({ type: 'json_schema', strict: true });
        expectGatewayCompatible(format.schema);
        expect(plan.query).toMatchObject({
            groupBy: ['Period'],
            aggregates: [expect.objectContaining({ function: 'avg', column: 'Value' })],
            where: { predicates: [{ column: 'DataSeries', operator: 'eq', value: 'Average Daily Ridership - MRT' }] },
        });
        expect(plan.query).not.toHaveProperty('aggregateFilters');
    });

    it('keeps the canonical nested schema for the Pi tool and the flat one for structured output', () => {
        // The canonical schema nests aggregates[].where.predicates[] five objects deep, which the gateway rejects.
        expect(objectDepth(prepareSchemaForProvider(createSqlEvidenceQueryPlanSchema(COLUMNS), 'default'))).toBe(5);
        for (const provider of ['default', 'openai'] as const) {
            expectGatewayCompatible(prepareSchemaForProvider(createSqlEvidenceQueryPlanOutputSchema(COLUMNS), provider));
        }
        const google = prepareSchemaForProvider(createSqlEvidenceQueryPlanOutputSchema(COLUMNS), 'google') as {
            properties: { query: { properties: Record<string, SchemaNode> } };
        };
        expect(objectDepth(google)).toBeLessThanOrEqual(4);
        expect(google.properties.query.properties.aggregateFilters).toMatchObject({
            type: 'array',
            items: { type: 'object', required: ['aggregate', 'column', 'operator'] },
        });
        expect(google.properties.query.properties.aggregates).not.toHaveProperty('items.properties.where');
    });

    it('folds aggregate filters back into each aggregate by alias', () => {
        const { validPlan, errors } = normalizeAndValidateSqlEvidenceQueryPlan({
            title: 'MRT vs LRT ridership by Period',
            queryMode: 'aggregate',
            intentSummary: 'Compare two series per period.',
            query: {
                select: ['Period', 'mrt', 'lrt'],
                groupBy: ['Period'],
                aggregates: [
                    { function: 'avg', column: 'Value', as: 'mrt', percentile: 0 },
                    { function: 'avg', column: 'Value', as: 'lrt', percentile: 0 },
                ],
                where: { predicates: [{ column: 'RowClass', operator: 'eq', value: 'fact' }] },
                orderBy: [{ column: 'Period', direction: 'asc' }],
                limit: 50,
                aggregateFilters: [
                    { aggregate: 'mrt', column: 'DataSeries', operator: 'eq', value: 'Average Daily Ridership - MRT' },
                    { aggregate: 'LRT', column: 'DataSeries', operator: 'eq', value: 'Average Daily Ridership - LRT' },
                ],
            },
        }, profiles, { lenient: true });

        expect(errors).toEqual([]);
        expect(validPlan?.query).not.toHaveProperty('aggregateFilters');
        expect(validPlan?.query.aggregates?.map(aggregate => aggregate.where)).toEqual([
            { predicates: [{ column: 'DataSeries', operator: 'eq', value: 'Average Daily Ridership - MRT' }] },
            { predicates: [{ column: 'DataSeries', operator: 'eq', value: 'Average Daily Ridership - LRT' }] },
        ]);
    });

    it('rejects an aggregate filter whose alias matches no aggregate instead of dropping it', () => {
        const { validPlan, errors } = normalizeAndValidateSqlEvidenceQueryPlan({
            ...GATEWAY_PLAN_OUTPUT,
            query: {
                ...GATEWAY_PLAN_OUTPUT.query,
                aggregateFilters: [{ aggregate: 'total_bus', column: 'DataSeries', operator: 'eq', value: 'Average Daily Ridership - Public Bus' }],
            },
        }, profiles, { lenient: true });

        expect(validPlan).toBeNull();
        expect(errors.join(' ')).toContain('"total_bus"');
    });
});
