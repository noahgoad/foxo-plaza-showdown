// Slot counts and timestamps are safe integers; token amounts never use Number.
export const PILOT_REWARD_WINDOWS = Object.freeze({ seasonDays: 28, windowsPerDay: 6, baseSlotsPerWindow: 19, extraSlotDays: 8 });
const DAY_MS = 86400000;

function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid ${name}`);
  return value;
}

function settings(options) {
  const rules = { ...PILOT_REWARD_WINDOWS, ...options };
  integer(rules.seasonDays, 'seasonDays', 1);
  integer(rules.windowsPerDay, 'windowsPerDay', 1, 24);
  if (24 % rules.windowsPerDay !== 0) throw new RangeError('Windows must divide a UTC day');
  integer(rules.baseSlotsPerWindow, 'baseSlotsPerWindow');
  integer(rules.extraSlotDays, 'extraSlotDays', 0, rules.seasonDays);
  integer(rules.baseSlotsPerWindow * rules.windowsPerDay + 1, 'daily slots');
  return rules;
}

export function slotsForDay(dayIndex, options = {}) {
  const rules = settings(options);
  integer(dayIndex, 'dayIndex', 0, rules.seasonDays - 1);
  const slots = Array(rules.windowsPerDay).fill(rules.baseSlotsPerWindow);
  if (dayIndex < rules.extraSlotDays) slots[dayIndex % rules.windowsPerDay]++;
  return slots;
}

/** Half-open UTC windows. No slot carry crosses the campaign's budgetDay. */
export function rewardWindowAt(timestampMs, { seasonStartMs, ...options } = {}) {
  const rules = settings(options);
  integer(timestampMs, 'timestampMs');
  integer(seasonStartMs, 'seasonStartMs');
  if (seasonStartMs % DAY_MS !== 0) throw new RangeError('Season must start at UTC midnight');
  const seasonEndMs = seasonStartMs + rules.seasonDays * DAY_MS;
  integer(seasonEndMs, 'seasonEndMs', 0, 8640000000000000);
  if (timestampMs < seasonStartMs || timestampMs >= seasonEndMs) return null;
  const dayIndex = Math.floor((timestampMs - seasonStartMs) / DAY_MS);
  const windowMs = DAY_MS / rules.windowsPerDay;
  const windowIndex = Math.floor((timestampMs - seasonStartMs - dayIndex * DAY_MS) / windowMs);
  const startMs = seasonStartMs + dayIndex * DAY_MS + windowIndex * windowMs;
  return { dayIndex, windowIndex, budgetDay: new Date(startMs).toISOString().slice(0, 10), startMs, endMs: startMs + windowMs };
}

/** reservedByWindow counts active or consumed slots issued in each window.
 * Released/cancelled reservations must be removed by the authoritative ledger.
 */
export function availableWindowSlots({ dayIndex, windowIndex, reservedByWindow }, options = {}) {
  const slots = slotsForDay(dayIndex, options);
  integer(windowIndex, 'windowIndex', 0, slots.length - 1);
  if (!Array.isArray(reservedByWindow) || reservedByWindow.length !== slots.length) throw new TypeError('Expected one reservation count per window');
  let available = 0;
  for (let i = 0; i < slots.length; i++) {
    integer(reservedByWindow[i], 'reservation count');
    if (i > windowIndex) {
      if (reservedByWindow[i] !== 0) throw new RangeError('Cannot reserve an unopened window');
    } else {
      available += slots[i] - reservedByWindow[i];
      if (available < 0) throw new RangeError('Reservations exceed opened slots');
    }
  }
  return available;
}
