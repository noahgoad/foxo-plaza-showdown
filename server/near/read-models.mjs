import {accountId,atomic} from '../../src/economy/schema.js';

const payoutStages = {
  reward_reserved: 0,
  ranking_allocation_reserved: 0,
  reward_payout_started: 1,
  reward_transfer_failed: 2,
  reward_paid: 3,
};

/** Cumulative finalized event totals are observations, never spendable balances. */
export function createEconomyReadModels({database,network='near-testnet',contractId,now=Date.now}) {
  accountId(contractId);
  if(network!=='near-testnet')throw new Error('Unsupported index network');
  const scope=[network,contractId];
  const latest=database.prepare('SELECT height,hash FROM near_economy_index_blocks WHERE network=? AND contract_id=? ORDER BY height DESC LIMIT 1');
  const synced=database.prepare('SELECT synced_at_ms FROM near_economy_index_sync WHERE network=? AND contract_id=?');
  const events=database.prepare('SELECT event,amount_atomic,data FROM near_economy_index_events WHERE network=? AND contract_id=? ORDER BY block_height,receipt_id,log_index,event_index');
  const openSales = database.prepare(`SELECT DISTINCT json_extract(data,'$.saleId') AS id
    FROM near_economy_index_events
    WHERE network=? AND contract_id=? AND event='cosmetic_sale_opened'
      AND CAST(json_extract(data,'$.expiresAtMs') AS INTEGER)>?
    ORDER BY block_height DESC LIMIT 40`);
  return {
    cosmeticSaleIds: () => openSales.all(...scope, now()).map(row => row.id).filter(id => typeof id === 'string'),
    snapshot({ finalizedHead } = {}) {
      const cursor=latest.get(...scope),sync=synced.get(...scope);
      const age=sync?Math.max(0,now()-sync.synced_at_ms):null;
      const totals={rewardFunding:'0',rewardPaid:'0',craftingFees:'0',marketFees:'0',orderFunding:'0',orderRefundCredits:'0',orderPayments:'0'};
      const fixedTotals={held:0n,released:0n,settled:0n};
      const add=(key,amount)=>totals[key]=(atomic(totals[key])+atomic(amount)).toString();
      const payouts=new Map();
      for(const row of events.all(...scope)) {
        const data=JSON.parse(row.data);
        if(row.event==='reward_funded')add('rewardFunding',row.amount_atomic);
        else if(row.event==='reward_paid')add('rewardPaid',row.amount_atomic);
        else if(['craft_fee_collected','guild_commit'].includes(row.event))add('craftingFees',row.amount_atomic);
        else if(row.event==='order_filled'||row.event==='cosmetic_sale_filled') {
          if(data.feeAtomic!==undefined)add('marketFees',data.feeAtomic);
        } else if(row.event==='order_funded')add('orderFunding',row.amount_atomic);
        else if(row.event==='order_refund_credited')add('orderRefundCredits',row.amount_atomic);
        else if(row.event==='order_paid')add('orderPayments',row.amount_atomic);
        if(row.event==='fixed_reward_held')fixedTotals.held+=atomic(row.amount_atomic);
        if(row.event==='fixed_reward_released')fixedTotals.released+=atomic(row.amount_atomic);
        if(row.event==='fixed_reward_settled')fixedTotals.settled+=atomic(row.amount_atomic);
        if(data.operationId && Object.hasOwn(payoutStages,row.event)) {
          const previous=payouts.get(data.operationId);
          const attempt=data.attempt ?? '0';
          if(previous && (BigInt(previous.attempt)>BigInt(attempt) ||
              previous.attempt===attempt && payoutStages[previous.event]>=payoutStages[row.event]))continue;
          payouts.set(data.operationId,{operationId:data.operationId,accountId:data.accountId,
            event:row.event,amountAtomic:row.amount_atomic,attempt});
        }
      }
      const behindHead=finalizedHead !== undefined &&
        (!cursor || cursor.height !== finalizedHead?.height || cursor.hash !== finalizedHead?.hash);
      return {network,contractId,status:!cursor?'UNAVAILABLE':age===null||age>30000||behindHead?'SYNCING':'SYNCED',
        cursor:cursor?{height:cursor.height,hash:cursor.hash}:null,lastSyncAtMs:sync?.synced_at_ms??null,ageMs:age,
        fixedOutstandingAtomic:(fixedTotals.held-fixedTotals.released-fixedTotals.settled).toString(),
        cumulativeEventTotals:totals,rewardOperations:[...payouts.values()],spendAuthorization:false};
    },
  };
}
