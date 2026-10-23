// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/privacy/cloudAiConsent', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    ensureCloudAiConsent: vi.fn(async () => undefined),
}));
vi.mock('../services/pwa/networkAvailability', async importOriginal => ({
    ...(await importOriginal() as Record<string, unknown>),
    waitForCloudAiConnectivity: vi.fn(async () => undefined),
}));

const agentSchemas = await import('../services/ai/schemas/agentSchemas');
const analysisSchemas = await import('../services/ai/schemas/analysisSchemas');
const dataSchemas = await import('../services/ai/schemas/dataSchemas');
const { reportStructureProposalSchema } = await import('../services/ai/schemas/reportStructureProposalSchema');
const { intakeStructureBoundarySchema } = await import('../services/ai/schemas/intakeStructureSchema');
const { sandboxProposalSchema } = await import('../services/ai/sandboxTransformationGenerator');
const { GATEWAY_PROPERTY_ALIASES, prepareGatewayStructuredOutputSchema, prepareSchemaForProvider } = await import('../services/ai/googleSchemaAdapter');
const { liftGatewayDataPreparationOutput } = await import('../services/ai/dataPreparationGatewayOutput');
const { normalizeDataPreparationPlan } = await import('../services/agent/execution/dataOperationRunner');
const { generateDataPreparationPlan } = await import('../services/ai/dataPreparer');
const { resetDemoGatewaySessionForTests } = await import('../services/ai/demoGatewaySession');
const { resetDemoGatewayRequestLimiterForTests } = await import('../services/ai/browserProviderFetch');
const { createTestSettings } = await import('./testSettings');

type SchemaNode = Record<string, unknown>;

const COLUMNS = ['Region', 'Period', 'Value'];

interface StructuredOutputEntry {
    /** Call-site file, relative to frontend/. */
    site: string;
    /** First argument of createStructuredOutput(...) exactly as written at the call site. */
    expression: string;
    /** Schema the call site sends to the Default demo gateway. */
    defaultSchema: () => SchemaNode;
    /** Schemas the call site sends to OpenAI and Google (defaults to defaultSchema). */
    providerSchemas?: () => SchemaNode[];
}

/**
 * Every structured-output call site. The source scan below fails when a
 * createStructuredOutput(...) call is added without an entry here.
 */
