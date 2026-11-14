import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'near-workspaces';
import near from 'near-api-js';
import { createHash } from 'node:crypto';
const gas='100000000000000', yocto='1', unit=10n**24n;

async function sponsoredRegister(worker, sponsor, player, pool) {
  const { KeyPair, transactions, utils } = near;
  const key = KeyPair.fromRandom('ed25519');
  const publicKey = key.getPublicKey();
  const added = await player.batch(player).addKey(publicKey, transactions.functionCallAccessKey(pool.accountId, ['register'], 1n)).transact();
  assert.equal(added.succeeded, true);
  const account = await sponsor.getKey();
  const sponsorKey = account.getPublicKey();
  const getKey = (accountId, public_key) => worker.provider.query({
    request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: public_key.toString(),
  });
  const [scoped, payer, final] = await Promise.all([
    getKey(player.accountId, publicKey), getKey(sponsor.accountId, sponsorKey), worker.provider.block({ finality: 'final' }),
  ]);
  assert.equal(scoped.permission.FunctionCall.allowance, '1');
  const delegateAction = {
    senderId: player.accountId, receiverId: pool.accountId, publicKey,
    nonce: BigInt(scoped.nonce) + 1n, maxBlockHeight: BigInt(final.header.height) + 25n,
    actions: [transactions.functionCall('register', {}, 20_000_000_000_000n, 0n)],
  };
  const digest = createHash('sha256').update(transactions.encodeDelegateAction(delegateAction)).digest();
  const action = new transactions.Action({ signedDelegate: {
    delegateAction, signature: new transactions.Signature({ keyType: utils.key_pair.KeyType.ED25519, data: key.sign(digest).signature }),
  } });
  const outer = transactions.createTransaction(sponsor.accountId, sponsorKey, player.accountId,
    BigInt(payer.nonce) + 1n, [action], utils.serialize.base_decode(payer.block_hash));
  const signature = new transactions.Signature({ keyType: utils.key_pair.KeyType.ED25519,
    data: account.sign(createHash('sha256').update(outer.encode()).digest()).signature });
  const signed = new transactions.SignedTransaction({ transaction: outer, signature });
  const receipt = await worker.provider.sendTransaction(signed);
  assert.equal(typeof receipt.status.SuccessValue, 'string', JSON.stringify(receipt.status));
  const outerReceiptId = receipt.transaction_outcome.outcome.status.SuccessReceiptId;
  const delegated = receipt.receipts_outcome.find(row => row.id === outerReceiptId && row.outcome.executor_id === player.accountId);
  const target = receipt.receipts_outcome.find(row => delegated?.outcome.receipt_ids.includes(row.id) &&
    row.outcome.executor_id === pool.accountId && typeof row.outcome.status.SuccessValue === 'string');
  assert.ok(target, 'a successful receipt must belong to the Pool and descend from the delegated action');
  assert.equal((await pool.view('get_position', { account_id: player.accountId })).registered, true);
}
test('funded pool preserves principal through stake, accrual, reward and withdrawal',async()=>{
  const worker=await Worker.init();
  try {
    const root=worker.rootAccount;
    const token=await root.createSubAccount('token'),pool=await root.createSubAccount('pool');
    const alice=await root.createSubAccount('alice'),bob=await root.createSubAccount('bob');
    await token.deploy('/wasm/sandbox_mock_ft.wasm');await pool.deploy('/wasm/near_pool.wasm');
    await root.call(token,'new',{owner_id:root.accountId,supply:String(200000n*unit)});
    await root.call(pool,'new',{owner_id:root.accountId,token_id:token.accountId,receipt_signer_id:root.accountId});
    for(const account of [pool,alice])await root.call(token,'storage_deposit',{account_id:account.accountId},{attachedDeposit:'12500000000000000000000'});
    await root.call(token,'ft_transfer',{receiver_id:alice.accountId,amount:String(100000n*unit)},{attachedDeposit:yocto});
    const transfer=(actor,amount,action)=>actor.call(token,'ft_transfer_call',{receiver_id:pool.accountId,amount:String(amount),msg:JSON.stringify({action})},{attachedDeposit:yocto,gas});
    await transfer(root,1500n*unit,'fund_reward');
    const block=await root.provider.block({finality:'final'}),now=Math.floor(Number(block.header.timestamp_nanosec)/1000000);
    await assert.rejects(bob.call(pool,'record_boss_clear',{account_id:bob.accountId,match_id:'fake',finished_at_ms:now}),/Only receipt signer/);
    await root.call(pool,'open_campaign',{starts_at_ms:now+60000});
    await root.call(pool,'record_boss_clear',{account_id:alice.accountId,match_id:'boss-1',finished_at_ms:now});
    assert.equal(await pool.view('get_boss_clear',{account_id:alice.accountId,match_id:'boss-1'}),now);
    assert.equal(await pool.view('get_boss_clear',{account_id:bob.accountId,match_id:'fake'}),null);
    await assert.rejects(bob.call(pool,'register',{}),/Boss clear required/);
    await worker.provider.fastForward(150);
    await sponsoredRegister(worker, root, alice, pool);
    await transfer(alice,100000n*unit,'stake');
    assert.equal((await pool.view('get_position',{account_id:alice.accountId})).principal,String(100000n*unit));
    await worker.provider.fastForward(150);
    const position=await pool.view('get_position',{account_id:alice.accountId});
    assert.ok(BigInt(position.accrued_reward)>0n);
    await alice.call(pool,'claim',{}, {attachedDeposit:yocto,gas});
    await alice.call(pool,'withdraw',{amount:String(100000n*unit)},{attachedDeposit:yocto,gas});
    const state=await pool.view('get_pool');
    assert.equal(state.principal,'0');assert.equal(state.principal_in_flight,'0');assert.equal(state.reward_in_flight,'0');
    assert.ok(BigInt(state.reward_paid)>0n);
    assert.equal(BigInt(state.reward_available)+BigInt(state.reward_reserved)+BigInt(state.reward_paid),1500n*unit);
    assert.ok(BigInt(await token.view('ft_balance_of',{account_id:alice.accountId}))>=100000n*unit);
    await assert.rejects(alice.call(pool,'withdraw',{amount:'1'},{attachedDeposit:yocto,gas}),/Invalid withdrawal/);
  } finally {await worker.tearDown();}
});
