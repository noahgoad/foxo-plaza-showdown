import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRankingDrafts } from '../../server/near/ranking.mjs';
import { prepareRankingDay } from '../../server/near/ranking-daily.mjs';
import { rankingMetricsHash } from '../../server/near/ranking-rubric.mjs';

const day = 86_400_000;
const read = name => JSON.parse(readFileSync(new URL('../../config/' + name, import.meta.url)));

test('frozen draft consumes authoritative telemetry and fails on a missing metric', t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`CREATE TABLE near_results(match_id, account_id, result_hash, payload);
    CREATE TABLE near_result_metrics(match_id, account_id, metrics_hash, payload)`);
  const config = read('economy.testnet.json');
  config.ranking.enabledModes = ['boss'];
  const rubric = read('ranking-rubrics.testnet.json');
  rubric.enabledModes = ['boss'];
  rubric.reviewStatus = 'approved';
  const drafts = createRankingDrafts({ database, config, now: () => day });
  const input = { database, config, rubric, drafts, campaignId: 'boss-season', seasonStartMs: 0,
    mode: 'boss', dayIndex: 0, now: day };
  const record = { matchId: 'a', accountId: 'player.testnet', mode: 'boss', left: false };
  const result = { ...record, resultHash: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    finishedAt: day - 1 };
  database.prepare('INSERT INTO near_results VALUES (?,?,?,?)')
    .run(result.matchId, result.accountId, result.resultHash, JSON.stringify(result));
  assert.throws(() => prepareRankingDay(input), /evidence/);
  assert.throws(() => prepareRankingDay({ ...input, now: day - 1 }), /still open/);
  const metric = { ...result, source: 'authoritative-simulation', rulesVersion: rubric.version,
    signals: { durationMs: 60000, activeMs: 60000, difficulty: 'normal', left: false,
      bossDamage: 100, bossMaxHp: 600, allyHealing: 300, allyBlocked: 300, shieldBreaks: 3 } };
  metric.metricsHash = rankingMetricsHash(metric);
  database.prepare('INSERT INTO near_result_metrics VALUES (?,?,?,?)')
    .run(metric.matchId, metric.accountId, metric.metricsHash, JSON.stringify(metric));
  const saved = prepareRankingDay(input);
  assert.equal(saved.draft.allocations[0].accountId, 'player.testnet');
  assert.equal(saved.draft.allocations[0].scoreAtomic, '333333');
  assert.deepEqual(prepareRankingDay(input).draft, saved.draft);
  assert.throws(() => prepareRankingDay({ ...input, rubric: { ...rubric, reviewStatus: 'pending' } }), /disabled/);
});
