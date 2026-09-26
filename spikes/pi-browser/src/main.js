import { createSpikeAgent, getFinalText } from './agent.js';

const rows = [
  { region: 'North', sales: 120 },
  { region: 'South', sales: 80 },
  { region: 'East', sales: 50 },
];

const modelId = import.meta.env.VITE_PI_MODEL || 'gpt-5.4-mini';
const thinkingLevel = import.meta.env.VITE_PI_REASONING || 'medium';
const isLocalDev = import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(location.hostname);
const apiKey = isLocalDev ? import.meta.env.VITE_OPENAI_API_KEY || '' : '';

const promptInput = document.querySelector('#prompt');
const mockButton = document.querySelector('#run-mock');
const liveButton = document.querySelector('#run-live');
const status = document.querySelector('#status');
const timeline = document.querySelector('#timeline');
const answer = document.querySelector('#answer');

document.querySelector('#configuration').textContent = `${modelId} · reasoning ${thinkingLevel} · browser runtime`;
document.querySelector('#dataset').textContent = JSON.stringify(rows, null, 2);
liveButton.disabled = !apiKey;
liveButton.title = apiKey ? 'Run a live OpenAI request' : 'Run npm run dev with VITE_OPENAI_API_KEY in .env.local';

function log(message) {
  const item = document.createElement('li');
  item.textContent = message;
  timeline.append(item);
}

function recordEvent(event) {
  if (event.type === 'turn_start') log('Pi started a model turn.');
  if (event.type === 'tool_execution_start') log(`Pi called browser tool: ${event.toolName}.`);
  if (event.type === 'tool_execution_end') {
    const result = event.isError ? 'failed' : 'completed';
    log(`Browser tool ${event.toolName} ${result}.`);
  }
  if (event.type === 'turn_end') log(`Pi completed a turn with ${event.toolResults.length} tool result(s).`);
  if (event.type === 'agent_end') log('Pi agent run finished.');
}

async function run(mode) {
  mockButton.disabled = true;
  liveButton.disabled = true;
  timeline.replaceChildren();
  answer.textContent = '';
  status.textContent = `Running ${mode} mode...`;

  try {
    const agent = createSpikeAgent({ mode, rows, apiKey, modelId, thinkingLevel, onEvent: recordEvent });
    await agent.prompt(promptInput.value.trim() || 'What is the total sales?');
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    answer.textContent = getFinalText(agent) || 'No text answer was returned.';
    status.textContent = `${mode} mode completed.`;
  } catch (error) {
    status.textContent = `${mode} mode failed.`;
    answer.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    mockButton.disabled = false;
    liveButton.disabled = !apiKey;
  }
}

mockButton.addEventListener('click', () => run('mock'));
liveButton.addEventListener('click', () => run('live'));
