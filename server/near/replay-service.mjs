import { createHash, randomBytes } from 'node:crypto';

const MAX_FRAMES = 1600;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function createHuntReplayService(database, now = Date.now) {
  database.exec(`CREATE TABLE IF NOT EXISTS foxo_hunt_replay (
    match_id TEXT PRIMARY KEY, participants TEXT NOT NULL, payload TEXT NOT NULL,
    digest TEXT NOT NULL, share_key TEXT UNIQUE, created_at INTEGER NOT NULL
  )`);
  const get = database.prepare('SELECT * FROM foxo_hunt_replay WHERE match_id = ?');
  const insert = database.prepare('INSERT OR IGNORE INTO foxo_hunt_replay VALUES (?, ?, ?, ?, NULL, ?)');
  const prune = database.prepare('DELETE FROM foxo_hunt_replay WHERE created_at <= ?');
  const publish = database.prepare('UPDATE foxo_hunt_replay SET share_key = ? WHERE match_id = ?');
  const publicRead = database.prepare('SELECT payload, digest FROM foxo_hunt_replay WHERE share_key = ? AND created_at > ?');
  const digest = payload => createHash('sha256').update(payload).digest('hex');

  return {
    record(room, frames) {
      if (!room.nearAuthoritative || frames.length < 2 || frames.length > MAX_FRAMES) return;
      const participants = (room.roster ?? []).filter(player => !player.bot).map(player => player.nearWallet).filter(Boolean);
      if (!participants.length) return;
      const events = [...(room.huntReplayEvents?.values() ?? [])];
      const payload = JSON.stringify({schemaVersion:1, source:'authoritative', frames, events});
      const time = now();
      prune.run(time - RETENTION_MS);
      insert.run(room.roundId, JSON.stringify(participants), payload, digest(payload), time);
    },
    share(matchId, accountId) {
      const row = get.get(matchId);
      if (!row || row.created_at <= now() - RETENTION_MS || !JSON.parse(row.participants).includes(accountId)) return null;
      const key = row.share_key ?? randomBytes(18).toString('base64url');
      if (!row.share_key) publish.run(key, matchId);
      return key;
    },
    read(key) {
      if (!/^[\w-]{24}$/.test(key)) return null;
      const row = publicRead.get(key, now() - RETENTION_MS);
      if (!row || digest(row.payload) !== row.digest) return null;
      return { ...JSON.parse(row.payload), digest: row.digest };
    },
  };
}

export function sampleHuntReplay(room, snapshot) {
  if (!room.nearAuthoritative || (room.config.mode || 'hunt') !== 'hunt' || !Array.isArray(snapshot.actors)) return;
  const elapsed = snapshot.core?.elapsed;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 320) return;
  const tick = Math.floor(elapsed * 1000);
  const events = room.huntReplayEvents ??= new Map();
  for (const event of Array.isArray(snapshot.events) ? snapshot.events.slice(-150) : []) {
    if (events.size >= 256 || event.type !== 'capture' || !Number.isSafeInteger(event.serial) ||
        typeof event.id !== 'string' || !/^hunt-\d{1,2}$/.test(event.id) || events.has(event.serial)) continue;
    events.set(event.serial, {
      type:'carrier_changed', tick, actorSessionId:event.id,
      payload:{traitCount:Math.min(4, Array.isArray(event.found) ? event.found.length : 0), disconnect:event.disconnect===true},
    });
  }
  const frames = room.huntReplayFrames ??= [];
  if (frames.length >= MAX_FRAMES || (frames.length && tick < frames.at(-1).tick + 195)) return;
  const id = value => typeof value === 'string' && /^hunt-\d{1,2}$/.test(value) ? value : null;
  const positions = snapshot.actors.slice(0,6).flatMap(actor => {
    const actorId = id(actor.id);
    const [x,,z] = Array.isArray(actor.pos) ? actor.pos : [];
    if (!actorId || !Number.isFinite(x) || !Number.isFinite(z)) return [];
    return [{id:actorId,x,z,active:actor.alive===true}];
  });
  if (positions.length) frames.push({tick, carrier:id(snapshot.core.holderId), positions});
}
