import { accountId, nftIdentity } from '../../src/economy/schema.js';
import { foxCareerEntitlements } from '../../src/economy/specializations.js';
import { readFoxChainIdentity } from './fox-chain.mjs';

const aggregate = `SELECT COUNT(*) AS matches, COALESCE(SUM(xp), 0) AS xp,
  COALESCE(SUM(won), 0) AS wins,
  COALESCE(SUM(CASE WHEN mode = 'boss' THEN won ELSE 0 END), 0) AS bossWins
  FROM near_passport_results`;

export function createFoxPassport({ database, readIdentity = readFoxChainIdentity, usage = null, readCareer = null }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS near_passport_results (
      match_id TEXT NOT NULL, account_id TEXT NOT NULL,
      collection_id TEXT, token_id TEXT, mode TEXT NOT NULL, won INTEGER NOT NULL,
      xp INTEGER NOT NULL, result_hash TEXT NOT NULL, rules_version TEXT NOT NULL,
      finished_at INTEGER NOT NULL, finalized INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (match_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS near_passport_by_token
      ON near_passport_results (collection_id, token_id, finished_at);
    CREATE INDEX IF NOT EXISTS near_passport_by_account
      ON near_passport_results (account_id, finalized);
  `);
  const insert = database.prepare(`INSERT INTO near_passport_results
    (match_id, account_id, collection_id, token_id, mode, won, xp, result_hash, rules_version, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  const prior = database.prepare('SELECT * FROM near_passport_results WHERE match_id = ? AND account_id = ?');
  const confirm = database.prepare(`UPDATE near_passport_results SET finalized = 1
    WHERE match_id = ? AND account_id = ? AND result_hash = ? AND finalized = 0`);
  const career = database.prepare(aggregate + ' WHERE collection_id = ? AND token_id = ? AND finalized = ?');
  const rank = database.prepare(aggregate + ' WHERE account_id = ? AND finalized = 1');
  const history = database.prepare(`SELECT match_id AS matchId, account_id AS accountId, mode, won, xp,
    result_hash AS resultHash, rules_version AS rulesVersion, finished_at AS finishedAt, finalized
    FROM near_passport_results WHERE collection_id = ? AND token_id = ?
    ORDER BY finished_at DESC, match_id DESC, account_id DESC LIMIT ? OFFSET ?`);

  return {
    // Internal sink. Caller must verify result provenance before it reaches this store.
    ingest({ matchId, accountId: actor, nft, mode, won, xp, resultHash, rulesVersion, finishedAt }) {
      accountId(actor);
      const identity = nft == null ? null : nftIdentity(nft.collectionId, nft.tokenId);
      if (typeof matchId !== 'string' || !/^[\w-]{1,128}$/.test(matchId) ||
          !['hunt','control','boss','trials'].includes(mode) || typeof won !== 'boolean' ||
          !Number.isSafeInteger(xp) || xp < 0 || !Number.isSafeInteger(finishedAt) || finishedAt < 0 ||
          typeof rulesVersion !== 'string' || !/^[\w.-]{1,64}$/.test(rulesVersion) ||
          typeof resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(resultHash)) {
        throw new Error('Invalid authoritative result.');
      }
      const collectionId = identity?.collectionId ?? null;
      const tokenId = identity?.tokenId ?? null;
      if (insert.run(matchId, actor, collectionId, tokenId, mode, Number(won), xp,
        resultHash, rulesVersion, finishedAt).changes) return true;
      const row = prior.get(matchId, actor);
      if (row.collection_id !== collectionId || row.token_id !== tokenId || row.mode !== mode ||
          row.won !== Number(won) || row.xp !== xp || row.result_hash !== resultHash ||
          row.rules_version !== rulesVersion || row.finished_at !== finishedAt) {
        throw new Error('Conflicting Passport result.');
      }
      return false;
    },
    // Only the trusted receipt reconciler may mark a result finalized.
    finalize(matchId, actor, resultHash) {
      if (prior.get(matchId, actor)?.result_hash !== resultHash) throw new Error('Result hash does not match.');
      return Boolean(confirm.run(matchId, actor, resultHash).changes);
    },
    rank(actor) {
      return { ...rank.get(accountId(actor)) };
    },
    tokenCareer(nft, finalized = true) {
      const { collectionId, tokenId } = nftIdentity(nft?.collectionId, nft?.tokenId);
      return { ...career.get(collectionId, tokenId, Number(finalized)) };
    },
    async gameplayCareer(nft) {
      return readCareer ? (await readCareer(nft,{offset:0,limit:1})).summary : this.tokenCareer(nft);
    },
    async view(nft, { offset = 0, limit = 20 } = {}) {
      const { collectionId, tokenId } = nftIdentity(nft?.collectionId, nft?.tokenId);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Invalid Passport page.');
      }
      const identity = await readIdentity({ collectionId, tokenId });
      if (!identity) return null;
      const usageView = usage && await usage.view({ collectionId, tokenId });
      const rows = history.all(collectionId, tokenId, limit + 1, offset);
      const chainCareer=readCareer && await readCareer({collectionId,tokenId},{offset,limit});
      const finalized = chainCareer?.summary ?? this.tokenCareer(nft);
      const entitlements = foxCareerEntitlements({ collectionId, tokenId }, finalized);
      return {
        identity: { ...identity, ownerId: usageView?.ownerId ?? identity.ownerId, collectionId, tokenId },
        career: {
          source:chainCareer?'near-testnet':'local-passport',
          ...(chainCareer?{blockHash:chainCareer.blockHash,blockHeight:chainCareer.blockHeight}:{}),
          finalized,
          ...(entitlements ? { entitlements: { ...entitlements, source: chainCareer?'near-testnet':'local-passport' } } : {}),
          pending: this.tokenCareer(nft, false),
          history: chainCareer?.history ?? rows.slice(0, limit).map(row => ({ ...row, won: Boolean(row.won), finalized: Boolean(row.finalized) })),
          nextOffset: chainCareer?chainCareer.nextOffset:rows.length > limit ? offset + limit : null,
        },
        usage: usageView,
      };
    },
  };
}
