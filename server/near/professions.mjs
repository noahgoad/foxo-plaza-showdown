import { createHash } from 'node:crypto';
import { rankingMetricsHash } from './ranking-rubric.mjs';

export function professionEvidence(result, signals) {
  if (!['boss', 'trials'].includes(result.mode) ||
      result.rulesVersion !== 'near-authoritative-' + result.mode + '-1' ||
      result.left !== false || signals?.left !== false ||
      !Number.isSafeInteger(signals.durationMs) || signals.durationMs < 1 ||
      !Number.isSafeInteger(signals.activeMs) || signals.activeMs > signals.durationMs ||
      signals.activeMs < (result.mode === 'trials' ? 12_000 : Math.ceil(signals.durationMs / 5))) return null;
  if (result.won && result.mode === 'boss' && signals.bossDamage > 0) return 'boss_clear';
  if (result.won && result.mode === 'trials' && signals.objectiveProgress === 8) return 'trial_clear';
  return 'match';
}

export function createProfessionService({ database, view, prepare, broadcast, verifyDeployment }) {
  const candidates = database.prepare(`SELECT r.match_id,r.account_id,r.payload,r.result_hash,
    m.payload AS metric,m.metrics_hash FROM near_results r JOIN near_result_metrics m USING(match_id,account_id)
    WHERE json_extract(r.payload,'$.rulesVersion') IN ('near-authoritative-boss-1','near-authoritative-trials-1')
    ORDER BY r.match_id,r.account_id`);
  return { async tick({ onError }) {
    const accounts = new Map();
    for (const row of candidates.iterate()) {
      const { resultHash, finishedAt, ...result } = JSON.parse(row.payload);
      const metric = JSON.parse(row.metric);
      const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
      if (digest !== resultHash || digest !== row.result_hash || metric.resultHash !== digest ||
          metric.matchId !== row.match_id || result.matchId !== row.match_id ||
          metric.accountId !== row.account_id || result.accountId !== row.account_id ||
          metric.mode !== result.mode || metric.finishedAt !== finishedAt ||
          metric.source !== 'authoritative-simulation' || metric.metricsHash !== row.metrics_hash ||
          rankingMetricsHash(metric) !== row.metrics_hash) continue;
      const kind = professionEvidence(result, metric.signals);
      if (!kind) continue;
      const matches = accounts.get(row.account_id) ?? [];
      matches.push({ match_id: row.match_id, kind });
      accounts.set(row.account_id, matches);
    }
    if (!accounts.size || !await verifyDeployment()) return;
    for (const [account_id, matches] of accounts) {
      try {
        const progress = await view('get_profession_progress', { account_id });
        if (progress.matches >= 3 && progress.boss && progress.trial) continue;
        const eligible = matches.filter(match => !progress.matchIds.includes(match.match_id));
        const selected = new Map();
        for (const kind of ['boss_clear', 'trial_clear']) {
          if (kind === 'boss_clear' ? progress.boss : progress.trial) continue;
          const match = eligible.find(entry => entry.kind === kind);
          if (match) selected.set(match.match_id, match);
        }
        for (const match of eligible) {
          if (progress.matches + selected.size >= 3) break;
          selected.set(match.match_id, match);
        }
        if (selected.size) await broadcast(await prepare({ method: 'record_profession_matches',
          args: { account_id, matches: [...selected.values()] } }));
      } catch (error) { onError(error); }
    }
  } };
}
