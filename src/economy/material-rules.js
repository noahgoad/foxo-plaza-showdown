const DAILY_ALLOY = 12;
const DAILY_CORE = 2;
const DAILY_CATALYST = 1;

function boundedCount(count, cap) {
  if (!Number.isSafeInteger(count) || count < 0 || count > cap) {
    throw new RangeError('Invalid material quota');
  }
  return count;
}

// Only call this after the campaign has accepted the server result.
export function materialAward(result, earnedToday, weeklyChoice = null) {
  const spent = {
    alloy: boundedCount(earnedToday.alloy, DAILY_ALLOY),
    core: boundedCount(earnedToday.core, DAILY_CORE),
    catalyst: boundedCount(earnedToday.catalyst, DAILY_CATALYST),
  };
  const grant = { alloy: 0, core: 0, catalyst: 0 };
  if (!result.eligible || result.left) return grant;
  if (['hunt', 'control', 'boss', 'trials'].includes(result.mode)) {
    grant.alloy = Math.min(4, DAILY_ALLOY - spent.alloy);
  }
  if (result.mode === 'boss' && result.won) grant.core = Math.min(1, DAILY_CORE - spent.core);
  if (result.mode === 'trials' && result.bronze) {
    grant.catalyst = Math.min(1, DAILY_CATALYST - spent.catalyst);
  }
  if (weeklyChoice === 'core' && grant.core === 0) grant.core = Math.min(1, DAILY_CORE - spent.core);
  if (weeklyChoice === 'catalyst' && grant.catalyst === 0) {
    grant.catalyst = Math.min(1, DAILY_CATALYST - spent.catalyst);
  }
  return grant;
}
