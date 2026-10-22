import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import {
    DEFAULT_GATEWAY_PI_REQUEST_BYTE_BUDGET,
    PI_CONTEXT_COMPACTION_TRIGGER_RATIO,
    PROVIDER_CONTEXT_WINDOW_CAP,
} from '../config/agentDefaults';
import { buildBuiltinToolRegistry } from '../services/agent/tools/toolRegistry';
import { estimatePiRequestBytes } from '../services/agent/runtime/pi/piContextCompaction';
import {
    createPiProviderContextTransform, createPiProviderStream, resolvePiModel, resolvePiRequestByteBudget,
} from '../services/agent/runtime/pi/piProvider';
import { resetDemoGatewaySessionForTests } from '../services/ai/demoGatewaySession';
import { resetDemoGatewayRequestLimiterForTests } from '../services/ai/browserProviderFetch';
import { getDefaultSettings } from '../services/storageService';

type WireItem = { type?: string; role?: string; call_id?: string; content?: unknown; output?: unknown };
type WireBody = { input: WireItem[]; tools?: Array<{ name: string }> };

const defaultSettings = { ...getDefaultSettings(), provider: 'default' as const };
const LOWEST_OBSERVED_REJECTION_BYTES = 209_109;
const SUMMARY_TEXT = 'SUMMARY-MARKER: goal is the governed CSV analysis; stages 1-N passed with recorded facts.';

// The 23 shared app tools the qualified initial analysis declares next to its stage tool
// (measured from createPiAppTools with a prepared coding task).
const QUALIFIED_APP_TOOL_NAMES = [
    'data.query', 'data.describe', 'data.value_counts', 'data.outliers', 'data.missing',
    'workspace.list', 'workspace.read', 'workspace.search', 'workspace.replace', 'workspace.write',
    'workspace.append', 'code.run', 'code.inspect', 'code.cancel', 'computation.validate',
    'candidate.stage', 'candidate.read', 'candidate.diff', 'candidate.abandon', 'candidate.validate',
    'candidate.request_approval', 'candidate.infer_meaning',
];

const declarationOnlyTools = (): AgentTool[] => {
    const registry = buildBuiltinToolRegistry(Array.from({ length: 20 }, (_, index) => `Column ${index}`));
    const tools: AgentTool[] = registry.manifests
        .filter(manifest => QUALIFIED_APP_TOOL_NAMES.includes(manifest.name))
        .map(manifest => ({
            name: manifest.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
            label: manifest.name,
            description: [manifest.description, ...(manifest.promptHints ?? [])].join(' ').slice(0, 4_000),
            parameters: manifest.inputSchema as never,
            execute: async () => { throw new Error('declaration only'); },
        }));
    tools.push({
        name: 'read_skill', label: 'read_skill', description: 'Read one pinned analysis skill by name.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } as never,
        execute: async () => { throw new Error('declaration only'); },
    });
    return tools;
};

let stageCalls = 0;
const stageTool: AgentTool = {
    name: 'run_next_analysis_stage',
    label: 'run_next_analysis_stage',
    description: 'Run the next governed analysis stage. With no arguments it runs the next required stage.',
    parameters: {
        type: 'object',
        properties: { stage: { type: 'string' }, reason: { type: 'string' } },
        additionalProperties: false,
    } as never,
    execute: async () => {
        stageCalls += 1;
        // App tool results are bounded near 6,000 characters (MAX_TOOL_RESULT_CHARS).
        const facts = Array.from({ length: 60 }, (_, index) => ({ column: `Column ${index % 20}`, stat: index * 17.5, note: `stage ${stageCalls} fact ${index}` }));
        return { details: undefined, content: [{ type: 'text', text: JSON.stringify({
            stage: `stage-${stageCalls}`, decision: 'pass', summary: `Stage ${stageCalls} completed.`, facts,
        }).slice(0, 6_000) }] };
    },
};

const usage = { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const sse = (events: Array<Record<string, unknown>>) => new Response(
    events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
);
const textResponse = (id: string, text: string) => sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `msg_${id}`, role: 'assistant', content: [] } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } },
    { type: 'response.completed', response: { id: `resp_${id}`, status: 'completed', output: [], usage } },
]);
const toolCallResponse = (turn: number) => {
    // Reasoning items with encrypted content are replayed on every later request, as on the live gateway.
    const reasoning = { type: 'reasoning', id: `rs_${turn}`, summary: [{ type: 'summary_text', text: `Turn ${turn}: run the next stage.` }], encrypted_content: 'e'.repeat(2_000) };
    const call = { type: 'function_call', id: `fc_${turn}`, call_id: `call_${turn}`, name: 'run_next_analysis_stage', arguments: '{}', status: 'completed' };
    return sse([
        { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [], encrypted_content: undefined } },
        { type: 'response.output_item.done', output_index: 0, item: reasoning },
        { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
        { type: 'response.output_item.done', output_index: 1, item: call },
        { type: 'response.completed', response: { id: `resp_${turn}`, status: 'completed', output: [], usage } },
    ]);
};
const session = () => new Response(JSON.stringify({ token: 'dmo_test', model: 'demo-openai-mini', expires_in: 900 }), { status: 201 });
const bytesOf = (raw: string) => new TextEncoder().encode(raw).length;
const wireText = (item: WireItem) => JSON.stringify(item.content ?? item.output ?? '');

