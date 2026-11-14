import { accountId, nftIdentity } from '../../src/economy/schema.js';
import { readFoxChainIdentity } from './fox-chain.mjs';

const modes = ['boss', 'hunt', 'control', 'trials'];
const maxGrantMs = 7 * 24 * 60 * 60 * 1000;
// Current runtime limits: hunt-core HUNT, bossMode BOSS_MODE, objective-rules
// CONTROL and dailyChallenge (120 + (seed % 3) * 30 seconds).
const modeLimitsMs = Object.freeze({ hunt: 300_000, boss: 240_000, control: 240_000, trials: 180_000 });
const leaseGraceMs = 120_000;

function nftKey(nft) {
  const { collectionId, tokenId } = nftIdentity(nft?.collectionId, nft?.tokenId);
  return [collectionId, tokenId];
}

function grantView(row) {
  return { borrowerId: row.borrower_id, modes: JSON.parse(row.modes), expiresAt: row.expires_at };
}

function leaseView(row) {
  return { actorId: row.actor_id, rewardAccountId: row.actor_id, ownerId: row.owner_id,
    ownerEpoch: row.owner_epoch, grantEpoch: row.grant_epoch, matchId: row.match_id,
    mode: row.mode, startedAt: row.started_at, expiresAt: row.expires_at,
    rulesVersion: row.rules_version, loadout: JSON.parse(row.loadout_snapshot),
    rights: JSON.parse(row.rights_snapshot) };
}