const STRUCTURED_OUTPUTS: StructuredOutputEntry[] = [
    { site: 'services/reporting/generateAnalystMemo.ts', expression: 'analystMemoSchema', defaultSchema: () => agentSchemas.analystMemoSchema },
    { site: 'services/reporting/generateForumSummary.ts', expression: 'forumSummarySchema', defaultSchema: () => agentSchemas.forumSummarySchema },
    { site: 'services/ai/insightGenerator.ts', expression: 'proactiveInsightSchema', defaultSchema: () => agentSchemas.proactiveInsightSchema },
    { site: 'services/ai/enhancementGenerator.ts', expression: 'cardEnhancementSuggestionsSchema', defaultSchema: () => agentSchemas.cardEnhancementSuggestionsSchema },
    {
        site: 'services/ai/dataPreparer.ts',
        expression: 'responseSchema',
        defaultSchema: () => dataSchemas.getDataPreparationProviderSchema({ defaultGateway: true }),
        providerSchemas: () => [
            dataSchemas.getDataPreparationProviderSchema(),
            dataSchemas.getDataPreparationProviderSchema({ compactWideTable: true }),
        ],
    },
    { site: 'services/ai/sqlPrecheckEvaluator.ts', expression: 'sqlPrecheckAssessmentSchema', defaultSchema: () => dataSchemas.sqlPrecheckAssessmentSchema },
    { site: 'services/ai/reportStructureProposal.ts', expression: 'reportStructureProposalSchema', defaultSchema: () => reportStructureProposalSchema },
    { site: 'services/ai/goalGenerator.ts', expression: 'analysisGoalCandidateSchema', defaultSchema: () => agentSchemas.analysisGoalCandidateSchema },
    { site: 'services/ai/datasetSemanticAnnotator.ts', expression: 'datasetSemanticAnnotationSchema', defaultSchema: () => dataSchemas.datasetSemanticAnnotationSchema },
    { site: 'services/ai/reportContextExtractor.ts', expression: 'reportContextExtractionSchema', defaultSchema: () => dataSchemas.reportContextExtractionSchema },
    { site: 'services/ai/filterGenerator.ts', expression: 'filterFunctionSchema', defaultSchema: () => dataSchemas.filterFunctionSchema },
    { site: 'services/ai/sandboxTransformationGenerator.ts', expression: 'sandboxProposalSchema', defaultSchema: () => sandboxProposalSchema },
    { site: 'services/ai/stepGenerator.ts', expression: 'nextStepSchema', defaultSchema: () => agentSchemas.nextStepSchema },
    { site: 'services/ai/intakeStructureDetector.ts', expression: 'intakeStructureBoundarySchema', defaultSchema: () => intakeStructureBoundarySchema },
    { site: 'services/agent/planning/sqlPresentationPlanner.ts', expression: 'createSqlPresentationPlanSchema(evidenceColumnNames)', defaultSchema: () => analysisSchemas.createSqlPresentationPlanSchema(COLUMNS) },
    { site: 'services/agent/planning/planGenerator.ts', expression: 'createAnalysisTopicsSchema(minTopics, maxTopics)', defaultSchema: () => analysisSchemas.createAnalysisTopicsSchema(4, 8) },
    { site: 'services/agent/planning/planGenerator.ts', expression: 'createSqlEvidenceQueryPlanOutputSchema(allColumnNames)', defaultSchema: () => analysisSchemas.createSqlEvidenceQueryPlanOutputSchema(COLUMNS) },
    { site: 'services/agent/evidenceValueGate.ts', expression: 'createEvidenceEvaluationSchema()', defaultSchema: () => analysisSchemas.createEvidenceEvaluationSchema() },
];

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRECTORIES = ['services', 'components', 'store', 'hooks', 'utils', 'config'];

const listSourceFiles = (directory: string): string[] =>
    readdirSync(directory).flatMap(entry => {
        const fullPath = path.join(directory, entry);
        if (statSync(fullPath).isDirectory()) return listSourceFiles(fullPath);
        return /\.(ts|tsx)$/.test(entry) ? [fullPath] : [];
    });

/** Returns the first argument of every `createStructuredOutput(` call in the source text. */
const extractFirstArguments = (source: string): string[] => {
    const results: string[] = [];
    const marker = 'createStructuredOutput(';
    let index = source.indexOf(marker);
    while (index !== -1) {
        let depth = 0;
        let cursor = index + marker.length;
        const start = cursor;
        for (; cursor < source.length; cursor += 1) {
            const char = source[cursor];
            if (char === '(' || char === '[' || char === '{') depth += 1;
            else if (char === ')' || char === ']' || char === '}') {
                if (depth === 0) break;
                depth -= 1;
            } else if (char === ',' && depth === 0) break;
        }
        results.push(source.slice(start, cursor).replace(/\s+/g, ' ').trim());
        index = source.indexOf(marker, cursor);
    }
    return results;
};

/** Object nesting depth: the gateway rejected 5 levels and accepted 4 (2026-10-23 probes). */
const objectDepth = (node: SchemaNode | undefined): number => {
    if (!node || typeof node !== 'object') return 0;
    if (node.type === 'object' || node.properties) {
        return 1 + Math.max(0, ...Object.values((node.properties ?? {}) as Record<string, SchemaNode>).map(objectDepth));
    }
    return node.items ? objectDepth(node.items as SchemaNode) : 0;
};

/** Schema-node depth; 7 is the deepest schema the gateway accepted (filter and next-step, 2026-10-23). */
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

/**
 * The gateway refused objects with 25 and 33 properties ("JSON Schema property
 * names are invalid") and accepted one with 14 (next-step plan), 2026-10-23.
 */
