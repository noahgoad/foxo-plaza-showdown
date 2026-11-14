import { createHash } from 'node:crypto';
import { aggregateRankingPreviews, previewRankingScore, rankingMetricsHash } from './ranking-rubric.mjs';

const dayMs = 86_400_000;

/** The operator runs this after the UTC day closes and approves the frozen draft separately. */
export function prepareRankingDay({ database, drafts, config, rubric, campaignId, seasonStartMs,
  mode, dayIndex, now = Date.now() }) {
  if (!config.ranking.enabledModes.includes(mode) || !rubric.enabledModes.includes(mode) ||
      rubric.reviewStatus !== 'approved') throw new Error('Ranking mode or rubric is disabled');
  if (!Number.isSafeInteger(seasonStartMs) || seasonStartMs < 0 || seasonStartMs % dayMs ||
      !Number.isSafeInteger(dayIndex) || dayIndex < 0 || dayIndex >= config.pilot.seasonDays) {
    throw new Error('Invalid ranking UTC day');
  }
  const from = seasonStartMs + dayIndex * dayMs, until = from + dayMs;
  if (!Number.isSafeInteger(until) || now < until) throw new Error('Ranking UTC day is still open');
  const { evidenceHash, entries } = readRankingDay({ database, rubric, campaignId, mode, dayIndex, from, until });
  if (!entries.length) return null;
  return drafts.prepare({ campaignId, seasonStartMs, mode, dayIndex, rubricVersion: rubric.version,
    evidenceHash, entries });
}

export function readRankingDay({ database, rubric, campaignId, mode, dayIndex, from, until, strict = true, includeMatches = false }) {
  const results = database.prepare(`SELECT r.match_id, r.account_id, r.result_hash, r.payload,
      m.metrics_hash, m.payload AS metric
    FROM near_results r LEFT JOIN near_result_metrics m USING(match_id,account_id)
    WHERE json_extract(r.payload, '$.mode') = ?
      AND json_extract(r.payload, '$.finishedAt') >= ?
      AND json_extract(r.payload, '$.finishedAt') < ?
    ORDER BY r.match_id, r.account_id`).all(mode, from, until);
  const players = new Map();
  let unscored = 0;
  const evidence = createHash('sha256').update(JSON.stringify({ campaignId, mode, dayIndex, rubricVersion: rubric.version }));
  for (const row of results) {
    const { resultHash, finishedAt, ...result } = JSON.parse(row.payload);
    const metric = row.metric && JSON.parse(row.metric);
    if (!metric || metric.source !== 'authoritative-simulation' || metric.rulesVersion !== rubric.version ||
        metric.matchId !== row.match_id || metric.accountId !== row.account_id || metric.mode !== mode ||
        metric.finishedAt !== finishedAt || result.matchId !== metric.matchId ||
        result.accountId !== metric.accountId || result.left !== metric.signals?.left ||
        metric.resultHash !== row.result_hash || resultHash !== row.result_hash ||
        createHash('sha256').update(JSON.stringify(result)).digest('hex') !== resultHash ||
        metric.metricsHash !== row.metrics_hash || rankingMetricsHash(metric) !== row.metrics_hash) {
      if (strict) throw new Error('Missing or conflicting authoritative ranking evidence');
      unscored++;
      continue;
    }
    const signals = metric.signals;
    const activityTarget = Math.min(signals?.durationMs, rubric.modes[mode].objectiveActiveTargetMs ?? signals?.durationMs);
    const belowMinimum = Number.isSafeInteger(signals.durationMs) && signals.durationMs > 0 &&
      Number.isSafeInteger(signals.activeMs) && signals.activeMs >= 0 &&
      BigInt(signals.activeMs) * 10000n < BigInt(activityTarget) * BigInt(rubric.activityMinimumBps);
    evidence.update(JSON.stringify([row.match_id, row.account_id, row.result_hash, row.metrics_hash, finishedAt]));
    if (result.left || belowMinimum) continue;
    const score = previewRankingScore(mode, signals, rubric);
    if (score.status !== 'preview') {
      if (strict) throw new Error('Ranking telemetry is incomplete or invalid');
      unscored++;
      continue;
    }
    const entries = players.get(row.account_id) ?? [];
    entries.push({ ...score, matchId: row.match_id, ...(includeMatches ? { signals } : {}) });
    players.set(row.account_id, entries);
  }
  const entries = [...players].map(([accountId, matches]) => {
    const aggregate = aggregateRankingPreviews(mode, matches, rubric);
    if (!includeMatches) return { accountId, scoreAtomic: aggregate.scoreAtomic };
    const used = matches.sort((a,b) => Number(b.scoreAtomic)-Number(a.scoreAtomic))
      .slice(0,aggregate.selectedScores.length);
    return { accountId, scoreAtomic:aggregate.scoreAtomic,
      breakdown:{rubricVersion:rubric.version, bestOf:rubric.modes[mode].bestOf,
        matches:used.map(({matchId,scoreAtomic,signals})=>({matchId,scoreAtomic,signals}))} };
  }).filter(entry => entry.scoreAtomic !== '0');
  return { evidenceHash: evidence.digest('hex'), entries, unscored };
}
