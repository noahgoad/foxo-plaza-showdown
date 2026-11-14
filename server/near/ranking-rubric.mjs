import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resultsFromSimulation } from './result-adapter.mjs';

const defaults = JSON.parse(readFileSync(new URL('../../config/ranking-rubrics.testnet.json', import.meta.url)));
const modes = ['hunt', 'boss', 'control', 'trials'];
const validInt = n => Number.isSafeInteger(n) && n >= 0 && n <= 3_600_000_000;
const integer = n => Number.isFinite(n) && n >= 0 && n <= 3_600_000_000 ? Math.floor(n) : null;
const milliseconds = n => integer(Number.isFinite(n) ? n * 1000 : null);

export function rankingMetricsHash({ matchId, accountId, mode, source, rulesVersion, resultHash, signals }) {
  return createHash('sha256').update(JSON.stringify({
    matchId, accountId, mode, source, rulesVersion, resultHash, signals,
  })).digest('hex');
}

function rubricFor(mode, config) {
  const rubric = config?.modes?.[mode];
  if (!modes.includes(mode) || !rubric || rubric.bestOf !== (mode === 'trials' ? 1 : 3) ||
      config.scoreScaleAtomic !== '1000000' || !Array.isArray(rubric.required) ||
      !Array.isArray(rubric.components) || rubric.components.reduce((n, c) => n + c.weightBps, 0) !== 10000 ||
      rubric.components.some(c => !Number.isSafeInteger(c.weightBps) || c.weightBps < 0 ||
        !(validInt(c.target) && c.target > 0 || typeof c.targetField === 'string' && validInt(c.targetDivisor) && c.targetDivisor > 0))) {
    throw new Error('Invalid preview ranking rubric');
  }
  return rubric;
}

function missingSignals(rubric, signals) {
  return rubric.required.filter(key => key === 'difficulty' ? !['easy', 'normal', 'hard'].includes(signals[key]) :
    ['left', 'standardizedKit'].includes(key) ? typeof signals[key] !== 'boolean' : !validInt(signals[key]));
}

/** Review helper only. This function accepts hypothetical fixtures, never proves
 * provenance and never issues funded ranking entitlements or enables a mode. */
export function previewRankingScore(mode, signals, config = defaults) {
  const rubric = rubricFor(mode, config);
  const missing = missingSignals(rubric, signals ?? {});
  const base = { mode, rulesVersion: config.version, enabled: false, scoreAtomic: '0', missing };
  if (missing.length) return { ...base, status: 'missing_signals' };
  if (signals.durationMs <= 0 || signals.activeMs > signals.durationMs ||
      mode === 'trials' && (signals.objectiveProgress > 8 || signals.remainingMs > signals.challengeDurationMs)) {
    return { ...base, status: 'invalid_signals' };
  }
  // Trials measure beacon hold time; the rest of the run is traversal.
  const activityTarget = rubric.objectiveActiveTargetMs ?? signals.durationMs;
  if (!validInt(activityTarget) || activityTarget < 1) throw new Error('Invalid activity target');
  const activity = BigInt(signals.activeMs) * 10000n / BigInt(Math.min(signals.durationMs, activityTarget));
  const difficulty = config.difficultyBps?.[signals.difficulty];
  if (!validInt(difficulty) || difficulty > 10000 || !validInt(config.activityMinimumBps) ||
      !validInt(config.fullActivityBps) || config.fullActivityBps <= 0 || config.fullActivityBps > 10000 ||
      config.activityMinimumBps > config.fullActivityBps || !validInt(config.maxOpponentMeetings)) throw new Error('Invalid ranking gates');
  if (signals.left || difficulty === 0 || activity < BigInt(config.activityMinimumBps) ||
      ['hunt', 'control'].includes(mode) && (signals.humanOpponentCount < 1 || signals.maxOpponentMeetings > config.maxOpponentMeetings) ||
      mode === 'trials' && !signals.standardizedKit) return { ...base, status: 'preview', reason: 'ineligible' };
  let weighted = 0n;
  for (const c of rubric.components) {
    const target = c.target ?? Math.floor(signals[c.targetField] / c.targetDivisor);
    if (!validInt(target) || target < 1 || !validInt(signals[c.field])) return { ...base, status: 'invalid_signals' };
    const value = c.requiresCompleted && signals.objectiveProgress !== 8 ? 0 : Math.min(signals[c.field], target);
    weighted += BigInt(value) * 1000000n * BigInt(c.weightBps) / BigInt(target);
  }
  const activeFactor = activity > BigInt(config.fullActivityBps) ? BigInt(config.fullActivityBps) : activity;
  const score = weighted / 10000n * activeFactor / BigInt(config.fullActivityBps) * BigInt(difficulty) / 10000n;
  return { ...base, status: 'preview', scoreAtomic: score.toString() };
}

