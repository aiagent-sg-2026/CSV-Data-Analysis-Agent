import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, createModels, Type } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { aggregateDataset, inspectDataset } from './analysis.js';

const models = createModels();
models.setProvider(openaiProvider());

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function mockStream(model, context) {
  // A fixed provider response makes the real Pi tool loop testable without a key.
  const stream = createAssistantMessageEventStream();
  const results = context.messages.filter((message) => message.role === 'toolResult');
  const numericColumn = results.length > 0
    ? JSON.parse(results[0].content[0].text).numericColumns[0]
    : undefined;
  const content = results.length === 0
    ? [{ type: 'toolCall', id: 'mock-inspect', name: 'inspect_dataset', arguments: {} }]
    : results.length === 1
      ? [{ type: 'toolCall', id: 'mock-aggregate', name: 'aggregate_rows', arguments: numericColumn ? { metric: numericColumn } : {} }]
      : [{ type: 'text', text: `Mock provider received the browser aggregation: ${results.at(-1).content.map((part) => part.text || '').join(' ')}` }];
  const reason = results.length < 2 ? 'toolUse' : 'stop';
  const message = {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage,
    stopReason: reason,
    timestamp: Date.now(),
  };

  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason, message });
  return stream;
}

function createDatasetTools(dataset) {
  const inspectTool = {
    name: 'inspect_dataset',
    label: 'Inspect dataset',
    description: 'Get CSV column names, likely numeric columns, and row count. Raw rows are not returned.',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    execute: async () => ({ content: [{ type: 'text', text: JSON.stringify(inspectDataset(dataset)) }] }),
  };

  const aggregateTool = {
    name: 'aggregate_rows',
    label: 'Aggregate rows',
    description: 'Filter local CSV rows, optionally group by one column, then return counts and numeric sum/average. Use equals or starts_with filters. Raw rows are not returned.',
    parameters: Type.Object({
      metric: Type.Optional(Type.String({ description: 'Numeric column for sum and average; omit for counts only.' })),
      filters: Type.Optional(Type.Array(Type.Object({
        column: Type.String(),
        operator: Type.String({ description: 'equals or starts_with' }),
        value: Type.String(),
      }))),
      groupBy: Type.Optional(Type.String({ description: 'Column to group matching rows by.' })),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => ({ content: [{ type: 'text', text: JSON.stringify(aggregateDataset(dataset, args)) }] }),
  };

  return [inspectTool, aggregateTool];
}

export function createSpikeAgent({ mode, dataset, apiKey, modelId = 'gpt-5.4-mini', thinkingLevel = 'medium', onEvent }) {
  const model = models.getModel('openai', modelId);
  if (!model) throw new Error(`The installed Pi catalog does not contain OpenAI model ${modelId}.`);
  if (mode === 'live' && !apiKey) throw new Error('Add a local OpenAI API key before running live mode.');
  if (!['mock', 'live'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  if (!dataset?.rows?.length) throw new Error('Load a CSV file before running the agent.');

  const streamFn = mode === 'mock'
    ? mockStream
    : (requestedModel, context, options) => models.streamSimple(requestedModel, context, { ...options, apiKey });

  const agent = new Agent({
    initialState: {
      systemPrompt: 'You are testing a browser CSV assistant. Inspect the dataset first. Use aggregate_rows for every numeric claim; compare relevant subsets with separate calls when needed. Never invent values. Raw CSV rows stay in the browser; only tool summaries are available to you. Keep answers concise and include counts.',
      model,
      thinkingLevel,
      tools: createDatasetTools(dataset),
    },
    streamFn,
    toolExecution: 'sequential',
  });

  if (onEvent) agent.subscribe(onEvent);
  return agent;
}

export function getFinalText(agent) {
  const lastAssistant = agent.state.messages.findLast((message) => message.role === 'assistant');
  return lastAssistant?.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') || '';
}
