import { createSpikeAgent, getFinalText } from './agent.js';
import { parseCsvFile } from './csv.js';

const modelId = import.meta.env.VITE_PI_MODEL || 'gpt-5.4-mini';
const thinkingLevel = import.meta.env.VITE_PI_REASONING || 'medium';
const isLocalDev = import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(location.hostname);
const apiKey = isLocalDev ? import.meta.env.VITE_OPENAI_API_KEY || '' : '';

const fileInput = document.querySelector('#csv-file');
const datasetInfo = document.querySelector('#dataset');
const promptInput = document.querySelector('#prompt');
const mockButton = document.querySelector('#run-mock');
const liveButton = document.querySelector('#run-live');
const status = document.querySelector('#status');
const timeline = document.querySelector('#timeline');
const answer = document.querySelector('#answer');
let dataset = null;

document.querySelector('#configuration').textContent = `${modelId} · reasoning ${thinkingLevel} · browser runtime`;
mockButton.disabled = true;
liveButton.disabled = true;
liveButton.title = apiKey ? 'Run a live OpenAI request' : 'Run npm run dev with VITE_OPENAI_API_KEY in .env.local';

fileInput.addEventListener('change', async () => {
  fileInput.disabled = true;
  dataset = null;
  mockButton.disabled = true;
  liveButton.disabled = true;
  timeline.replaceChildren();
  answer.textContent = '';
  status.textContent = 'Loading CSV...';

  try {
    dataset = await parseCsvFile(fileInput.files[0]);
    datasetInfo.textContent = `${dataset.name}: ${dataset.rows.length.toLocaleString()} rows; columns: ${dataset.columns.join(', ')}`;
    status.textContent = 'CSV loaded. Ask a question.';
    mockButton.disabled = false;
    liveButton.disabled = !apiKey;
  } catch (error) {
    datasetInfo.textContent = 'No CSV loaded.';
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    fileInput.disabled = false;
  }
});

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
  if (!dataset) return;
  fileInput.disabled = true;
  mockButton.disabled = true;
  liveButton.disabled = true;
  timeline.replaceChildren();
  answer.textContent = '';
  status.textContent = `Running ${mode} mode...`;

  try {
    const agent = createSpikeAgent({ mode, dataset, apiKey, modelId, thinkingLevel, onEvent: recordEvent });
    await agent.prompt(promptInput.value.trim() || 'Inspect the uploaded dataset and report its columns.');
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    answer.textContent = getFinalText(agent) || 'No text answer was returned.';
    status.textContent = `${mode} mode completed.`;
  } catch (error) {
    status.textContent = `${mode} mode failed.`;
    answer.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    fileInput.disabled = false;
    mockButton.disabled = false;
    liveButton.disabled = !apiKey;
  }
}

mockButton.addEventListener('click', () => run('mock'));
liveButton.addEventListener('click', () => run('live'));