describe('Default gateway Pi request byte budget', () => {
    beforeEach(() => {
        stageCalls = 0;
        vi.stubEnv('VITE_DEFAULT_GATEWAY_PROJECT_ID', 'test-project');
        resetDemoGatewaySessionForTests();
        resetDemoGatewayRequestLimiterForTests();
    });
    afterEach(() => {
        resetDemoGatewaySessionForTests();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('compacts a growing tool transcript before any serialized request exceeds the budget', async () => {
        const TOOL_TURNS = 40;
        const modelBodies: Array<{ bytes: number; body: WireBody }> = [];
        const summaryBodies: Array<{ bytes: number; body: WireBody }> = [];
        let turn = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (String(input).endsWith('/demo/session')) return session();
            const raw = await (input as Request).text();
            const body = JSON.parse(raw) as WireBody;
            expect(body).not.toHaveProperty('max_output_tokens');
            // Only the summarizer request is sent without tools.
            if (!body.tools?.length) {
                summaryBodies.push({ bytes: bytesOf(raw), body });
                return textResponse(`summary_${summaryBodies.length}`, SUMMARY_TEXT);
            }
            modelBodies.push({ bytes: bytesOf(raw), body });
            turn += 1;
            return turn <= TOOL_TURNS ? toolCallResponse(turn) : textResponse('final', 'All stages are complete.');
        }));
        const onDegraded = vi.fn();
        const agent = new Agent({
            initialState: {
                systemPrompt: 'You coordinate the app-governed CSV analysis lifecycle. Call run_next_analysis_stage repeatedly.',
                model: resolvePiModel(defaultSettings),
                thinkingLevel: 'medium',
                tools: [stageTool],
            },
            streamFn: createPiProviderStream(defaultSettings),
            transformContext: createPiProviderContextTransform(defaultSettings, onDegraded),
            toolExecution: 'sequential',
        });
        // Like the qualified initial analysis: tools added after construction are declared on a
        // later system message, which compaction must keep.
        agent.state.tools = [stageTool, ...declarationOnlyTools()];

        await agent.prompt('Start the next governed stage. Continue until all stages are complete.');

        expect(agent.state.errorMessage).toBeUndefined();
        expect(stageCalls).toBe(TOOL_TURNS);
        expect(modelBodies).toHaveLength(TOOL_TURNS + 1);
        // Without compaction this run would exceed the lowest observed gateway rejection.
        expect(estimatePiRequestBytes(agent.state.messages)).toBeGreaterThan(LOWEST_OBSERVED_REJECTION_BYTES * 1.5);
        // The full transcript is retained locally; only the model view is compacted.
        expect(JSON.stringify(agent.state.messages)).toContain('stage 1 fact 0');

        const largest = Math.max(...modelBodies.map(entry => entry.bytes));
        expect(largest).toBeLessThanOrEqual(DEFAULT_GATEWAY_PI_REQUEST_BYTE_BUDGET);
        expect(largest).toBeGreaterThan(DEFAULT_GATEWAY_PI_REQUEST_BYTE_BUDGET * 0.6);
        expect(summaryBodies.length).toBeGreaterThan(0);
        for (const entry of summaryBodies) expect(entry.bytes).toBeLessThanOrEqual(DEFAULT_GATEWAY_PI_REQUEST_BYTE_BUDGET);
        expect(onDegraded).not.toHaveBeenCalled();

        const toolNames = stageTool.name;
        for (const { body } of modelBodies) {
            // Every request still declares the full 24-tool set, including tools from the later system message.
            expect(body.tools).toHaveLength(24);
            expect(body.tools?.map(tool => tool.name)).toContain(toolNames);
            // No function_call_output is ever separated from its function_call.
            const calls = new Set(body.input.filter(item => item.type === 'function_call').map(item => item.call_id));
            const outputs = body.input.filter(item => item.type === 'function_call_output').map(item => item.call_id);
            for (const callId of outputs) expect(calls.has(callId)).toBe(true);
        }

        const firstCompacted = modelBodies.findIndex(({ body }) => body.input.some(item => wireText(item).includes('SUMMARY-MARKER')));
        expect(firstCompacted).toBeGreaterThan(0);
        for (const { body } of modelBodies.slice(firstCompacted)) {
            expect(body.input.some(item => wireText(item).includes('Earlier conversation summary:'))).toBe(true);
            expect(body.input.some(item => wireText(item).includes('stage 1 fact 0'))).toBe(false);
        }
        // The request after compaction still carries the most recent complete tool pair.
        const next = modelBodies[firstCompacted].body.input;
        const lastOutput = next.filter(item => item.type === 'function_call_output').at(-1);
        expect(lastOutput?.call_id).toBe(`call_${firstCompacted}`);
        expect(next.some(item => item.type === 'function_call' && item.call_id === lastOutput?.call_id)).toBe(true);
    }, 30_000);

    it('keeps the summarizer request itself under the gateway budget', async () => {
        const summaryBodies: number[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (String(input).endsWith('/demo/session')) return session();
            const raw = await (input as Request).text();
            summaryBodies.push(bytesOf(raw));
            return textResponse('summary', SUMMARY_TEXT);
        }));
        const transform = createPiProviderContextTransform(defaultSettings);
        const system = { role: 'system', content: 'Coordinate the analysis.', timestamp: 0 } as AgentMessage;
        // User text is not truncated by the conversation serializer, so this history alone is ~400 KB.
        const huge = { role: 'user', content: [{ type: 'text', text: 'Old pasted notes. '.repeat(22_000) }], timestamp: 1 } as AgentMessage;
        const latest = { role: 'user', content: [{ type: 'text', text: 'Current question.' }], timestamp: 2 } as AgentMessage;

        const result = await transform([system, huge, latest]);

        expect(summaryBodies).toHaveLength(1);
        expect(summaryBodies[0]).toBeLessThanOrEqual(DEFAULT_GATEWAY_PI_REQUEST_BYTE_BUDGET);
        expect(result).toHaveLength(3);
        expect(result[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: expect.stringContaining('SUMMARY-MARKER') }] });
        expect(result[2]).toBe(latest);
    });
});

