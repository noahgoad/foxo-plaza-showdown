import { atomic, FOXO_SCALE } from './schema.js';
import { availableWindowSlots, rewardWindowAt, slotsForDay } from './reward-windows.js';
import { allocateModeRanking, RANKING_MODES } from './ranking-rules.js';

export function foxoAtomic(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,24})?$/.test(value)) {
    throw new TypeError('Invalid FOXO amount');
  }
  const [whole, fraction = ''] = value.split('.');
  return atomic((BigInt(whole) * FOXO_SCALE + BigInt(fraction.padEnd(24, '0'))).toString());
}

export function createPilotPolicy(config) {
  const { pilot, rewardWindows, ranking } = config;
  const windows = { ...rewardWindows, seasonDays: pilot.seasonDays };
  if (windows.windowHours * windows.windowsPerDay !== 24 || ranking.targetNormalizedScore !== 10) {
    throw new RangeError('Unsupported pilot window or ranking target');
  }
  const fixedAward = foxoAtomic(pilot.fixedAwardFoxo);
  const seasonBudget = foxoAtomic(pilot.seasonBudgetFoxo);
  const slots = Array.from({ length: pilot.seasonDays }, (_, day) => slotsForDay(day, windows))
    .flat().reduce((total, count) => total + BigInt(count), 0n);
  const modeBudgets = Object.fromEntries(RANKING_MODES.map(mode => [mode, foxoAtomic(ranking.modeBudgetsFoxo[mode])]));
  const rankingBudget = Object.values(modeBudgets).reduce((total, budget) => total + budget, 0n);
  if (pilot.fixedBps + pilot.rankingBps !== 10_000 ||
      slots * fixedAward * 10_000n !== seasonBudget * BigInt(pilot.fixedBps) ||
      rankingBudget * 10_000n !== seasonBudget * BigInt(pilot.rankingBps)) {
    throw new RangeError('Pilot allocation does not match season budget');
  }
  const capAtomic = foxoAtomic(ranking.dailyCapPerModeFoxo);
  const enabledModes = new Set(ranking.enabledModes);
  if ([...enabledModes].some(mode => !RANKING_MODES.includes(mode))) throw new RangeError('Unknown ranking mode');
  return {
    fixedAwardAtomic: fixedAward.toString(),
    windowAt: (timestampMs, seasonStartMs) => rewardWindowAt(timestampMs, { ...windows, seasonStartMs }),
    availableSlots: counts => availableWindowSlots(counts, windows),
    draftRanking({ mode, dayIndex, entries }) {
      if (!enabledModes.has(mode)) throw new Error('Ranking mode is disabled');
      return allocateModeRanking({ mode, dayIndex, entries, modeBudgetAtomic: modeBudgets[mode],
        capAtomic, seasonDays: pilot.seasonDays });
    },
  };
}

export function rankingAward({ budgetAtomic, capAtomic, score, totalScore, targetScore }) {
  if (![score, totalScore, targetScore].every(Number.isSafeInteger) ||
      score < 0 || totalScore < score || targetScore <= 0) {
    throw new RangeError('Invalid ranking totals');
  }
  const budget = atomic(budgetAtomic);
  const cap = atomic(capAtomic);
  const share = budget * BigInt(score) / BigInt(Math.max(totalScore, targetScore));
  return (share > cap ? cap : share).toString();
}
