import test from 'node:test';
import assert from 'node:assert/strict';
import { fundOrderDraft, matchingOrderItems, orderMatches, orderPriceAtomic } from '../../src/economy/near-orders.js';

const fields = {
  token: 'foxo.testnet', economy: 'economy.testnet', buyer: 'alice.testnet', operationId: 'order-1',
  recipe: { recipeId: 'finish', version: 3 }, price: '0.000000000000000000000001',
  quantity: 3, expiresAtMs: 100_000,
};

test('order quote uses exact base units and binds funding to the published recipe version', () => {
  const draft = fundOrderDraft(fields);
  assert.equal(draft.id, 'alice.testnet:order-1');
  assert.equal(draft.receiverId, 'foxo.testnet');
  assert.equal(draft.args.receiver_id, 'economy.testnet');
  assert.equal(draft.args.amount, '3');
  assert.deepEqual(JSON.parse(draft.args.msg), {
    action: 'fund_order', operationId: 'order-1', recipeId: 'finish',
    recipeVersion: 3, quantity: 3, unitPrice: '1', expiresAtMs: 100_000,
  });
  for (const bad of ['1e3', '0', '-1', '1.0000000000000000000000001']) assert.throws(() => orderPriceAtomic(bad));
  assert.throws(() => fundOrderDraft({ ...fields, quantity: 101 }));
  assert.throws(() => fundOrderDraft({ ...fields, price: '340282366920938' }));
});

test('confirmation accepts partial fills but rejects mismatched terms and inventory', () => {
  const draft = fundOrderDraft(fields);
  const order = { buyerId: 'alice.testnet', recipeId: 'finish', recipeVersion: 3, unitPrice: '1', expiresAtMs: 100_000, remaining: 2 };
  const item = { ownerId: 'bob.testnet', recipeId: 'finish', recipeVersion: 3 };
  assert.ok(orderMatches(order, draft));
  assert.equal(orderMatches({ ...order, unitPrice: '2' }, draft), false);
  assert.equal(orderMatches({ ...order, remaining: 4 }, draft), false);
  assert.deepEqual(matchingOrderItems([item, { ...item, recipeVersion: 2 }], order, 'bob.testnet'), [item]);
  assert.deepEqual(matchingOrderItems([{ ...item, ownerId: 'alice.testnet' }], order, 'alice.testnet'), []);
});
