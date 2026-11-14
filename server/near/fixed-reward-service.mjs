import { createFixedReservationQueue } from './reservations.mjs';
import { createReservationDispatch } from './reservation-dispatch.mjs';
import { createReservationReceiptVerifier } from './reservation-receipts.mjs';

/** The match runner supplies trusted ready/complete calls. Transport owns signing. */
export function createFixedRewardService({ database, config, campaignId, seasonStartMs,
  economyId, signerId, rpc, prepare, broadcast, canReplace, now = Date.now }) {
  if (typeof prepare !== 'function' || typeof broadcast !== 'function') {
    throw new TypeError('Fixed rewards require a transaction transport');
  }
  const verify = createReservationReceiptVerifier({ economyId, signerId, rpc });
  const queue = createFixedReservationQueue({ database, config, campaignId, seasonStartMs, now,
    verifyChainReservation: verify });
  const dispatch = createReservationDispatch({ database, queue, prepare, broadcast, verify, canReplace });
  const claims = database.prepare(`SELECT r.id AS operationId, r.amount_atomic AS amountAtomic,
    r.mode, r.match_id AS matchId FROM near_fixed_reservations r
    JOIN near_fixed_settlement_receipts s ON s.reservation_id = r.id
    WHERE r.account_id = ? AND r.campaign_id = ? ORDER BY r.created_at DESC LIMIT 100`);
  return {
    claims: account => ({ economyId, entries: claims.all(account, campaignId).map(row => ({ ...row })) }),
    ready: (actor, match) => queue.enqueueReady(actor, match),
    get: id => queue.get(id),
    start: id => queue.start(id),
    cancel: (actor, id) => queue.cancel(actor, id),
    async complete(id, result) {
      queue.complete(id, result);
      return dispatch.run(id, 'settle');
    },
    closeIncomplete: (id, details) => queue.closeIncomplete(id, details),
    async tick(options) {
      queue.expireUnstarted();
      queue.allocateReady();
      await dispatch.recover(options);
    },
  };
}
