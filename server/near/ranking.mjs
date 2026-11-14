import { createHash } from 'node:crypto';
import { createPilotPolicy } from '../../src/economy/policy.js';

const DAY_MS = 86_400_000;

export function createRankingDrafts({ database, config, now = Date.now }) {
  const policy = createPilotPolicy(config);
  const reviewMs = config.ranking.reviewHours * 3_600_000;
  if (!Number.isSafeInteger(reviewMs) || reviewMs < 24 * 3_600_000) {
    throw new RangeError('Invalid ranking review duration');
  }
  database.exec(`CREATE TABLE IF NOT EXISTS near_ranking_drafts (
    campaign_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    budget_day TEXT NOT NULL,
    draft_hash TEXT NOT NULL,
    review_after_ms INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (campaign_id, mode, budget_day)
  )`);
  const find = database.prepare(`SELECT draft_hash AS hash, review_after_ms AS reviewAfterMs, payload
    FROM near_ranking_drafts WHERE campaign_id = ? AND mode = ? AND budget_day = ?`);
  const insert = database.prepare(`INSERT INTO near_ranking_drafts VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(campaign_id, mode, budget_day) DO NOTHING`);

  return {
    forSubmission({ campaignId, mode, budgetDay }) {
      const row = find.get(campaignId, mode, budgetDay);
      return row ? { hash: row.hash, reviewAfterMs: row.reviewAfterMs,
        draftJson: row.payload, draft: JSON.parse(row.payload) } : null;
    },
    prepare({ campaignId, seasonStartMs, mode, dayIndex, rubricVersion, evidenceHash, entries }) {
      if (![campaignId, rubricVersion].every(value => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value)) ||
          typeof evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceHash)) {
        throw new TypeError('Invalid ranking draft provenance');
      }
      if (!Number.isSafeInteger(dayIndex) || dayIndex < 0 || dayIndex >= config.pilot.seasonDays) {
        throw new RangeError('Invalid ranking day');
      }
      const startsAt = seasonStartMs + dayIndex * DAY_MS;
      const window = policy.windowAt(startsAt, seasonStartMs);
      const time = now();
      if (!Number.isSafeInteger(time) || !window || time < startsAt + DAY_MS) {
        throw new Error('Ranking day is still open');
      }
      const draft = policy.draftRanking({ mode, dayIndex, entries });
      draft.allocations.sort((a, b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0);
      const payload = JSON.stringify({ version: 1, campaignId, seasonStartMs, budgetDay: window.budgetDay,
        rubricVersion, evidenceHash, ...draft });
      const hash = createHash('sha256').update('fox-ranking-draft/v1\0').update(payload).digest('hex');
      const reviewAfterMs = time + reviewMs;
      if (!Number.isSafeInteger(reviewAfterMs)) throw new RangeError('Invalid ranking review timestamp');
      insert.run(campaignId, mode, window.budgetDay, hash, reviewAfterMs, payload);
      const stored = find.get(campaignId, mode, window.budgetDay);
      if (stored.hash !== hash) throw new Error('Ranking draft conflicts with the stored version');
      return { hash, reviewAfterMs: stored.reviewAfterMs, draft: JSON.parse(stored.payload) };
    },
    forReview({ campaignId, mode, budgetDay }) {
      const row = find.get(campaignId, mode, budgetDay);
      if (!row) return null;
      return { hash: row.hash, reviewAfterMs: row.reviewAfterMs, reviewElapsed: now() >= row.reviewAfterMs,
        draft: JSON.parse(row.payload) };
    },
  };
}
