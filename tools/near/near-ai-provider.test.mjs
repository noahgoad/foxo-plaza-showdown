import test from 'node:test';
import assert from 'node:assert/strict';
import { createNearAiQuartermasterProvider } from '../../server/near/near-ai-provider.mjs';

test('NEAR AI gateway receives server credentials and returns only the proposal for policy validation', async () => {
  const proposal = { sku: 'finish', quantity: 1, priceAtomic: '5', reason: 'stock shortage', expiresAtMs: 2000, policyVersion: 'pilot-1' };
  const provider = createNearAiQuartermasterProvider({ apiKey: 'test-only', model: 'test/model', now: () => 1000,
    async fetchImpl(url, options) {
      assert.equal(url, 'https://cloud-api.near.ai/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer test-only');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test/model');
      assert.equal(JSON.parse(body.messages[1].content).nowMs, 1000);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(proposal) } }] }) };
    },
  });
  assert.deepEqual(await provider({ skus: [] }), proposal);
});
