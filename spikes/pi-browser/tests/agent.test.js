import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpikeAgent, getFinalText } from '../src/agent.js';

test('Pi mock provider inspects a CSV and consumes an aggregate tool result', async () => {
  const events = [];
  const agent = createSpikeAgent({
    mode: 'mock',
    dataset: {
      name: 'sales.csv',
      columns: ['sales'],
      rows: [{ sales: '120' }, { sales: '80' }, { sales: '50' }],
    },
    onEvent: (event) => events.push(event.type),
  });

  await agent.prompt('What is the total sales?');

  assert.equal(agent.state.model.id, 'gpt-5.4-mini');
  assert.equal(agent.state.thinkingLevel, 'medium');
  assert.equal(events.filter((type) => type === 'turn_start').length, 3);
  assert.equal(events.filter((type) => type === 'tool_execution_end').length, 2);
  assert.match(getFinalText(agent), /"sum":250/);
  assert.equal(agent.state.errorMessage, undefined);
});
