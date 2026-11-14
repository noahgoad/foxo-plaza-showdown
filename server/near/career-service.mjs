import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCareerOutbox } from './career-outbox.mjs';

export function createCareerService({ database, passport, usage, chain, contractId, collectionId }) {
  const find = database.prepare('SELECT payload,result_hash FROM near_results WHERE match_id=? AND account_id=?');
  const outbox = createCareerOutbox({ database, network: 'near-testnet', contractId, collectionId, chain,
    verifyResult(result) {
      const row = find.get(result.matchId, result.accountId);
      if (!row || !isDeepStrictEqual(JSON.parse(row.payload), result)) throw new Error('Career result is not in the authoritative journal');
      const { resultHash, finishedAt, ...payload } = result;
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      if (hash !== resultHash || hash !== row.result_hash) throw new Error('Career result digest mismatch');
      usage.sessionReceipt(result.nft, result.matchId, {
        actorId: result.accountId, mode: result.mode, finishedAt,
      });
      return { source: 'authoritative', sourceId: result.matchId + ':' + result.accountId };
    },
  });
  const candidates = database.prepare(`SELECT payload FROM near_results
    WHERE json_extract(payload,'$.rulesVersion') IN ('near-authoritative-boss-1','near-authoritative-trials-1')
    AND json_extract(payload,'$.nft') IS NOT NULL AND json_extract(payload,'$.left')=0
    ORDER BY match_id, account_id`);
  return {
    async tick({ onError = console.error } = {}) {
      for (const row of candidates.all()) {
        try {
          const result = JSON.parse(row.payload);
          const pending = outbox.enqueue(result);
          const observed = await outbox.process(pending.operationId);
          if (observed.status === 'FINALIZED') passport.finalize(result.matchId, result.accountId, result.resultHash);
        } catch (error) { onError(error); }
      }
    },
    outbox,
  };
}
