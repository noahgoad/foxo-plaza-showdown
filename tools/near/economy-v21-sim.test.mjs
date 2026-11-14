import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createFixedReservationQueue} from '../../server/near/reservations.mjs';
import {allocateModeRanking} from '../../src/economy/ranking-rules.js';

const config=JSON.parse(readFileSync(new URL('../../config/economy.testnet.json',import.meta.url)));
for(const count of [1,100,1000])test(`${count} accounts cannot overbook current fixed window or a ranking day`,async t=>{
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  const seasonStartMs=Date.UTC(2026,10,12),time=seasonStartMs+1;
  const options={database,config,campaignId:'stress',seasonStartMs,now:()=>time,
    verifyChainReservation:async()=>null};
  let queue=createFixedReservationQueue(options);
  for(let i=0;i<count;i++)for(let duplicate=0;duplicate<2;duplicate++)queue.enqueueReady(`player${i}.testnet`,{
    requestId:`request-${i}-${duplicate}`,matchId:`match-${i}-${duplicate}`,taskId:'complete-boss',mode:'boss',readyUntil:time+60000});
  const held=queue.allocateReady();
  assert.equal(held.length,Math.min(count,20));
  assert.equal(new Set(held.map(row=>row.accountId)).size,held.length);
  for(const row of held){assert.equal(row.guaranteed,false);queue.beginChainReserve(row.id);}
  queue=createFixedReservationQueue(options);
  assert.equal(queue.allocateReady().length,0);
  for(const row of held)assert.equal(await queue.reconcileChainReserve(row.id,{transactionHash:'unknown'}),null);
  assert.equal(queue.allocateReady().length,0);
  const ranking=allocateModeRanking({mode:'boss',dayIndex:0,entries:Array.from({length:count},(_,i)=>({accountId:`player${i}.testnet`,scoreAtomic:'1000000'}))});
  const total=ranking.allocations.reduce((sum,row)=>sum+BigInt(row.amountAtomic),0n);
  assert.ok(total<=BigInt(ranking.budgetAtomic));
  for(const row of ranking.allocations)assert.ok(BigInt(row.amountAtomic)<=625n*10n**22n);
});