describe('non-Default providers keep the token-based compaction policy', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const base = getDefaultSettings();
    const providers = [
        ['openai', { ...base, provider: 'openai' as const, openAIApiKey: 'test-only-key', complexModel: 'gpt-5.4-mini' }],
        ['google', { ...base, provider: 'google' as const, geminiApiKey: 'test-only-key', complexModel: 'gemini-2.5-flash' }],
    ] as const;

    const system = { role: 'system', content: 'Coordinate the analysis.', timestamp: 0 } as AgentMessage;
    // ~300 KB of JSON: about 100k estimated tokens, below the 160k token trigger.
    const history = Array.from({ length: 50 }, (_, index) => ({
        role: 'user', content: [{ type: 'text', text: `${index}:${'h'.repeat(6_000)}` }], timestamp: index + 1,
    }) as AgentMessage);
    const messages = [system, ...history];

    for (const [name, settings] of providers) {
        it(`${name}: no byte budget, 200k planning cap, and a 300 KB history passes unchanged`, async () => {
            expect(resolvePiRequestByteBudget(settings)).toBeUndefined();
            expect(resolvePiModel(settings).contextWindow).toBeLessThanOrEqual(PROVIDER_CONTEXT_WINDOW_CAP);
            expect(PI_CONTEXT_COMPACTION_TRIGGER_RATIO).toBe(0.8);
            const upstream = vi.fn(async () => { throw new Error('no summary request expected'); });
            vi.stubGlobal('fetch', upstream);
            expect(estimatePiRequestBytes(messages)).toBeGreaterThan(LOWEST_OBSERVED_REJECTION_BYTES);

            const result = await createPiProviderContextTransform(settings)(messages);

            expect(result).toEqual(messages);
            expect(upstream).not.toHaveBeenCalled();
        });
    }

    it('default: the same 300 KB history is compacted under the byte budget', async () => {
        vi.stubEnv('VITE_DEFAULT_GATEWAY_PROJECT_ID', 'test-project');
        resetDemoGatewaySessionForTests();
        resetDemoGatewayRequestLimiterForTests();
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) =>
            String(input).endsWith('/demo/session') ? session() : textResponse('summary', SUMMARY_TEXT)));
        try {
            const result = await createPiProviderContextTransform(defaultSettings)(messages);

            expect(result[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: expect.stringContaining('SUMMARY-MARKER') }] });
            expect(result.at(-1)).toBe(messages.at(-1));
            expect(estimatePiRequestBytes(result)).toBeLessThanOrEqual(DEFAULT_GATEWAY_PI_REQUEST_BYTE_BUDGET);
        } finally {
            resetDemoGatewaySessionForTests();
            vi.unstubAllEnvs();
        }
    });
});
