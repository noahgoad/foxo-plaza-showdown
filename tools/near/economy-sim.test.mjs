import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { atomic, FOXO_SCALE, nftIdentity } from '../../src/economy/schema.js';
import { rankingAward } from '../../src/economy/policy.js';

const config = JSON.parse(readFileSync(new URL('../../config/economy.testnet.json', import.meta.url)));

test('atomic units are exact and original token IDs survive', () => {
  assert.equal(atomic('1000000000000000000000000'), FOXO_SCALE);
  for (const bad of [1, '01', '1e24', '-1', (1n << 128n).toString()]) {
    assert.throws(() => atomic(bad));
  }
  assert.equal(nftIdentity(config.contracts.collection, '045').tokenId, '045');
});

test('the proposed season split stays within the approved match allocation', () => {
  const { pilot, budgetsFoxo } = config;
  assert.equal(pilot.fixedBps + pilot.rankingBps, 10_000);
  assert.equal(BigInt(pilot.seasonCount) * BigInt(pilot.seasonBudgetFoxo), BigInt(budgetsFoxo.match));
});

test('ranking caps and rounding preserve the funded budget across participation levels', () => {
  const budget = 100n * FOXO_SCALE;
  const cap = 25n * FOXO_SCALE;
  for (const players of [1, 100, 1000]) {
    const each = BigInt(rankingAward({
      budgetAtomic: budget.toString(), capAtomic: cap.toString(),
      score: 300, totalScore: 300 * players, targetScore: 3000,
    }));
    assert.ok(each <= cap);
    assert.ok(each * BigInt(players) <= budget);
    if (players === 1) assert.equal(each, 10n * FOXO_SCALE);
  }
});
