import { atomic, accountId, FOXO_SCALE, MAX_ATOMIC } from './schema.js';

export const RANKING_MODES = Object.freeze(['hunt', 'boss', 'control', 'trials']);
export const PILOT_RANKING_RULES = Object.freeze({ seasonDays: 28, modeBudgetAtomic: (1000n * FOXO_SCALE).toString(), capAtomic: (625n * FOXO_SCALE / 100n).toString(), scoreScaleAtomic: '1000000' });

function amount(value) {
  // Public financial APIs accept only canonical atomic strings or BigInt.
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_ATOMIC) throw new RangeError('Atomic amount exceeds u128');
    return value;
  }
  return atomic(value);
}

function modeId(mode) {
  if (!RANKING_MODES.includes(mode)) throw new RangeError('Unknown ranking mode');
  return mode;
}

function scaleValue(value) {
  const scale = amount(value);
  if (scale === 0n) throw new RangeError('Score scale must be positive');
  return scale;
}

function normalized(value, scale) {
  const score = amount(value);
  if (score > scale) throw new RangeError('Normalized score exceeds one');
  return score;
}

/** The first remainder days receive one additional atomic unit. */
export function dailyRankingBudget(dayIndex, { modeBudgetAtomic = PILOT_RANKING_RULES.modeBudgetAtomic, seasonDays = PILOT_RANKING_RULES.seasonDays } = {}) {
  if (!Number.isSafeInteger(seasonDays) || seasonDays < 1 || !Number.isSafeInteger(dayIndex) || dayIndex < 0 || dayIndex >= seasonDays) throw new RangeError('Invalid ranking day');
  const budget = amount(modeBudgetAtomic);
  const days = BigInt(seasonDays);
  return (budget / days + (BigInt(dayIndex) < budget % days ? 1n : 0n)).toString();
}

/** s is a fixed-point score in [0, scale]. Intermediate products remain BigInt. */
export function rankingAwardForScore({ budgetAtomic, capAtomic, scoreAtomic, totalScoreAtomic, scoreScaleAtomic = PILOT_RANKING_RULES.scoreScaleAtomic }) {
  const budget = amount(budgetAtomic);
  const cap = amount(capAtomic);
  const scale = scaleValue(scoreScaleAtomic);
  const score = normalized(scoreAtomic, scale);
  const total = amount(totalScoreAtomic);
  if (total < score) throw new RangeError('Total score is smaller than account score');
  const denominator = total > 10n * scale ? total : 10n * scale;
  const share = budget * score / denominator;
  return (share > cap ? cap : share).toString();
}

/** Selection only: a versioned mode rubric must normalize the selected results.
 * This helper deliberately does not invent a common cross-mode scoring rubric.
 */
export function bestRankingScores(mode, scores, { scoreScaleAtomic = PILOT_RANKING_RULES.scoreScaleAtomic } = {}) {
  modeId(mode);
  const scale = scaleValue(scoreScaleAtomic);
  if (!Array.isArray(scores)) throw new TypeError('Expected score array');
  return scores.map(score => normalized(score, scale)).sort((a, b) => a === b ? 0 : a > b ? -1 : 1).slice(0, mode === 'trials' ? 1 : 3).map(String);
}

/** Pure draft allocation; no entitlement exists until reviewed/funded finalization.
 * entries contain one rubric-normalized score per account for this mode/day.
 */
export function allocateModeRanking({ mode, dayIndex, entries, modeBudgetAtomic = PILOT_RANKING_RULES.modeBudgetAtomic, capAtomic = PILOT_RANKING_RULES.capAtomic, scoreScaleAtomic = PILOT_RANKING_RULES.scoreScaleAtomic, seasonDays = PILOT_RANKING_RULES.seasonDays }) {
  modeId(mode);
  if (!Array.isArray(entries)) throw new TypeError('Expected ranking entries');
  const budgetAtomic = dailyRankingBudget(dayIndex, { modeBudgetAtomic, seasonDays });
  const scale = scaleValue(scoreScaleAtomic);
  amount(capAtomic);
  const seen = new Set();
  let total = 0n;
  const checked = entries.map(entry => {
    const id = accountId(entry.accountId);
    if (entry.mode !== undefined && entry.mode !== mode) throw new RangeError('Cross-mode allocation forbidden');
    if (entry.dayIndex !== undefined && entry.dayIndex !== dayIndex) throw new RangeError('Cross-day allocation forbidden');
    if (seen.has(id)) throw new RangeError('Duplicate ranking account');
    seen.add(id);
    const score = normalized(entry.scoreAtomic, scale);
    total += score;
    if (total > MAX_ATOMIC) throw new RangeError('Total score exceeds u128');
    return { accountId: id, scoreAtomic: score.toString() };
  });
  let awarded = 0n;
  const allocations = checked.map(entry => {
    const amountAtomic = rankingAwardForScore({ budgetAtomic, capAtomic, scoreAtomic: entry.scoreAtomic, totalScoreAtomic: total, scoreScaleAtomic: scale });
    awarded += BigInt(amountAtomic);
    return { ...entry, amountAtomic };
  });
  return { mode, dayIndex, budgetAtomic, totalScoreAtomic: total.toString(), allocations, awardedAtomic: awarded.toString(), unallocatedAtomic: (BigInt(budgetAtomic) - awarded).toString() };
}
