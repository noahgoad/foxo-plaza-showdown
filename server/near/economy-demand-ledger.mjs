import { atomic } from '../../src/economy/schema.js';

/** Report observable finalized trade flows. Attribution requires a published escrow proof. */
export function createEconomyDemandLedger(publishedOrders = []) {
  const sourceByOrder = new Map(publishedOrders.map(({ orderId, source }) => [orderId, source]));
  const totals = {
    cosmeticSaleGross: 0n,
    guildOrderGross: 0n,
    sponsoredOrderGross: 0n,
    unattributedOrderGross: 0n,
    observedTradeFees: 0n,
  };

  return {
    record(event, data, indexedAmount) {
      if (event !== 'cosmetic_sale_filled' && event !== 'order_filled') return;
      const gross = atomic(data.grossAtomic ?? indexedAmount);
      const fee = data.feeAtomic === undefined ? 0n : atomic(data.feeAtomic);
      if (fee > gross) throw new Error('Indexed market fee exceeds gross proceeds');
      totals.observedTradeFees += fee;
      if (event === 'cosmetic_sale_filled') {
        totals.cosmeticSaleGross += gross;
        return;
      }
      const source = sourceByOrder.get(data.orderId);
      if (source === 'Guild') totals.guildOrderGross += gross;
      else if (source === 'Sponsored') totals.sponsoredOrderGross += gross;
      else totals.unattributedOrderGross += gross;
    },
    snapshot() {
      return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, String(value)]));
    },
  };
}
