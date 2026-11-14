import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { KeyPair, utils, transactions } from 'near-api-js';
import { createFixedTransactionTransport } from '../../server/near/transaction-transport.mjs';

test('signer rejects alternate key curves before parsing or reading RPC',async()=>{
  const database=new DatabaseSync(':memory:');
  try {
    await assert.rejects(createFixedTransactionTransport({database,signerId:'signer.testnet',economyId:'economy.testnet',secretKey:'secp256k1:invalid',rpc:()=>{throw Error('must not call');}}),/Ed25519/);
  } finally {database.close();}
});

test('signer shares persisted nonces with explicitly enabled ranking and excludes owner calls', async () => {
  const database = new DatabaseSync(':memory:');
  const secretKey = KeyPair.fromRandom('ed25519').toString();
  const rpc = async method => method === 'status' ? { chain_id: 'testnet' } :
    { nonce: 10, block_hash: utils.serialize.base_encode(new Uint8Array(32)), permission: 'FullAccess' };
  const make = enableRanking => createFixedTransactionTransport({ database, signerId: 'signer.testnet',
    economyId: 'economy.testnet', secretKey, rpc, enableRanking });
  try {
    const transport = await make();
    const call = { method: 'release_fixed_reward', args: { reservation_id: 'op' } };
    const a = await transport.prepare(call);
    const b = await (await make()).prepare(call);
    const decode = value => transactions.SignedTransaction.decode(Buffer.from(value.signedTransaction, 'base64')).transaction;
    assert.equal(decode(a).nonce, 11n);
    assert.equal(decode(b).nonce, 12n);
    assert.equal(decode(a).receiverId, 'economy.testnet');
    assert.notEqual(a.transactionHash, b.transactionHash);
    await assert.rejects(transport.prepare({ method: 'withdraw', args: {} }), /scope/);
    const propose = { method: 'propose_ranking_draft', args: { draft_json: '{}', draft_hash: 'fixture' } };
    await assert.rejects(transport.prepare(propose), /scope/);
    const ranked = await make(true);
    assert.equal(decode(await ranked.prepare(propose)).nonce, 13n);
    await assert.rejects(ranked.prepare({ method: 'publish_ranking_draft', args: {} }), /scope/);
  } finally { database.close(); }
});

test('replacement requires chain expiry proof and identical signed operation', async () => {
  const database = new DatabaseSync(':memory:');
  const blockHash = utils.serialize.base_encode(new Uint8Array(32));
  let height = 110;
  let unavailable = false;
  let chainId = 'testnet';
  let validity = 10;
  const transport = await createFixedTransactionTransport({ database, signerId: 'signer.testnet',
    economyId: 'economy.testnet', secretKey: KeyPair.fromRandom('ed25519').toString(),
    async rpc(method, params) {
      if (unavailable) throw new Error('outage');
      if (method === 'status') return { chain_id: chainId };
      if (method === 'query') return { nonce: 1, block_hash: blockHash, permission: 'FullAccess' };
      if (method === 'EXPERIMENTAL_protocol_config') return { transaction_validity_period: validity };
      if (method === 'block') return { header: { hash: blockHash, height: params.finality ? height : 100 } };
      throw new Error('Unexpected RPC');
    } });
  try {
    const call = { method: 'release_fixed_reward', args: { reservation_id: 'op' } };
    const signed = await transport.prepare(call);
    assert.equal(await transport.canReplace(signed, call), false);
    height = 111;
    assert.equal(await transport.canReplace(signed, call), true);
    assert.equal(await transport.canReplace(signed, { ...call, args: { reservation_id: 'different' } }), false);
    assert.equal(await transport.canReplace({ ...signed, transactionHash: 'A'.repeat(44) }, call), false);
    chainId = 'mainnet';
    assert.equal(await transport.canReplace(signed, call), false);
    chainId = 'testnet';
    validity = undefined;
    assert.equal(await transport.canReplace(signed, call), false);
    validity = 10;
    unavailable = true;
    assert.equal(await transport.canReplace(signed, call), false);
  } finally { database.close(); }
});

test('career signer pays only the bounded append deposit and material signer cannot call owner methods',async()=>{
  const database=new DatabaseSync(':memory:');
  const secretKey=KeyPair.fromRandom('ed25519').toString();
  const rpc=async method=>method==='status'?{chain_id:'testnet'}:
    {nonce:10,block_hash:utils.serialize.base_encode(new Uint8Array(32)),permission:'FullAccess'};
  try {
    const settings={database,signerId:'backend.testnet',economyId:'passport.testnet',secretKey,rpc};
    const career=await createFixedTransactionTransport({...settings,careerDepositAtomic:'20000000000000000000000'});
    const signed=await career.prepare({method:'append_career',args:{record:{eventId:'example'}}});
    const tx=transactions.SignedTransaction.decode(Buffer.from(signed.signedTransaction,'base64')).transaction;
    assert.equal(tx.actions[0].functionCall.deposit,20000000000000000000000n);
    await assert.rejects(career.prepare({method:'rotate_settlement_signer',args:{}}),/scope/);
    await assert.rejects(career.prepare({method:'grant_materials',args:{}}),/scope/);
    const material=await createFixedTransactionTransport({...settings,economyId:'economy.testnet',materialOnly:true});
    await material.prepare({method:'grant_materials',args:{account_id:'alice.testnet',materials:{alloy:4,core:0,catalyst:0},match_id:'m'}});
    await assert.rejects(material.prepare({method:'set_crafting_enabled',args:{enabled:true}}),/scope/);
  }finally{database.close();}
});
