import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createGasSponsor} from '../../server/near/gas-sponsor.mjs';
test('sponsor rejects default zero budget, spending methods, full access and stale sessions',async t=>{
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  await assert.rejects(createGasSponsor({database}).reserve({}, {maximumCostAtomic:'1'}),/unavailable/);
  assert.throws(()=>createGasSponsor({database,allowlist:{'economy.testnet':['ft_transfer_call']}}),/Unsafe/);
  const valid={network:'near-testnet',permission:'FunctionCall',signatureValid:true,nonceValid:true,maximumCostAtomic:'6',
    accountId:'alice.testnet',receiverId:'economy.testnet',publicKey:'ed25519:'+'A'.repeat(44),nonce:'1',
    issuedAtMs:100,expiresAtMs:1000,actions:[{type:'FunctionCall',method:'claim',gas:'100',deposit:'1'}]};
  let proof=valid;
  const sponsor=createGasSponsor({database,enabled:true,budgetAtomic:'10',maxGas:'100',now:()=>500,
    allowlist:{'economy.testnet':['claim']},verifyDelegate:async()=>proof});
  for(const change of [{permission:'FullAccess'},{expiresAtMs:499},{nonceValid:false},{receiverId:'thief.testnet'},
    {actions:[{type:'FunctionCall',method:'stake',gas:'1',deposit:'0'}]},
    {actions:[{type:'FunctionCall',method:'claim',gas:'101',deposit:'1'}]}]) {
    proof={...valid,...change};await assert.rejects(sponsor.reserve({}, {maximumCostAtomic:'6'}));
  }
  proof=valid;assert.equal((await sponsor.reserve({}, {maximumCostAtomic:'6'})).status,'RESERVED');
  await assert.rejects(sponsor.reserve({}, {maximumCostAtomic:'6'}),/nonce/);
  let signed=0;
  proof={...valid,nonce:'2'};
  await assert.rejects(sponsor.reserve({}, {maximumCostAtomic:'6',prepare:()=>{signed++;}}),/budget/);
  assert.equal(signed,0);
  assert.equal(sponsor.status().reservedAtomic,'6');
});

test('Pool pilot cannot reserve a second registration under a new access key', async t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sponsor = createGasSponsor({ database, enabled: true, budgetAtomic: '100', oneRegistrationPerAccount: true,
    now: () => 500, allowlist: { 'pool.testnet': ['register'] },
    verifyDelegate: async publicKey => ({ network:'near-testnet', permission:'FunctionCall', signatureValid:true,
      nonceValid:true, maximumCostAtomic:'6', accountId:'alice.testnet', receiverId:'pool.testnet',
      publicKey, nonce:'1', issuedAtMs:100, expiresAtMs:1000,
      actions:[{ type:'FunctionCall', method:'register', gas:'100', deposit:'0' }] }) });
  assert.equal(sponsor.canRegister('alice.testnet'), true);
  await sponsor.reserve('ed25519:'+'A'.repeat(44));
  await assert.rejects(sponsor.reserve('ed25519:'+'B'.repeat(44)), /already exists/);
  assert.equal(sponsor.canRegister('alice.testnet'), false);
  assert.equal(sponsor.canRegister('bob.testnet'), true);
  assert.equal(sponsor.status().reservedAtomic, '6');
});
