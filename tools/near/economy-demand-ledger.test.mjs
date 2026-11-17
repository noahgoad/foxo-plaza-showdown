import test from 'node:test';
import assert from 'node:assert/strict';
import { createEconomyDemandLedger } from '../../server/near/economy-demand-ledger.mjs';

test('only escrow-backed source proof classifies funded order fills', () => {
  const ledger = createEconomyDemandLedger([
    { orderId: 'a', source: 'Guild' },
    { orderId: 'b', source: 'Sponsored' },
  ]);
  ledger.record('order_funded', { orderId: 'a' }, '1000');
  ledger.record('order_filled', { orderId: 'a', grossAtomic: '100', feeAtomic: '2' });
  ledger.record('order_filled', { orderId: 'b', feeAtomic: '5' }, '220');
  ledger.record('order_filled', { orderId: 'c', source: 'Guild', grossAtomic: '50' });
  ledger.record('cosmetic_sale_filled', { grossAtomic: '400', feeAtomic: '10' });
  assert.deepEqual(ledger.snapshot(), {
    cosmeticSaleGross: '400',
    guildOrderGross: '100',
    sponsoredOrderGross: '220',
    unattributedOrderGross: '50',
    observedTradeFees: '17',
  });
});