/** Fixed divisor makes best three a daily contribution total normalized to one. */
export function aggregateRankingPreviews(mode, rows, config = defaults) {
  const rubric = rubricFor(mode, config);
  if (!Array.isArray(rows)) throw new TypeError('Expected ranking previews');
  const seen = new Set();
  const scores = rows.map(row => {
    if (row.mode !== mode) throw new Error('Cross-mode preview forbidden');
    if (row.matchId !== undefined) {
      if (typeof row.matchId !== 'string' || !row.matchId || seen.has(row.matchId)) throw new Error('Duplicate or invalid preview match');
      seen.add(row.matchId);
    }
    if (row.status !== 'preview' || !/^(0|[1-9][0-9]{0,6})$/.test(row.scoreAtomic ?? '') || BigInt(row.scoreAtomic) > 1000000n) throw new Error('Invalid preview score');
    return BigInt(row.scoreAtomic);
  }).sort((a, b) => a > b ? -1 : a < b ? 1 : 0).slice(0, rubric.bestOf);
  return { mode, status: 'preview', enabled: false, selectedScores: scores.map(String),
    scoreAtomic: (scores.reduce((a, b) => a + b, 0n) / BigInt(rubric.bestOf)).toString() };
}

/** Call only on the trusted simulation-runner path. Missing raw telemetry is
 * explicit: XP, client damage, win flags and team totals are never substitutes. */
export function rankingMetricsFromSimulation(room, snapshot, finishedAt, config = defaults, resultOptions = {}) {
  if (!Number.isSafeInteger(finishedAt) || finishedAt <= 0) throw new Error('Invalid ranking finish time');
  const results = resultsFromSimulation(room, snapshot, finishedAt, resultOptions);
  const final = snapshot.core.result;
  const roster = room.roster.filter(p => p.nearWallet && !p.bot);
  return results.map((result, index) => {
    const player = roster[index];
    const row = final.players.find(p => p.id === 'hunt-' + player.nid);
    const t = row.rankingTelemetry?.version === 1 ? row.rankingTelemetry : {};
    const signals = { durationMs: integer(final.rankingDurationMs), activeMs: integer(t.activeMs),
      difficulty: room.config.difficulty ?? null, left: row.left };
    if (result.mode === 'hunt') {
      for (const key of ['captures', 'traits', 'supplies', 'stuns']) signals[key] = integer(row.activity?.[key] ?? 0);
    } else if (result.mode === 'boss') {
      Object.assign(signals, { bossDamage: integer(row.raidStats?.damage), bossMaxHp: integer(final.boss?.maxHp),
        allyHealing: integer(t.allyHealing), allyBlocked: integer(t.allyBlocked), shieldBreaks: integer(row.raidStats?.breaks) });
    } else if (result.mode === 'control') {
      for (const key of ['captureMs', 'contestMs', 'defenseMs']) signals[key] = integer(t[key]);
    } else {
      Object.assign(signals, { objectiveProgress: integer(final.objectiveProgress), remainingMs: milliseconds(final.time),
        challengeDurationMs: milliseconds(final.challenge?.duration),
        standardizedKit: typeof t.standardizedKit === 'boolean' ? t.standardizedKit : null });
    }
    if (['hunt', 'control'].includes(result.mode)) {
      const encounters = resultOptions.opponents?.get(result.accountId);
      signals.humanOpponentCount = integer(encounters?.humanOpponentCount);
      signals.maxOpponentMeetings = integer(encounters?.maxOpponentMeetings);
    }
    const missing = missingSignals(rubricFor(result.mode, config), signals);
    const evidence = { matchId: result.matchId, accountId: result.accountId, mode: result.mode,
      source: 'authoritative-simulation', rulesVersion: config.version, resultHash: result.resultHash,
      signals };
    // A separate digest preserves legacy practice hashes while binding ranking
    // telemetry. Persist this envelope separately before any daily draft review.
    const metricsHash = rankingMetricsHash(evidence);
    return { ...evidence, metricsHash, finishedAt, missing, ready: missing.length === 0, enabled: false };
  });
}
