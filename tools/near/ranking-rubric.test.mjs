import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewRankingScore, aggregateRankingPreviews, rankingMetricsFromSimulation } from '../../server/near/ranking-rubric.mjs';

const config = JSON.parse(readFileSync(new URL('../../config/ranking-rubrics.testnet.json', import.meta.url)));
const boss = { durationMs: 100000, activeMs: 90000, difficulty: 'normal', left: false,
  bossDamage: 0, bossMaxHp: 6000, allyHealing: 300, allyBlocked: 300, shieldBreaks: 3 };
test('review-only rubric rewards useful support over AFK, self heal, quit and easy farming', () => {
  const score = signals => BigInt(previewRankingScore('boss', signals, config).scoreAtomic);
  const support = score(boss);
  assert.ok(support > 0n);
  assert.equal(score({ ...boss, allyHealing: 0, allyBlocked: 0, shieldBreaks: 0, selfHealing: 1000000 }), 0n);
  assert.equal(score({ ...boss, activeMs: 0 }), 0n);
  assert.equal(score({ ...boss, left: true }), 0n);
  assert.equal(score({ ...boss, difficulty: 'easy' }), 0n);
  assert.equal(previewRankingScore('boss', { ...boss, activeMs: undefined }, config).status, 'missing_signals');
  assert.equal(previewRankingScore('boss', boss, config).enabled, false);
  assert.deepEqual(config.enabledModes, ['boss', 'hunt', 'control', 'trials']);
});

test('Daily Trials credits completed beacon holds even on a long eligible route', () => {
  const signals = { durationMs: 150_000, activeMs: 24_000, difficulty: 'normal', left: false,
    objectiveProgress: 8, remainingMs: 30_000, challengeDurationMs: 180_000, standardizedKit: true };
  assert.equal(previewRankingScore('trials', signals, config).scoreAtomic, '833333');
  assert.equal(previewRankingScore('trials', { ...signals, standardizedKit: false }, config).scoreAtomic, '0');
});

test('opponent repetition cannot increase a PvP preview and modes never mix', () => {
  const hunt = { durationMs: 300000, activeMs: 250000, difficulty: 'normal', left: false,
    captures: 3, traits: 4, supplies: 6, stuns: 5, humanOpponentCount: 2, maxOpponentMeetings: 1 };
  const clean = previewRankingScore('hunt', hunt, config);
  assert.ok(BigInt(clean.scoreAtomic) > 0n);
  assert.equal(previewRankingScore('hunt', { ...hunt, maxOpponentMeetings: 4 }, config).scoreAtomic, '0');
  assert.equal(previewRankingScore('hunt', { ...hunt, humanOpponentCount: 0 }, config).scoreAtomic, '0');
  assert.throws(() => aggregateRankingPreviews('boss', [clean], config), /Cross-mode/);
});

test('best three and best one are bounded fixed-point draft scores', () => {
  const rows = [1000000, 800000, 600000, 200000].map(score => ({ mode: 'boss', status: 'preview', scoreAtomic: String(score) }));
  assert.equal(aggregateRankingPreviews('boss', rows, config).scoreAtomic, '800000');
  assert.equal(aggregateRankingPreviews('trials', rows.map(r => ({ ...r, mode: 'trials' })), config).scoreAtomic, '1000000');
  assert.equal(aggregateRankingPreviews('boss', [], config).scoreAtomic, '0');
  assert.throws(() => aggregateRankingPreviews('boss', [{ ...rows[0], scoreAtomic: '1000001' }], config), /score/);
});

test('actual legacy Boss result exposes missing support separation and elapsed telemetry', () => {
  const room = { nearAuthoritative: true, roundId: 'r', config: { mode: 'boss', difficulty: 'normal' },
    roster: [{ nid: 0, nearWallet: 'alice.testnet' }] };
  const snapshot = { core: { phase: 'finished', roundId: 'r', result: { roundId: 'r', boss: { win: true, maxHp: 6000 },
    players: [{ id: 'hunt-0', left: false, activity: {}, raidStats: { damage: 20, healing: 9000, blocked: 20, breaks: 1 } }] } } };
  const metric = rankingMetricsFromSimulation(room, snapshot, 1000)[0];
  assert.equal(metric.signals.allyHealing, null);
  assert.equal(metric.signals.durationMs, null);
  assert.ok(metric.missing.includes('allyHealing'));
  assert.equal(metric.ready, false);
  assert.throws(() => rankingMetricsFromSimulation({ ...room, nearAuthoritative: false }, snapshot, 1000));
});

