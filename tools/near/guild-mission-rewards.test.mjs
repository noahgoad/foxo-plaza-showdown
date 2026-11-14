import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createGuildMissionRewards } from '../../server/near/guild-mission-rewards.mjs';
import { guildMissionUpgrade } from '../../assets/near-fox/economy-deployment.js';

test('Guild claim requires a funded campaign and a finalized entitlement after submission',async()=>{
  const database=new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE near_guild_missions(account_id,project_id,mode,match_id,completed_at);
      CREATE TABLE near_results(account_id,match_id,result_hash);
      INSERT INTO near_guild_missions VALUES('alice.testnet','beacon','boss','round',1);
      INSERT INTO near_results VALUES('alice.testnet','round','abcd')`);
    let balance='0', entitlement, sends=0;
    const rpc=async(_,args)=>{
      if (args.request_type==='view_account') return {block_hash:'final',code_hash:guildMissionUpgrade.codeHash};
      const result={get_config:{settlementEnabled:true,settlementSignerId:'settler.testnet',signerEpoch:1},
        get_campaign:{maxAward:'20',remaining:balance,closesAtMs:Date.now()+60_000},
        get_entitlement:entitlement??null}[args.method_name];
      return {result:[...Buffer.from(JSON.stringify(result))]};
    };
    const claim=createGuildMissionRewards({database,rpc,economyId:'economy.testnet',signerId:'settler.testnet',
      transport:{prepare:async call=>call,broadcast:async ({args:{payload}})=>{
        sends++;
        entitlement={status:'reserved',operationId:payload.operationId,accountId:payload.accountId,amountAtomic:payload.amountAtomic};
        throw Error('response timeout after execution');
      }}});
    assert.deepEqual(await claim('alice.testnet'),[]);
    balance='20';
    const [first,second]=await Promise.all([claim('alice.testnet'),claim('alice.testnet')]);
    assert.deepEqual(first,second);
    assert.equal(first[0].source,'guild');
    assert.equal(first[0].amountAtomic,'20');
    assert.equal(sends,1);
    assert.deepEqual(await claim('alice.testnet'),first);
    assert.equal(sends,1);
  } finally { database.close(); }
});
