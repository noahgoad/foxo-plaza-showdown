import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { Worker } from 'near-workspaces';

// Keep this time-advance test inside one epoch. The old pinned Sandbox stops
// producing chunks when one fast-forward crosses many validator epochs.
const require=createRequire(import.meta.url);
const { SandboxServer }=require('near-workspaces/dist/server/server');
const originalStart=SandboxServer.prototype.start;
SandboxServer.prototype.start=async function(){
  const path=this.homeDir+'/genesis.json';
  const genesis=JSON.parse(await readFile(path,'utf8'));
  genesis.epoch_length=1_000_000;
  await writeFile(path,JSON.stringify(genesis));
  return originalStart.call(this);
};

const DAY=86_400_000, UNIT=10n**24n, GAS='300000000000000';
const gasBurnt = outcome => {
  const value = outcome.result ?? outcome;
  return [value.transaction_outcome,...(value.receipts_outcome??[])].reduce((sum,row)=>sum+BigInt(row?.outcome?.gas_burnt??0),0n);
};

test('1000-player ranking uses metered review/publication and bounded entitlement finalization', async()=>{
  const worker=await Worker.init();
  try {
    const root=worker.rootAccount;
    const token=await root.createSubAccount('token'), economy=await root.createSubAccount('economy'), alice=await root.createSubAccount('alice');
    await token.deploy('/wasm/sandbox_mock_ft.wasm');await economy.deploy('/wasm/near_economy.wasm');
    await root.call(token,'new',{owner_id:root.accountId,supply:String(1000n*UNIT)});
    await root.call(economy,'new',{owner_id:root.accountId,foxo_contract_id:token.accountId,network:'near-testnet',settlement_signer_id:root.accountId});
    await root.call(token,'storage_deposit',{account_id:economy.accountId},{attachedDeposit:'12500000000000000000000'});
    await root.call(token,'ft_transfer_call',{receiver_id:economy.accountId,amount:String(1000n*UNIT),msg:'{"action":"fund_rewards"}'},{attachedDeposit:'1',gas:GAS});
    const block=await root.provider.block({finality:'final'}), now=Math.floor(Number(block.header.timestamp_nanosec)/1e6);
    const start=Math.floor(now/DAY)*DAY-DAY;
    await root.call(economy,'open_ranking_campaign',{campaign_id:'ranking',mode:'hunt',season_start_ms:start});
    await root.call(economy,'set_settlement_enabled',{enabled:true});
    const budget=1000n*UNIT/28n+1n, amount=budget/1000n;
    const ids=[alice.accountId,...Array.from({length:999},(_,i)=>`player${String(i).padStart(4,'0')}.testnet`)].sort();
    const allocations=ids.map(accountId=>({accountId,scoreAtomic:'1000000',amountAtomic:String(amount)}));
    const draft={version:1,campaignId:'ranking',seasonStartMs:start,budgetDay:new Date(start).toISOString().slice(0,10),
      rubricVersion:'hunt-v1',evidenceHash:'a'.repeat(64),mode:'hunt',dayIndex:0,budgetAtomic:String(budget),
      totalScoreAtomic:'1000000000',allocations,awardedAtomic:String(amount*1000n),unallocatedAtomic:String(budget-amount*1000n)};
    const draft_json=JSON.stringify(draft), draft_hash=createHash('sha256').update('fox-ranking-draft/v1\0').update(draft_json).digest('hex');
    const propose=await root.callRaw(economy,'propose_ranking_draft',{draft_json,draft_hash},{gas:GAS});
    assert.equal(propose.failed,false,'propose transaction failed');
    const publication={campaign_id:'ranking',day_index:0,draft_hash};
    await assert.rejects(root.call(economy,'publish_ranking_draft',publication,{gas:GAS}),/review/);
    await assert.rejects(root.call(economy,'finalize_ranking_allocation',{campaign_id:'ranking',day_index:0,account_id:alice.accountId},{gas:GAS}),/not published/);
    await worker.provider.fastForward(86_405);
    const publish=await root.callRaw(economy,'publish_ranking_draft',publication,{gas:GAS});
    assert.equal(publish.failed,false,'publish transaction failed');
    assert.equal((await economy.view('get_ledger')).rewardReserved,String(amount*1000n));
    const operation_id=await economy.view('get_ranking_allocation_id',{campaign_id:'ranking',day_index:0,account_id:alice.accountId});
    assert.equal(await economy.view('get_entitlement',{operation_id}),null);
    await root.call(economy,'close_campaign',{campaign_id:'ranking'});
    const args={campaign_id:'ranking',day_index:0,account_id:alice.accountId};
    const finalize=await root.callRaw(economy,'finalize_ranking_allocation',args,{gas:GAS});
    assert.equal(finalize.failed,false,'finalize transaction failed');
    const before=await economy.view('get_ledger');
    await root.call(economy,'finalize_ranking_allocation',args,{gas:GAS});
    assert.deepEqual(await economy.view('get_ledger'),before);
    assert.equal(await alice.call(economy,'claim',{operation_id},{attachedDeposit:'1',gas:GAS}),false);
    await root.call(token,'storage_deposit',{account_id:alice.accountId},{attachedDeposit:'12500000000000000000000'});
    assert.equal(await alice.call(economy,'claim',{operation_id},{attachedDeposit:'1',gas:GAS}),true);
    assert.equal(await token.view('ft_balance_of',{account_id:alice.accountId}),String(amount));
    for(const [phase,outcome] of [['propose',propose],['publish',publish],['finalize',finalize]]){
      const burnt=gasBurnt(outcome);
      assert.ok(burnt>0n&&burnt<BigInt(GAS),`${phase} gas ${burnt}`);
      console.log(`RANKING_GAS ${phase} ${burnt}`);
    }
    console.log(`RANKING_PROOF players=1000 inputBytes=${Buffer.byteLength(draft_json)} reserved=${amount*1000n} paid=${amount}`);
  } finally {await worker.tearDown();}
});

