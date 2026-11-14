import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createEconomyIndexer} from '../../server/near/indexer.mjs';
import {createEconomyReadModels} from '../../server/near/read-models.mjs';
import {reconcileEconomy} from '../../server/near/reconciliation.mjs';
test('read model separates funding, fees and refunds; stale replay cannot refresh sync freshness',t=>{
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());let now=1000;
  const options={network:'near-testnet',contractId:'economy.testnet',startHeight:1,now:()=>now};
  const index=createEconomyIndexer(database,options),read=createEconomyReadModels({database,...options});
  assert.equal(read.snapshot().status,'UNAVAILABLE');
  const log=(event,amountAtomic,extra={})=>'EVENT_JSON:'+JSON.stringify({standard:'fox_economy',version:'1.0.0',event,data:[{accountId:'alice.testnet',amountAtomic,...extra}]});
  const block={height:1,hash:'a',previousHash:'start',finality:'final',receipts:[{receiptId:'receipt',executorId:'economy.testnet',success:true,
    logs:[log('reward_funded','100'),log('craft_fee_collected','8'),log('order_funded','40'),log('order_filled','20',{feeAtomic:'1',netAtomic:'19'}),log('order_refund_credited','20')]}]};
  index.ingestBlock(block);
  assert.equal(read.snapshot().status,'SYNCED');
  assert.equal(read.snapshot({finalizedHead:{height:2,hash:'next'}}).status,'SYNCING');
  assert.deepEqual(read.snapshot().cumulativeEventTotals,{rewardFunding:'100',rewardPaid:'0',craftingFees:'8',marketFees:'1',orderFunding:'40',orderRefundCredits:'20',orderPayments:'0'});
  now=32000;index.ingestBlock(block);
  assert.equal(read.snapshot().status,'SYNCING');assert.equal(read.snapshot().spendAuthorization,false);
  const restarted=createEconomyReadModels({database,...options});assert.deepEqual(restarted.snapshot(),read.snapshot());
});

test('payout projection follows attempts and stages across same-block receipt ordering', t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const options = { network: 'near-testnet', contractId: 'economy.testnet', startHeight: 1 };
  const index = createEconomyIndexer(database, options);
  const receipt = (receiptId, event, attempt) => ({
    receiptId, executorId: 'economy.testnet', success: true,
    logs: ['EVENT_JSON:' + JSON.stringify({ standard: 'fox_economy', version: '1.0.0', event,
      data: [{ accountId: 'alice.testnet', operationId: 'rank:1', amountAtomic: '5', attempt }] })],
  });
  index.ingestBlock({ height: 1, hash: 'a', previousHash: 'start', finality: 'final', receipts: [
    receipt('a', 'reward_paid', '2'), receipt('b', 'reward_payout_started', '2'),
    receipt('c', 'reward_transfer_failed', '1'),
  ] });
  const read = createEconomyReadModels({ database, ...options }).snapshot();
  assert.deepEqual(read.rewardOperations, [{ operationId: 'rank:1', accountId: 'alice.testnet',
    event: 'reward_paid', amountAtomic: '5', attempt: '2' }]);
  assert.equal(read.cumulativeEventTotals.rewardPaid, '5');
});

test('reconciliation compares separate ledger buckets only at the indexed finalized block', () => {
  const cursor = { height: 4, hash: 'final' };
  const snapshot = { cursor, status: 'SYNCED', fixedOutstandingAtomic: '6',
    cumulativeEventTotals: { rewardFunding: '100', rewardPaid: '5', craftingFees: '2' } };
  const ledger = { rewardAvailable: '60', campaignAvailable: '20', fixedReserved: '6',
    rewardReserved: '7', rewardInFlight: '2', rewardPaid: '5', craftingFees: '2' };
  assert.equal(reconcileEconomy({ snapshot, ledger, block: cursor }).status, 'MATCH');
  const mismatch = reconcileEconomy({ snapshot, ledger: { ...ledger, fixedReserved: '5', campaignAvailable: '21' },
    block: cursor });
  assert.equal(mismatch.status, 'MISMATCH');
  assert.deepEqual(mismatch.comparisons.filter(row => !row.matches).map(row => row.label), ['Fixed rewards held']);
  assert.equal(mismatch.spendAuthorization, false);
  assert.throws(() => reconcileEconomy({ snapshot, ledger, block: { ...cursor, hash: 'other' } }), /same finalized block/);
});
