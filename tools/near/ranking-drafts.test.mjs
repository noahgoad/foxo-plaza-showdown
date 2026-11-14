import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRankingDrafts } from '../../server/near/ranking.mjs';

const config = JSON.parse(readFileSync(new URL('../../config/economy.testnet.json', import.meta.url)));
const day = 86_400_000;
const request = { campaignId: 'season-1', seasonStartMs: 0, mode: 'boss', dayIndex: 0,
  rubricVersion: 'fixture-1', evidenceHash: 'a'.repeat(64), entries: [
    { accountId: 'bob.testnet', scoreAtomic: '300000' },
    { accountId: 'alice.testnet', scoreAtomic: '500000' },
  ] };

test('ranking draft waits for day close, persists across recreation and rejects conflicting retries', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const active = structuredClone(config);
    active.ranking.enabledModes = ['boss'];
    let time = day - 1;
    const open = () => createRankingDrafts({ database, config: active, now: () => time });
    assert.throws(() => open().prepare(request), /still open/);
    time += 1;
    const saved = open().prepare(request);
    assert.equal(saved.reviewAfterMs, 2 * day);
    time += 1;
    assert.deepEqual(open().prepare({ ...request, entries: [...request.entries].reverse() }), saved);
    assert.throws(() => open().prepare({ ...request, evidenceHash: 'b'.repeat(64) }), /conflicts/);
    const key = { campaignId: request.campaignId, mode: request.mode, budgetDay: '1970-01-01' };
    assert.equal(open().forReview(key).reviewElapsed, false);
    time = 2 * day;
    assert.equal(open().forReview(key).reviewElapsed, true);
    assert.equal(open().forReview(key).hash, saved.hash);
  } finally {
    database.close();
  }
});

test('inactive modes cannot write ranking drafts', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const inactive = { ...config, ranking: { ...config.ranking, enabledModes: [] } };
    const store = createRankingDrafts({ database, config: inactive, now: () => day });
    assert.throws(() => store.prepare(request), /disabled/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM near_ranking_drafts').get().count, 0);
  } finally {
    database.close();
  }
});