const MAX_GATEWAY_PROPERTIES_PER_OBJECT = 14;

const expectGatewayCompatible = (schema: SchemaNode, label: string) => {
    expect(objectDepth(schema), label).toBeLessThanOrEqual(4);
    expect(nodeDepth(schema), label).toBeLessThanOrEqual(7);
    const nodes = collectNodes(schema);
    // The gateway answers "JSON Schema field 'anyOf' is not supported".
    expect(nodes.filter(node => 'anyOf' in node || 'oneOf' in node || 'allOf' in node), label).toEqual([]);
    for (const node of nodes.filter(entry => entry.type === 'object')) {
        const keys = Object.keys(node.properties as SchemaNode);
        expect(node.additionalProperties, label).toBe(false);
        expect([...(node.required as string[])].sort(), label).toEqual([...keys].sort());
        expect(keys.length, `${label}: ${keys.join(', ')}`).toBeLessThanOrEqual(MAX_GATEWAY_PROPERTIES_PER_OBJECT);
        expect(keys.filter(key => key in GATEWAY_PROPERTY_ALIASES), label).toEqual([]);
    }
};

// Structured output the Default gateway returned for the gateway data-preparation
// schema (2026-10-23), for a small sales table with a padded region, an N/A
// marker, a blank row and a Total row.
const GATEWAY_DATA_PREPARATION_OUTPUT = {
    explanation: 'Trim the visible stray space in Region, remove the clearly non-data blank and Total summary rows, normalize the N/A sales marker to empty, and cast Sales to numeric.',
    operations: [
        { id: 'op1', kind: 'trim_whitespace', reason: 'Remove stray leading/trailing spaces from Region values.', indices: [], predicates: [], mappings: [], columns: ['Region'], emptyMarkers: [], column: '', targetType: 'string', keyColumn: '', valueColumn: '', keepColumns: [] },
        { id: 'op2', kind: 'drop_blank_rows', reason: 'Remove the fully empty row.', indices: [], predicates: [], mappings: [], columns: [], emptyMarkers: [], column: '', targetType: 'string', keyColumn: '', valueColumn: '', keepColumns: [] },
        { id: 'op3', kind: 'drop_rows_by_condition', reason: 'Remove the Total summary row, which is not a business detail record.', indices: [], predicates: [{ column: 'Region', operator: 'eq', value: 'Total' }], mappings: [], columns: [], emptyMarkers: [], column: '', targetType: 'string', keyColumn: '', valueColumn: '', keepColumns: [] },
        { id: 'op4', kind: 'normalize_empty_values', reason: 'Convert the non-data sales marker to a true missing value before casting.', indices: [], predicates: [], mappings: [], columns: ['Sales'], emptyMarkers: ['N/A'], column: '', targetType: 'string', keyColumn: '', valueColumn: '', keepColumns: [] },
        { id: 'op5', kind: 'cast_column', reason: 'Store Sales as a numeric field for analysis.', indices: [], predicates: [], mappings: [], columns: [], emptyMarkers: [], column: 'Sales', targetType: 'number', keyColumn: '', valueColumn: '', keepColumns: [] },
    ],
    outputColumns: [
        { name: 'Region', kind: 'categorical' },
        { name: 'Month', kind: 'categorical' },
        { name: 'Sales', kind: 'numerical' },
    ],
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

describe('structured-output schemas on the Default demo gateway', () => {
    beforeEach(() => {
        vi.stubEnv('VITE_DEFAULT_GATEWAY_PROJECT_ID', 'test-project');
        resetDemoGatewaySessionForTests();
        resetDemoGatewayRequestLimiterForTests();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('registers every structured-output call site', () => {
        const found: string[] = [];
        const rawOutputCalls: string[] = [];
        for (const directory of SOURCE_DIRECTORIES) {
            for (const file of listSourceFiles(path.join(FRONTEND_ROOT, directory))) {
                const relative = path.relative(FRONTEND_ROOT, file).split(path.sep).join('/');
                // Comments may mention Output.object(); only code counts.
                const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
                if (relative !== 'services/ai/structuredOutput.ts' && /\bOutput\.(object|array|choice|json)\(/.test(source)) {
                    rawOutputCalls.push(relative);
                }
                extractFirstArguments(source).forEach(expression => found.push(`${relative} :: ${expression}`));
            }
        }
        // New structured-output calls must go through createStructuredOutput.
        expect(rawOutputCalls).toEqual([]);
        expect(found.sort()).toEqual(STRUCTURED_OUTPUTS.map(entry => `${entry.site} :: ${entry.expression}`).sort());
    });

    it.each(STRUCTURED_OUTPUTS.map(entry => [`${entry.site} :: ${entry.expression}`, entry] as const))(
        '%s sends a gateway-compatible schema and still builds for OpenAI and Google',
        (label, entry) => {
            expectGatewayCompatible(prepareGatewayStructuredOutputSchema(entry.defaultSchema()).schema, label);
            for (const schema of entry.providerSchemas?.() ?? [entry.defaultSchema()]) {
                const openai = prepareSchemaForProvider(schema, 'openai');
                expect(openai.type).toBe('object');
                expect(collectNodes(openai).filter(node => 'oneOf' in node || 'allOf' in node)).toEqual([]);
                expect(prepareSchemaForProvider(schema, 'google').type).toBe('object');
            }
        },
    );

    it('restores the canonical property names on the parsed output', () => {
        const { schema, restore } = prepareGatewayStructuredOutputSchema(dataSchemas.filterFunctionSchema);
        expect(schema).toMatchObject({ properties: { operation: { properties: { kind: { enum: ['filter_rows'] } } } } });
        // Structured output returned by the Default gateway for this schema (2026-10-23).
        expect(restore({
            explanation: 'Filtering for rows where Region is North and Sales is greater than 1000.',
            operation: { id: 'filter_north', kind: 'filter_rows', reason: 'Keep North rows above 1000.', predicates: [{ column: 'Region', operator: 'eq', value: 'North' }, { column: 'Sales', operator: 'gt', value: '1000' }], groups: [] },
        })).toEqual({
            explanation: 'Filtering for rows where Region is North and Sales is greater than 1000.',
            operation: { id: 'filter_north', type: 'filter_rows', reason: 'Keep North rows above 1000.', predicates: [{ column: 'Region', operator: 'eq', value: 'North' }, { column: 'Sales', operator: 'gt', value: '1000' }], groups: [] },
        });
    });

    it('maps the gateway data-preparation output back to canonical operations', () => {
        const { restore } = prepareGatewayStructuredOutputSchema(dataSchemas.getDataPreparationProviderSchema({ defaultGateway: true }));
        const plan = normalizeDataPreparationPlan(liftGatewayDataPreparationOutput(restore(GATEWAY_DATA_PREPARATION_OUTPUT)));
        expect(plan?.operations).toEqual([
            expect.objectContaining({ id: 'op1', type: 'trim_whitespace', columns: ['Region'] }),
            { id: 'op2', type: 'drop_blank_rows', reason: 'Remove the fully empty row.' },
            expect.objectContaining({ id: 'op3', type: 'drop_rows_by_condition', predicates: [expect.objectContaining({ column: 'Region', operator: 'eq', value: 'Total' })] }),
            expect.objectContaining({ id: 'op4', type: 'normalize_empty_values', columns: ['Sales'], emptyMarkers: ['N/A'] }),
            expect.objectContaining({ id: 'op5', type: 'cast_column', column: 'Sales', targetType: 'number' }),
        ]);
        expect(plan?.operations[0]).not.toHaveProperty('targetType');
        expect(plan?.outputColumns).toEqual([
            { name: 'Region', type: 'categorical' },
            { name: 'Month', type: 'categorical' },
            { name: 'Sales', type: 'numerical' },
        ]);
    });

    it('maps shared gateway fields onto each operation type', () => {
        const base = { reason: 'r', indices: [], predicates: [], mappings: [], columns: [], emptyMarkers: [], column: '', targetType: 'string', keyColumn: '', valueColumn: '', keepColumns: [] };
        const lifted = liftGatewayDataPreparationOutput({
            operations: [
                { ...base, id: 'a', type: 'promote_header_row', indices: [2] },
                { ...base, id: 'b', type: 'trim_whitespace', columns: ['*'] },
                { ...base, id: 'c', type: 'replace_values', column: 'Status', mappings: [{ from: 'Y', to: 'Yes' }] },
                { ...base, id: 'd', type: 'dedupe_rows', columns: ['Invoice'] },
                { ...base, id: 'e', type: 'unpivot_columns', columns: ['2021', '2022'], keyColumn: 'Period', valueColumn: 'Value', keepColumns: ['Series'] },
            ],
        }) as { operations: SchemaNode[] };
        expect(lifted.operations).toEqual([
            { id: 'a', type: 'promote_header_row', reason: 'r', rowIndex: 2 },
            { id: 'b', type: 'trim_whitespace', reason: 'r', columns: '*' },
            { id: 'c', type: 'replace_values', reason: 'r', column: 'Status', replacements: [{ from: 'Y', to: 'Yes' }] },
            { id: 'd', type: 'dedupe_rows', reason: 'r', keyColumns: ['Invoice'], keep: 'first' },
            { id: 'e', type: 'unpivot_columns', reason: 'r', sourceColumns: ['2021', '2022'], keyColumn: 'Period', valueColumn: 'Value', keepColumns: ['Series'] },
        ]);
    });

    it('serializes the gateway data-preparation request and parses the gateway output', async () => {
        const bodies: Array<Record<string, unknown>> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            if (request.url.endsWith('/demo/session')) {
                return new Response(JSON.stringify({ token: 'dmo_test', model: 'demo-auto', expires_in: 900 }), { status: 201 });
            }
            const body = await request.json() as Record<string, unknown>;
            bodies.push(body);
            return new Response(sse(JSON.stringify(GATEWAY_DATA_PREPARATION_OUTPUT)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }));

        const columns = [
            { name: 'Region', type: 'categorical' as const },
            { name: 'Month', type: 'categorical' as const },
            { name: 'Sales', type: 'numerical' as const },
        ];
        const rows = [
            { Region: ' North ', Month: '2024-01', Sales: '1,200' },
            { Region: 'South', Month: '2024-01', Sales: 'N/A' },
            { Region: '', Month: '', Sales: '' },
            { Region: 'Total', Month: '', Sales: '2,550' },
        ];
        const plan = await generateDataPreparationPlan(columns, rows, createTestSettings({ provider: 'default' }), undefined, undefined,
            undefined, undefined, { maxAttempts: 1, allowInternalRetry: false, allowDeterministicFallback: false });

        expect(bodies).toHaveLength(1);
        const [body] = bodies;
        expect(body).not.toHaveProperty('max_output_tokens');
        const format = (body.text as { format: { type: string; strict: boolean; schema: SchemaNode } }).format;
        expect(format).toMatchObject({ type: 'json_schema', strict: true });
        expect(format.schema).toEqual(prepareGatewayStructuredOutputSchema(dataSchemas.getDataPreparationProviderSchema({ defaultGateway: true })).schema);
        expectGatewayCompatible(format.schema, 'dataPreparer request');
        expect(plan.operations.map(operation => operation.type)).toEqual(expect.arrayContaining([
            'trim_whitespace', 'drop_blank_rows', 'drop_rows_by_condition', 'normalize_empty_values', 'cast_column',
        ]));
    });

    it('keeps every operation type when Google merges the operation union', () => {
        const google = prepareSchemaForProvider(dataSchemas.getDataPreparationProviderSchema(), 'google') as {
            properties: { operations: { items: { properties: { type: { enum: string[] } } } } };
        };
        expect(google.properties.operations.items.properties.type.enum).toEqual(expect.arrayContaining([
            'drop_rows_by_index', 'rename_columns', 'cast_column', 'filter_rows', 'unpivot_columns',
        ]));
    });
});
