import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCareerChain} from '../../server/near/career-chain.mjs';

test('career adapter persists signed bytes, checks final transaction and exact chain record',async t=>{
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  const record={network:'near-testnet',contractId:'passport.testnet',eventId:'event',xp:12};
  let prepared=0,sent=0,final=false,bad=false;
  const txHash='A'.repeat(44),receiptId='B'.repeat(44);
  const options={database,network:'near-testnet',contractId:record.contractId,signerId:'signer.testnet',storageDepositAtomic:'100',
    prepare:async()=>{prepared++;return {transactionHash:txHash,signedTransaction:'YWJj'};},
    broadcast:async()=>{sent++;assert.equal(database.prepare('SELECT transaction_id FROM near_career_transactions').get().transaction_id,txHash);throw new Error('timeout');},
    rpc:async method=>{
      if(method==='status')return {chain_id:'testnet'};
      if(method==='query')return {result:[...Buffer.from(JSON.stringify({...record,xp:bad?999:record.xp}))],block_hash:'final',block_height:10};
      if(!final)throw new Error('not finalized');
      return {final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:txHash,signer_id:'signer.testnet',receiver_id:record.contractId,
        actions:[{FunctionCall:{method_name:'append_career',deposit:'100',args:Buffer.from(JSON.stringify({record})).toString('base64')}}]},
        transaction_outcome:{outcome:{status:{SuccessReceiptId:receiptId}}},receipts_outcome:[{id:receiptId,outcome:{executor_id:record.contractId,status:{SuccessValue:''}}}]};
    }};
  const entry={operationId:'event',record};
  assert.equal((await createCareerChain(options).submit(entry)).transactionId,txHash);
  assert.equal((await createCareerChain(options).reconcile(entry)).status,'UNKNOWN');
  await createCareerChain(options).submit(entry);
  assert.equal(prepared,1);assert.equal(sent,2);
  final=true;bad=true;
  assert.equal((await createCareerChain(options).reconcile(entry)).status,'UNKNOWN');
  bad=false;
  assert.equal((await createCareerChain(options).reconcile(entry)).status,'FINALIZED');
});
