import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, createModels, Type } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

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
  const toolResult = context.messages.findLast((message) => message.role === 'toolResult');
  const content = toolResult
    ? [{ type: 'text', text: `Mock provider received the browser tool result: ${toolResult.content.map((part) => part.text || '').join(' ')}` }]
    : [{ type: 'toolCall', id: 'mock-sales-summary', name: 'summarize_rows', arguments: { column: 'sales' } }];
  const reason = toolResult ? 'stop' : 'toolUse';
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

function createSummaryTool(rows) {
  return {
    name: 'summarize_rows',
    label: 'Summarize rows',
    description: 'Count non-empty numeric values and sum one column in the browser-held rows.',
    parameters: Type.Object({ column: Type.String({ description: 'Numeric column name' }) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, { column }) => {
      if (!rows.some((row) => Object.hasOwn(row, column))) {
        throw new Error(`Unknown column: ${column}`);
      }

      const values = rows
        .map((row) => row[column])
        .filter((value) => value !== '' && value !== null && value !== undefined)
        .map(Number)
        .filter(Number.isFinite);
      const sum = values.reduce((total, value) => total + value, 0);
      const details = { column, count: values.length, sum };
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  };
}

export function createSpikeAgent({ mode, rows, apiKey, modelId = 'gpt-5.4-mini', thinkingLevel = 'medium', onEvent }) {
  const model = models.getModel('openai', modelId);
  if (!model) throw new Error(`The installed Pi catalog does not contain OpenAI model ${modelId}.`);
  if (mode === 'live' && !apiKey) throw new Error('Add a local OpenAI API key before running live mode.');
  if (!['mock', 'live'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);

  const streamFn = mode === 'mock'
    ? mockStream
    : (requestedModel, context, options) => models.streamSimple(requestedModel, context, { ...options, apiKey });

  const agent = new Agent({
    initialState: {
      systemPrompt: 'You are testing a browser CSV assistant. For numeric questions about the loaded rows, use summarize_rows before answering. Keep answers brief.',
      model,
      thinkingLevel,
      tools: [createSummaryTool(rows)],
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
