import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapFixedRewards } from '../../server/near/reward-bootstrap.mjs';

test('disabled rewards need no signer and enabled rewards reject missing deployment configuration', async () => {
  assert.equal(await bootstrapFixedRewards({ config: { features: { nearRewards: false } }, environment: {} }), null);
  await assert.rejects(bootstrapFixedRewards({ config: { features: { nearRewards: true } }, environment: {} }), /incomplete/);
});
