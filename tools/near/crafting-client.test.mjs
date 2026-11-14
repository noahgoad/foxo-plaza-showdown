import test from 'node:test';
import assert from 'node:assert/strict';
import { craftMatches, craftTransfer, recipeQuote } from '../../src/economy/near-crafting.js';

const expected = { recipeId: 'finish', version: 1, sku: 'finish-a' };
const recipe = { ...expected, inputs: { alloy: 8, core: 1, catalyst: 0 }, feeAtomic: '5000000000000000000000000' };
const account = 'alice.testnet';

test('a Workshop craft uses exact FOXO units and a stable item ID', () => {
  const draft = craftTransfer({
    token: 'foxo.testnet', economy: 'economy.testnet', account,
    recipe: recipeQuote(recipe, expected), operationId: 'retry-1',
  });
  assert.equal(draft.receiverId, 'foxo.testnet');
  assert.equal(draft.args.receiver_id, 'economy.testnet');
  assert.equal(draft.args.amount, recipe.feeAtomic);
  assert.deepEqual(JSON.parse(draft.args.msg), {
    action: 'craft', operationId: 'retry-1', recipeId: 'finish', recipeVersion: 1,
  });
  assert.equal(draft.itemId, 'alice.testnet:retry-1');
});

test('a different recipe or item owner cannot confirm a Workshop craft', () => {
  assert.throws(() => recipeQuote({ ...recipe, version: 2 }, expected));
  assert.throws(() => recipeQuote({ ...recipe, feeAtomic: 5 }, expected));
  const itemId = 'alice.testnet:retry-1';
  const item = { itemId, ownerId: account, sku: recipe.sku, recipeId: recipe.recipeId, recipeVersion: 1 };
  assert.ok(craftMatches(item, { itemId, account, recipe }));
  assert.equal(craftMatches({ ...item, ownerId: 'bob.testnet' }, { itemId, account, recipe }), false);
  assert.equal(craftMatches(null, { itemId, account, recipe }), false);
});
