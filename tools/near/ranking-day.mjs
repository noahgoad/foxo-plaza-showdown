import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createRankingDrafts } from '../../server/near/ranking.mjs';
import { prepareRankingDay } from '../../server/near/ranking-daily.mjs';
import { previewRankingScore, rankingMetricsHash } from '../../server/near/ranking-rubric.mjs';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: {
  db: { type: 'string', default: 'outputs/near-economy.sqlite' },
  campaign: { type: 'string' },
  'season-start': { type: 'string' },
  day: { type: 'string' },
  mode: { type: 'string' },
  audit: { type: 'boolean', default: false },
} });
const configFile = name => readFile(new URL('../../config/' + name, import.meta.url), 'utf8').then(JSON.parse);
const [config, rubric] = await Promise.all([configFile('economy.testnet.json'), configFile('ranking-rubrics.testnet.json')]);
if (values.audit) {
  const database = new DatabaseSync(values.db, { readOnly: true });
  try {
    const totals = Object.fromEntries(Object.keys(rubric.modes).map(mode => [mode,
      { results: 0, missing: 0, invalid: 0, ineligible: 0, scored: 0 }]));
    const rows = database.prepare(`SELECT r.match_id, r.account_id, r.payload, r.result_hash, m.payload AS metric, m.metrics_hash
      FROM near_results r LEFT JOIN near_result_metrics m USING(match_id,account_id)`);
    for (const row of rows.iterate()) {
      const result = JSON.parse(row.payload);
      const total = Object.hasOwn(totals, result.mode) ? totals[result.mode] : null;
      if (!total) continue;
      total.results++;
      const metric = row.metric && JSON.parse(row.metric);
      if (!metric || metric.source !== 'authoritative-simulation' || metric.rulesVersion !== rubric.version ||
          metric.mode !== result.mode) {
        total.missing++;
        continue;
      }
      const { resultHash, finishedAt, ...record } = result;
      if (record.matchId !== row.match_id || record.accountId !== row.account_id ||
          metric.matchId !== row.match_id || metric.accountId !== row.account_id || metric.finishedAt !== finishedAt ||
          metric.resultHash !== resultHash || resultHash !== row.result_hash ||
          createHash('sha256').update(JSON.stringify(record)).digest('hex') !== resultHash ||
          metric.metricsHash !== row.metrics_hash || rankingMetricsHash(metric) !== row.metrics_hash) {
        total.invalid++;
        continue;
      }
      const score = previewRankingScore(result.mode, metric.signals, rubric);
      if (score.status === 'missing_signals') total.missing++;
      else if (score.status === 'invalid_signals') total.invalid++;
      else if (score.reason === 'ineligible') total.ineligible++;
      else total.scored++;
    }
    console.log(JSON.stringify({ status: 'PREVIEW_AUDIT', rubricVersion: rubric.version,
      reviewStatus: rubric.reviewStatus, totals }, null, 2));
  } finally {
    database.close();
  }
  process.exit(0);
}
if (!values.campaign || !values.mode || !values.day || !values['season-start']) {
  throw new Error('Use --campaign <id> --mode <mode> --season-start <UTC timestamp> --day <0–27>.');
}
if (!config.ranking.enabledModes.includes(values.mode) || !rubric.enabledModes.includes(values.mode)) {
  throw new Error('Ranking mode is disabled');
}
const database = new DatabaseSync(values.db);
try {
  const saved = prepareRankingDay({ database, config, rubric, drafts: createRankingDrafts({ database, config }),
    campaignId: values.campaign, mode: values.mode, seasonStartMs: Date.parse(values['season-start']),
    dayIndex: Number(values.day) });
  if (!saved) {
    console.log(JSON.stringify({ status: 'NO_ELIGIBLE_SCORES' }));
  } else console.log(JSON.stringify({ status: 'LOCAL_DRAFT', ...saved,
    proposal: { method: 'propose_ranking_draft', args: { draft_json: JSON.stringify(saved.draft), draft_hash: saved.hash } } }, null, 2));
} finally {
  database.close();
}
