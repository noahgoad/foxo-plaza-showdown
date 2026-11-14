import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPilotPolicy } from '../../src/economy/policy.js';

const config = JSON.parse(await readFile(new URL('../../config/economy.testnet.json', import.meta.url)));
test('pilot config does not spend unallocated funds or enable unverified features', () => {
  assert.equal(config.designRevision, '2.1');
  assert.deepEqual(config.budgetsFoxo, { match: '80000', faucet: '5000', staking: '15000' });
  const enabled = Object.entries(config.features).filter(([, active]) => active).map(([name]) => name).sort();
  assert.deepEqual(enabled, ['crafting', 'materials', 'nearRewards', 'orders', 'passport']);
  assert.deepEqual(config.quartermaster, { enabled: false, budgetFoxo: '0' });
  assert.ok(Object.values(config.deferred).every(value => value === true));
});

test('policy refuses disabled ranking and rejects budgets that overbook the campaign', () => {
  const policy = createPilotPolicy(config);
  assert.equal(policy.availableSlots({ dayIndex: 0, windowIndex: 0, reservedByWindow: [19, 0, 0, 0, 0, 0] }), 1);
  assert.throws(() => policy.draftRanking({ mode: 'boss', dayIndex: 0, entries: [] }), /disabled/);
  const altered = structuredClone(config);
  altered.ranking.modeBudgetsFoxo.boss = '1001';
  assert.throws(() => createPilotPolicy(altered), /season budget/);
});
test('fixed and mode budgets reconcile to the campaign, not the full supply', () => {
  const p = config.pilot;
  assert.equal(p.fixedBps + p.rankingBps, 10000);
  const season = BigInt(p.seasonBudgetFoxo);
  const ranking = Object.values(config.ranking.modeBudgetsFoxo).reduce((sum, n) => sum + BigInt(n), 0n);
  assert.equal(ranking, season * BigInt(p.rankingBps) / 10000n);
  const windows = config.rewardWindows;
  const slots = p.seasonDays * windows.windowsPerDay * windows.baseSlotsPerWindow + windows.extraSlotDays;
  assert.equal(BigInt(slots) * BigInt(p.fixedAwardFoxo), season * BigInt(p.fixedBps) / 10000n);
  assert.deepEqual(config.ranking.enabledModes, []);
});
