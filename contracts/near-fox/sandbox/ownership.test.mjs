import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'near-workspaces';

test('ownership extension keeps prior NFT state and observes an unpolled owner round trip',async()=>{
  const worker=await Worker.init();
  try {
    const root=worker.rootAccount;
    const fox=await root.createSubAccount('fox');
    const alice=await root.createSubAccount('alice');
    const bob=await root.createSubAccount('bob');
    await fox.deploy('/wasm/legacy_fox.wasm');
    await root.call(fox,'new',{owner_id:root.accountId});
    for(const id of ['001','045','088']) {
      await root.call(fox,'nft_mint',{token_id:id,receiver_id:alice.accountId,
        token_metadata:{title:'Fox #'+id,media:'https://example.com/'+id+'.png',
          media_hash:Buffer.alloc(32).toString('base64'),copies:1}},
        {attachedDeposit:'100000000000000000000000'});
    }
    await alice.call(fox,'nft_approve',{token_id:'045',account_id:bob.accountId},
      {attachedDeposit:'10000000000000000000000'});
    const previous=await fox.view('nft_tokens',{from_index:'0',limit:88});
    await fox.deploy('/wasm/epoch_fox.wasm');
    assert.deepEqual(await fox.view('nft_tokens',{from_index:'0',limit:88}),previous);
    assert.equal(await fox.view('nft_total_supply',{}),'3');
    assert.equal(await fox.view('get_ownership_epoch',{token_id:'045'}),'0');
    await alice.call(fox,'nft_transfer',{receiver_id:bob.accountId,token_id:'045'},{attachedDeposit:'1'});
    await bob.call(fox,'nft_transfer',{receiver_id:alice.accountId,token_id:'045'},{attachedDeposit:'1'});
    assert.equal((await fox.view('nft_token',{token_id:'045'})).owner_id,alice.accountId);
    assert.equal(await fox.view('get_ownership_epoch',{token_id:'045'}),'2');
    assert.equal(await fox.view('get_ownership_epoch',{token_id:'088'}),'0');
    await assert.rejects(bob.call(fox,'nft_transfer',{receiver_id:bob.accountId,token_id:'045'},{attachedDeposit:'1'}));
    assert.equal(await fox.view('get_ownership_epoch',{token_id:'045'}),'2');
  } finally {await worker.tearDown();}
});
