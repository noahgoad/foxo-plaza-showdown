const DAY_MS = 86_400_000;
const events = new Set(['landing', 'interactive', 'tutorial_started', 'tutorial_completed',
  'match_started', 'match_completed', 'wallet_connected', 'economy_opened', 'share_opened']);
const audiences = new Set(['guest', 'wallet', 'holder']);
const contexts = new Set(['menu', 'practice', 'online', 'demo']);
const modes = new Set(['hunt', 'boss', 'control', 'trials']);

export function createProductTelemetry(database, now = Date.now) {
  database.exec(`CREATE TABLE IF NOT EXISTS foxo_product_events (
    visitor TEXT NOT NULL, event_id TEXT NOT NULL, name TEXT NOT NULL,
    audience TEXT NOT NULL, context TEXT NOT NULL, mode TEXT, recorded_at INTEGER NOT NULL,
    PRIMARY KEY(visitor,event_id)
  );
  CREATE INDEX IF NOT EXISTS foxo_product_event_age ON foxo_product_events(recorded_at)`);
  const insert = database.prepare('INSERT OR IGNORE INTO foxo_product_events VALUES (?,?,?,?,?,?,?)');
  const prune = database.prepare('DELETE FROM foxo_product_events WHERE recorded_at <= ?');
  const quota = database.prepare('SELECT COUNT(*) AS total FROM foxo_product_events WHERE visitor=? AND recorded_at>?');
  let lastPruned = null;
  return {
    record(data) {
      const { visitor, eventId, name, audience, context, mode = null } = data ?? {};
      if (!/^[a-f0-9]{32}$/.test(visitor ?? '') || !/^[a-f0-9]{32}$/.test(eventId ?? '') ||
          !events.has(name) || !audiences.has(audience) || !contexts.has(context) ||
          (mode !== null && !modes.has(mode))) return false;
      const at = now();
      if (lastPruned === null || lastPruned + 3_600_000 <= at) {
        prune.run(at - 30 * DAY_MS);
        lastPruned = at;
      }
      if (quota.get(visitor, at - DAY_MS).total >= 100) return false;
      insert.run(visitor, eventId, name, audience, context, mode, at);
      return true;
    },
    expire() { return prune.run(now() - 30 * DAY_MS).changes; },
  };
}

export function productCohortReport(database, now = Date.now()) {
  const cutoff = now - 30 * DAY_MS;
  const rows = database.prepare(`SELECT visitor,name,audience,context,mode,recorded_at FROM foxo_product_events
    WHERE recorded_at>? AND recorded_at<=? ORDER BY recorded_at,rowid`).all(cutoff, now);
  const visitors = new Map();
  const contextsSeen = {};
  for (const row of rows) {
    contextsSeen[row.context] = (contextsSeen[row.context] ?? 0) + 1;
    if (row.context === 'demo') continue;
    if (!visitors.has(row.visitor)) visitors.set(row.visitor, []);
    visitors.get(row.visitor).push(row);
  }
  const totals = { browsers: 0, secondMatch: 0, shareToMatch: 0, d1Eligible: 0, d1Returned: 0, d7Eligible: 0, d7Returned: 0 };
  const funnel = Object.fromEntries([...events].map(name => [name, 0]));
  const audienceAtMatch = { guest: 0, wallet: 0, holder: 0 };
  const firstMatchWaits = [];
  for (const history of visitors.values()) {
    const landed = history.find(row => row.name === 'landing');
    if (!landed) continue;
    totals.browsers += 1;
    const afterLanding = history.filter(row => row.recorded_at >= landed.recorded_at);
    for (const name of new Set(afterLanding.map(row => row.name))) funnel[name] += 1;
    const started = afterLanding.filter(row => row.name === 'match_started');
    if (started.length) {
      audienceAtMatch[started[0].audience] += 1;
      firstMatchWaits.push(started[0].recorded_at - landed.recorded_at);
    }
    if (started.length >= 2) totals.secondMatch += 1;
    const share = afterLanding.find(row => row.name === 'share_opened');
    if (share && started.some(row => row.recorded_at >= share.recorded_at)) totals.shareToMatch += 1;
    const day = Math.floor(landed.recorded_at / DAY_MS);
    const today = Math.floor(now / DAY_MS);
    const activeDays = new Set(afterLanding.map(row => Math.floor(row.recorded_at / DAY_MS)));
    // Exclude incomplete UTC dates from either retention denominator.
    if (today > day + 1) { totals.d1Eligible += 1; if (activeDays.has(day + 1)) totals.d1Returned += 1; }
    if (today > day + 7) { totals.d7Eligible += 1; if (activeDays.has(day + 7)) totals.d7Returned += 1; }
  }
  firstMatchWaits.sort((a, b) => a - b);
  const mid = Math.floor(firstMatchWaits.length / 2);
  const firstMatchMedianMs = firstMatchWaits.length
    ? Math.round((firstMatchWaits[mid] + firstMatchWaits[Math.floor((firstMatchWaits.length - 1) / 2)]) / 2)
    : null;
  return { cutoff, through: now, ...totals, funnel, audienceAtMatch, contextsSeen,
    firstMatchMedianMs, firstMatchTimingSamples: firstMatchWaits.length };
}
