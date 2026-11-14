import test from 'node:test';
import assert from 'node:assert/strict';
import { foxoAmount, poolCall, readPoolSnapshot } from '../../src/economy/near-pool.js';

test('pool amount preserves atomic precision and rejects malformed or overflowing amounts', () => {
  assert.equal(foxoAmount('1.000000000000000000000001'), '1000000000000000000000001');
  for (const value of ['0','-1','1e3','01','1.','1.0000000000000000000000001','9'.repeat(40)]) assert.throws(() => foxoAmount(value));
});
test('pool calls separate stake token, principal withdrawal and reward claim', () => {
  const options = { poolId: 'pool.testnet', tokenId: 'foxo.testnet', amount: '123' };
  assert.equal(poolCall({ ...options, action:'stake' }).receiverId, 'foxo.testnet');
  assert.deepEqual(JSON.parse(poolCall({ ...options, action:'stake' }).args.msg), {action:'stake'});
  assert.equal(poolCall({ ...options, action:'register' }).deposit, 0n);
  assert.equal(poolCall({ ...options, action:'withdraw' }).receiverId, 'pool.testnet');
  assert.throws(() => poolCall({ ...options, action:'fund_reward' }));
});
test('pool snapshot pins views to one finalized block and rejects changed token', async () => {
  const calls = [];
  const options = { deployment:{accountId:'pool.testnet', codeHash:'hash', receiptSignerId:'signer.testnet'}, tokenId:'foxo.testnet',account:'alice.testnet',
    readCode:async()=>({codeHash:'hash',blockHash:'final'}),
    view: async (_, method, args, settings) => {
      calls.push({method,args,settings});
      if (method === 'get_config') return {blockHash:'final',value:{tokenId:'foxo.testnet',receiptSignerId:'signer.testnet'}};
      if (method === 'get_position') return {blockHash:'final',value:{principal:'2',accrued_reward:'1'}};
      return {blockHash:'final',value:Object.fromEntries(['principal','principal_in_flight','reward_available','reward_reserved','reward_in_flight','reward_paid'].map(key=>[key,'0']))};
    }};
  assert.equal((await readPoolSnapshot(options)).position.principal,'2');
  assert.deepEqual(calls.slice(1).map(call=>call.settings),[{blockId:'final'},{blockId:'final'}]);
  await assert.rejects(readPoolSnapshot({...options,tokenId:'other.testnet'}),/mismatch/);
  await assert.rejects(readPoolSnapshot({...options,readCode:async()=>({codeHash:'changed',blockHash:'final'})}),/hash mismatch/);
});
