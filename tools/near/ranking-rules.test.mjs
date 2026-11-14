import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyRankingBudget, rankingAwardForScore, allocateModeRanking, bestRankingScores, RANKING_MODES } from '../../src/economy/ranking-rules.js';

const UNIT = 10n ** 24n;
const award = overrides => rankingAwardForScore({ budgetAtomic: '1000', capAtomic: '625', scoreAtomic: '100', totalScoreAtomic: '100', scoreScaleAtomic: '100', ...overrides });

test('each mode distributes exactly its 1000 FOXO budget across 28 days including remainder', () => {
  assert.deepEqual(RANKING_MODES, ['hunt', 'boss', 'control', 'trials']);
  for (const mode of RANKING_MODES) {
    const days = Array.from({ length: 28 }, (_, day) => BigInt(dailyRankingBudget(day)));
    assert.equal(days.reduce((a, b) => a + b, 0n), 1000n * UNIT, mode);
    assert.ok(days.every(n => n === days[0] || n === days[0] - 1n));
  }
  assert.equal(RANKING_MODES.reduce(sum => sum + 1000n * UNIT, 0n), 4000n * UNIT);
  assert.equal(dailyRankingBudget(0, { modeBudgetAtomic: '5', seasonDays: 3 }), '2');
  assert.equal(dailyRankingBudget(2, { modeBudgetAtomic: '5', seasonDays: 3 }), '1');
});

test('ranking denominator floors at ten normalized scores, caps payouts, and floors atomic dust', () => {
  assert.equal(award({}), '100');
  assert.equal(award({ totalScoreAtomic: '1000' }), '100');
  assert.equal(award({ totalScoreAtomic: '2000' }), '50');
  assert.equal(award({ capAtomic: '6' }), '6');
  assert.equal(award({ scoreAtomic: '1', totalScoreAtomic: '1', budgetAtomic: '19' }), '0');
  assert.equal(award({ scoreAtomic: '0', totalScoreAtomic: '0' }), '0');
  assert.equal(award({ budgetAtomic: ((1n << 128n) - 1n).toString(), capAtomic: ((1n << 128n) - 1n).toString() }), (((1n << 128n) - 1n) / 10n).toString());
});

test('zero, one and 1000 players retain unallocated funds and preserve per-account cap', () => {
  const empty = allocateModeRanking({ mode: 'hunt', dayIndex: 0, entries: [] });
  assert.equal(empty.awardedAtomic, '0');
  assert.equal(empty.unallocatedAtomic, empty.budgetAtomic);
  const one = allocateModeRanking({ mode: 'hunt', dayIndex: 0, entries: [{ accountId: 'alice.testnet', scoreAtomic: '1000000' }] });
  assert.equal(one.allocations[0].amountAtomic, (BigInt(one.budgetAtomic) / 10n).toString());
  const many = allocateModeRanking({ mode: 'boss', dayIndex: 0, entries: Array.from({ length: 1000 }, (_, i) => ({ accountId: `player${i}.testnet`, scoreAtomic: '1000000' })) });
  assert.ok(many.allocations.every(row => BigInt(row.amountAtomic) <= 625n * UNIT / 100n));
  assert.equal(BigInt(many.awardedAtomic) + BigInt(many.unallocatedAtomic), BigInt(many.budgetAtomic));
  assert.equal(BigInt(many.awardedAtomic), BigInt(many.budgetAtomic) / 1000n * 1000n);
});

test('mode selection keeps three best normalized results or one Trials best without mutating input', () => {
  const scores = ['1', '800000', '1000000', '900000'];
  for (const mode of ['hunt', 'boss', 'control']) assert.deepEqual(bestRankingScores(mode, scores), ['1000000', '900000', '800000']);
  assert.deepEqual(bestRankingScores('trials', scores), ['1000000']);
  assert.deepEqual(scores, ['1', '800000', '1000000', '900000']);
});

test('reject invalid scores, amount numbers, duplicates, mixed pools and out-of-season days', () => {
  for (const scoreAtomic of ['-1', '01', '1000001', 1, 1.5]) assert.throws(() => allocateModeRanking({ mode: 'hunt', dayIndex: 0, entries: [{ accountId: 'alice.testnet', scoreAtomic }] }));
  assert.throws(() => award({ budgetAtomic: 1000 }));
  assert.throws(() => award({ totalScoreAtomic: '0' }));
  assert.throws(() => award({ budgetAtomic: (1n << 128n).toString() }));
  assert.throws(() => dailyRankingBudget(28));
  assert.throws(() => allocateModeRanking({ mode: 'practice', dayIndex: 0, entries: [] }));
  assert.throws(() => allocateModeRanking({ mode: 'hunt', dayIndex: 0, entries: [{ accountId: 'alice.testnet', mode: 'boss', scoreAtomic: '1' }] }));
  assert.throws(() => allocateModeRanking({ mode: 'hunt', dayIndex: 0, entries: [{ accountId: 'alice.testnet', scoreAtomic: '1' }, { accountId: 'alice.testnet', scoreAtomic: '1' }] }));
});
