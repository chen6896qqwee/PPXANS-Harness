import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PPXAgent } from '../src/agent/index.js';

function tracker(client) {
  const agent = Object.create(PPXAgent.prototype);
  agent.config = { budget: { model_prices: { served: { prompt: 1, completion: 2 } } } };
  agent.usageStats = { calls: 0, failedCalls: 0, tokens: 0, cost: 0, knownCost: 0,
    unknownCostCalls: 0, missingUsageCalls: 0, byModel: {} };
  agent._lastUsageFlushCalls = 0;
  agent.llm = client;
  agent.allProviders = [client];
  agent._installUsageTracking();
  return agent;
}

test('served model, streaming usage, and every failed attempt remain in the ledger', async () => {
  const client = { model: 'configured-alias',
    apiChat: async () => ({ model: 'served', usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
    streamChat: async (_, options) => {
      options.onUsage({ prompt_tokens: 1000, completion_tokens: 500 }, { model: 'served' });
      return 'visible text';
    },
    chat: async () => { throw new Error('connection failed without billing receipt'); },
  };
  const agent = tracker(client);
  await client.apiChat([]);
  let forwarded = null;
  assert.equal(await client.streamChat([], { onUsage: (u, m) => { forwarded = m.model; } }), 'visible text');
  assert.equal(forwarded, 'served');
  assert.equal(agent.usageStats.cost, 0.004);
  await assert.rejects(client.chat([]));
  assert.equal(agent.usageStats.calls, 3);
  assert.equal(agent.usageStats.failedCalls, 1);
  assert.equal(agent.usageStats.cost, null);
  assert.equal(agent.usageStats.knownCost, 0.004);
  assert.equal(agent.usageStats.missingUsageCalls, 1);
  assert.equal(agent.usageStats.unknownCostCalls, 1);
  assert.equal(agent.usageStats.byModel.served.calls, 2);
});

test('unknown price is distinct from an explicitly priced free model', async () => {
  const client = { model: 'unknown-model', apiChat: async () => ({ usage: { total_tokens: 10 } }) };
  const agent = tracker(client);
  await client.apiChat([]);
  assert.equal(agent.usageStats.cost, null);
  assert.equal(agent.usageStats.unknownCostCalls, 1);
  agent._accountModelUsage('glm-4-flash', { total_tokens: 10 });
  assert.equal(agent.usageStats.byModel['glm-4-flash'].cost, 0);
  assert.equal(agent.usageStats.byModel['glm-4-flash'].unknownCostCalls, 0);
});

test('wrapping an existing provider again does not double count it', async () => {
  const client = { model: 'served', apiChat: async () => ({ usage: { total_tokens: 10 } }) };
  const agent = tracker(client);
  agent._installUsageTracking();
  await client.apiChat([]);
  assert.equal(agent.usageStats.calls, 1);
});