export function createFoxUsage({ database, readIdentity = readFoxChainIdentity, now = Date.now,
  modeMaxDurationMs = modeLimitsMs, requireOwnershipEpoch = readIdentity === readFoxChainIdentity }) {
  const limits = Object.fromEntries(modes.map(mode => [mode, modeMaxDurationMs?.[mode]]));
  if (Object.values(limits).some(ms => !Number.isSafeInteger(ms) || ms <= 0 || ms > maxGrantMs)) {
    throw new Error('Invalid mode maximum duration.');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS near_fox_owners (
      collection_id TEXT NOT NULL, token_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, block_height INTEGER NOT NULL, owner_epoch INTEGER NOT NULL,
      PRIMARY KEY (collection_id, token_id)
    );
    CREATE TABLE IF NOT EXISTS near_fox_grants (
      collection_id TEXT NOT NULL, token_id TEXT NOT NULL, borrower_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL, modes TEXT NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY (collection_id, token_id, borrower_id)
    );
    CREATE INDEX IF NOT EXISTS near_fox_grants_by_borrower
      ON near_fox_grants (borrower_id, expires_at);
    CREATE TABLE IF NOT EXISTS near_fox_leases (
      collection_id TEXT NOT NULL, token_id TEXT NOT NULL, match_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL,
      mode TEXT NOT NULL, expires_at INTEGER NOT NULL, finished INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (collection_id, token_id, match_id)
    );
    CREATE INDEX IF NOT EXISTS near_fox_leases_by_match ON near_fox_leases (match_id);
  `);
  // Additive upgrade: legacy leases retain their lock, but have no invented
  // session provenance and cannot be used for new late-result verification.
  for (const [table, columns] of Object.entries({
    near_fox_owners: { chain_epoch: 'TEXT' },
    near_fox_grants: { grant_epoch: 'INTEGER NOT NULL DEFAULT 1' },
    near_fox_leases: { grant_epoch: 'INTEGER', started_at: 'INTEGER', rules_version: 'TEXT',
      loadout_snapshot: "TEXT NOT NULL DEFAULT 'null'", rights_snapshot: "TEXT NOT NULL DEFAULT 'null'" },
  })) {
    const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing.has(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  const owners = database.prepare('SELECT * FROM near_fox_owners WHERE collection_id = ? AND token_id = ?');
  const observe = database.prepare(`INSERT INTO near_fox_owners
    (collection_id,token_id,owner_id,block_height,owner_epoch,chain_epoch) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT (collection_id, token_id) DO UPDATE SET
      owner_epoch = owner_epoch + (owner_id <> excluded.owner_id OR
        COALESCE(chain_epoch,'') <> COALESCE(excluded.chain_epoch,'')),
      owner_id = excluded.owner_id, block_height = excluded.block_height, chain_epoch=excluded.chain_epoch
    WHERE excluded.block_height > block_height`);
  const writeGrant = database.prepare(`INSERT INTO near_fox_grants
    (collection_id, token_id, borrower_id, owner_id, owner_epoch, modes, expires_at)
    SELECT collection_id, token_id, ?, owner_id, owner_epoch, ?, ? FROM near_fox_owners
    WHERE collection_id = ? AND token_id = ? AND owner_id = ? AND owner_epoch = ?
    ON CONFLICT (collection_id, token_id, borrower_id) DO UPDATE SET owner_id = excluded.owner_id,
      owner_epoch = excluded.owner_epoch, modes = excluded.modes, expires_at = excluded.expires_at,
      grant_epoch = grant_epoch + 1`);
  const deleteGrant = database.prepare(`UPDATE near_fox_grants SET expires_at = 0
    WHERE collection_id = ? AND token_id = ? AND borrower_id = ? AND owner_id = ? AND owner_epoch = ?`);
  const validGrant = database.prepare(`SELECT * FROM near_fox_grants WHERE collection_id = ? AND token_id = ?
    AND borrower_id = ? AND owner_id = ? AND owner_epoch = ? AND expires_at > ?`);
  const tokenGrants = database.prepare(`SELECT * FROM near_fox_grants WHERE collection_id = ? AND token_id = ?
    AND owner_id = ? AND owner_epoch = ? AND expires_at > ? ORDER BY borrower_id`);
  const borrowerGrants = database.prepare(`SELECT * FROM near_fox_grants WHERE borrower_id = ? AND expires_at > ?
    ORDER BY collection_id, token_id LIMIT ? OFFSET ?`);
  const active = database.prepare(`SELECT * FROM near_fox_leases WHERE collection_id = ? AND token_id = ?
    AND finished = 0 AND expires_at > ?`);
  const accepted = database.prepare(`SELECT * FROM near_fox_leases
    WHERE collection_id = ? AND token_id = ? AND match_id = ?`);
  const insertLease = database.prepare(`INSERT INTO near_fox_leases
    (collection_id, token_id, match_id, actor_id, owner_id, owner_epoch, mode, expires_at,
      started_at, loadout_snapshot, rules_version, grant_epoch, rights_snapshot)
    SELECT collection_id, token_id, ?, ?, owner_id, owner_epoch, ?, ?, ?, ?, ?,
      CASE WHEN owner_id = ? THEN NULL ELSE (SELECT grant_epoch FROM near_fox_grants AS g
        WHERE g.collection_id = near_fox_owners.collection_id AND g.token_id = near_fox_owners.token_id
          AND g.borrower_id = ?) END, ? FROM near_fox_owners
    WHERE collection_id = ? AND token_id = ? AND owner_id = ? AND owner_epoch = ?
      AND (owner_id = ? OR EXISTS (
        SELECT 1 FROM near_fox_grants AS g WHERE g.collection_id = near_fox_owners.collection_id
          AND g.token_id = near_fox_owners.token_id AND g.borrower_id = ?
          AND g.owner_id = near_fox_owners.owner_id AND g.owner_epoch = near_fox_owners.owner_epoch
          AND g.expires_at > ? AND EXISTS (SELECT 1 FROM json_each(g.modes) WHERE value = ?)))
      AND NOT EXISTS (SELECT 1 FROM near_fox_leases AS l
        WHERE l.collection_id = near_fox_owners.collection_id AND l.token_id = near_fox_owners.token_id
          AND l.finished = 0 AND l.expires_at > ?)
    ON CONFLICT DO NOTHING`);
  const finishOne = database.prepare(`UPDATE near_fox_leases SET finished = 1
    WHERE collection_id = ? AND token_id = ? AND match_id = ? AND finished = 0`);
  const finishAll = database.prepare('UPDATE near_fox_leases SET finished = 1 WHERE match_id = ? AND finished = 0');
  const reconcileCandidates = database.prepare(`SELECT DISTINCT collection_id, token_id FROM near_fox_grants
    WHERE expires_at > ? ORDER BY collection_id, token_id LIMIT ? OFFSET ?`);

  async function snapshot(nft, current) {
    const key = nftKey(nft);
    const identity = current ?? await readIdentity(nft);
    if (!identity || !Number.isSafeInteger(identity.blockHeight) || identity.blockHeight < 0) {
      throw new Error('Could not verify current Fox ownership.');
    }
    const epoch=identity.ownershipEpoch ?? null;
    if(epoch!==null && (typeof epoch!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(epoch)))throw new Error('Invalid ownership epoch');
    const previous=owners.get(...key);
    if(previous?.chain_epoch!=null && epoch!==null && BigInt(epoch)<BigInt(previous.chain_epoch))throw new Error('Ownership epoch moved backwards');
    observe.run(...key, accountId(identity.ownerId), identity.blockHeight, epoch);
    const row = owners.get(...key);
    if (row.block_height !== identity.blockHeight || row.owner_id !== identity.ownerId || row.chain_epoch !== epoch) {
      throw new Error('Ownership snapshot is stale. Retry.');
    }
    return { key, identity, ownerEpoch: row.owner_epoch };
  }

  async function authorize(actorId, { nft, mode }) {
    accountId(actorId);
    const state = await snapshot(nft);
    if (state.identity.ownerId === actorId) return state;
    if(requireOwnershipEpoch && state.identity.ownershipEpoch==null)throw new Error('Fox ownership history is unavailable. Refresh after the collection upgrade.');
    const grant = validGrant.get(...state.key, actorId, state.identity.ownerId, state.ownerEpoch, now());
    if (!grant || (mode && !grantView(grant).modes.includes(mode))) throw new Error('No active Fox loan grant for this mode.');
    return state;
  }

  return {
    authorize,
    async grant(actorId, { nft, borrowerId, modes: allowed, expiresAt }) {
      accountId(actorId);
      accountId(borrowerId);
      const { key, identity, ownerEpoch } = await snapshot(nft);
      if (identity.ownerId !== actorId) throw new Error('Only the current owner can lend this Fox.');
      if(requireOwnershipEpoch && identity.ownershipEpoch==null)throw new Error('Fox ownership history is unavailable. Refresh after the collection upgrade.');
      const time = now();
      if (borrowerId === actorId || !Array.isArray(allowed) || !allowed.length ||
          allowed.some(mode => !modes.includes(mode)) || !Number.isSafeInteger(expiresAt) ||
          expiresAt <= time || expiresAt > time + maxGrantMs) throw new Error('Invalid Fox loan grant.');
      const ordered = modes.filter(mode => allowed.includes(mode));
      if (!writeGrant.run(borrowerId, JSON.stringify(ordered), expiresAt, ...key, actorId, ownerEpoch).changes) {
        throw new Error('Fox owner changed. Retry.');
      }
      return { borrowerId, modes: ordered, expiresAt };
    },
    async revoke(actorId, { nft, borrowerId }) {
      accountId(borrowerId);
      const { key, identity, ownerEpoch } = await snapshot(nft);
      if (identity.ownerId !== actorId) throw new Error('Only the current owner can revoke this Fox loan.');
      return Boolean(deleteGrant.run(...key, borrowerId, actorId, ownerEpoch).changes);
    },
    async start(actorId, { nft, mode, matchId, durationMs = limits[mode], loadout = null, rulesVersion = null }) {
      accountId(actorId);
      if (!modes.includes(mode) || typeof matchId !== 'string' || !/^[\w-]{1,128}$/.test(matchId)) {
        throw new Error('Invalid Fox match lease.');
      }
      const existing = accepted.get(...nftKey(nft), matchId);
      if (existing) {
        if (existing.actor_id === actorId && existing.mode === mode && !existing.finished && existing.expires_at > now()) {
          return leaseView(existing);
        }
        throw new Error('Accepted Fox session cannot be reopened or reassigned.');
      }
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > limits[mode] ||
          (rulesVersion !== null && (typeof rulesVersion !== 'string' || !/^[\w.-]{1,64}$/.test(rulesVersion)))) {
        throw new Error('Invalid Fox session duration or rules version.');
      }
      const loadoutSnapshot = JSON.stringify(loadout);
      if (typeof loadoutSnapshot !== 'string' || Buffer.byteLength(loadoutSnapshot) > 16_384) {
        throw new Error('Invalid Fox session loadout.');
      }
      const { key, identity, ownerEpoch } = await authorize(actorId, { nft, mode });
      const time = now();
      const expiresAt = time + durationMs + leaseGraceMs;
      if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(expiresAt)) throw new Error('Invalid Fox session time.');
      const grant = actorId === identity.ownerId ? null : validGrant.get(...key, actorId, identity.ownerId, ownerEpoch, time);
      const rights = { source: grant ? 'loan' : 'owner', modes: grant ? JSON.parse(grant.modes) : [mode],
        grantExpiresAt: grant?.expires_at ?? null, canTransfer: false, canWithdraw: false };
      if (insertLease.run(matchId, actorId, mode, expiresAt, time, loadoutSnapshot, rulesVersion,
        actorId, actorId, JSON.stringify(rights), ...key, identity.ownerId, ownerEpoch,
        actorId, actorId, time, mode, time).changes) {
        return leaseView(accepted.get(...key, matchId));
      }
      const lease = active.get(...key, time);
      if (lease?.match_id === matchId && lease.actor_id === actorId && lease.mode === mode) return leaseView(lease);
      if (lease) throw new Error('This Fox already has an active match.');
      throw new Error('Fox loan grant or match is no longer available.');
    },
    // Internal authoritative-result lookup, not a player authorization API.
    // A receipt proves the accepted actor/rights; callers still verify simulation
    // provenance, deduplicate settlement, and append career separately.
    sessionReceipt(nft, matchId, { actorId, mode, finishedAt }) {
      const row = accepted.get(...nftKey(nft), matchId);
      if (!row || row.started_at === null || row.actor_id !== accountId(actorId) || row.mode !== mode ||
          !Number.isSafeInteger(finishedAt) || finishedAt < row.started_at || finishedAt > row.expires_at) {
        throw new Error('Result does not match an accepted Fox session.');
      }
      return leaseView(row);
    },
    finish(nft, matchId) {
      return Boolean(finishOne.run(...nftKey(nft), matchId).changes);
    },
    finishMatch(matchId) {
      return Number(finishAll.run(matchId).changes);
    },
    async view(nft, current) {
      const { key, identity, ownerEpoch } = await snapshot(nft, current);
      const time = now();
      const lease = active.get(...key, time);
      return { ownerId: identity.ownerId, grants: tokenGrants.all(...key, identity.ownerId, ownerEpoch, time).map(grantView),
        lease: lease ? leaseView(lease) : null };
    },
    async list(actorId, { offset = 0, limit = 20 } = {}) {
      accountId(actorId);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('Invalid loan page.');
      }
      const rows = borrowerGrants.all(actorId, now(), limit, offset);
      const results = await Promise.all(rows.map(async row => {
        const nft = { collectionId: row.collection_id, tokenId: row.token_id };
        const { identity, ownerEpoch } = await snapshot(nft);
        return row.owner_id === identity.ownerId && row.owner_epoch === ownerEpoch && row.expires_at > now() ?
          { ...grantView(row), identity } : null;
      }));
      return results.filter(Boolean);
    },
    async reconcile({ offset = 0, limit = 20 } = {}) {
      const rows = reconcileCandidates.all(now(), limit, offset);
      await Promise.all(rows.map(row => snapshot({ collectionId: row.collection_id, tokenId: row.token_id })));
      return rows.length === limit ? offset + limit : null;
    },
  };
}
