import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { KeyPair, InMemorySigner, keyStores, transactions, utils } from 'near-api-js';
import { createRankingDrafts } from '../../server/near/ranking.mjs';
import { createRankingDispatch, createRankingReceiptVerifier } from '../../server/near/ranking-dispatch.mjs';

const DAY=86_400_000, signerId='signer.testnet', economyId='economy.testnet';
const key={campaignId:'season',mode:'hunt',budgetDay:'1970-01-01'};
const accountId='alice.testnet';
const receiptId='R'.repeat(44);
async function setup() {
  const database=new DatabaseSync(':memory:');
  const config=JSON.parse(readFileSync(new URL('../../config/economy.testnet.json',import.meta.url)));
  config.ranking.enabledModes=['hunt']; // Isolated fixture; production remains disabled.
  const drafts=createRankingDrafts({database,config,now:()=>DAY});
  const saved=drafts.prepare({campaignId:key.campaignId,mode:key.mode,seasonStartMs:0,dayIndex:0,
    rubricVersion:'fixture-v1',evidenceHash:'a'.repeat(64),entries:[{accountId,scoreAtomic:'1000000'}]});
  const store=new keyStores.InMemoryKeyStore();
  const pair=KeyPair.fromRandom('ed25519');await store.setKey('testnet',signerId,pair);
  const signer=new InMemorySigner(store);
  const record={draft:saved.draft,draftJson:JSON.stringify(saved.draft),draftHash:saved.hash,
    proposedAtMs:DAY,reviewAfterMs:2*DAY,publishedAtMs:null};
  const state={record,receipt:null,available:false,prepared:0,sent:[],mutation:null};
  const operationId='ranking:'+ 'a'.repeat(64);
  const entitlement={operationId,accountId,amountAtomic:saved.draft.allocations[0].amountAtomic,status:'reserved',attempt:0};
  const rpc=async (method,params)=>{
    if(method==='status')return {chain_id:'testnet'};
    if(method==='tx')return state.available?state.receipt:{};
    if(method==='query') {
      if(params.method_name==='get_campaign') {
        const {campaign_id}=JSON.parse(Buffer.from(params.args_base64,'base64'));
        return {result:[...Buffer.from(JSON.stringify(state.campaigns?.[campaign_id]??null))]};
      }
      const result=params.method_name==='get_ranking_draft'?state.record:
        params.method_name==='get_ranking_allocation_id'?operationId:entitlement;
      return {result:[...Buffer.from(JSON.stringify(result))]};
    }
    throw new Error('unexpected RPC '+method);
  };
  async function prepare(call) {
    state.prepared++;
    const tx=transactions.createTransaction(signerId,pair.getPublicKey(),economyId,BigInt(state.prepared),
      [transactions.functionCall(call.method,call.args,100_000_000_000_000n,0n)],new Uint8Array(32));
    const [hash,signed]=await transactions.signTransaction(tx,signer,signerId,'testnet');
    return {transactionHash:utils.serialize.base_encode(hash),signedTransaction:Buffer.from(signed.encode()).toString('base64')};
  }
  function receipt(transaction,call) {
    const result=call.method==='propose_ranking_draft'?state.record:entitlement;
    return {final_execution_status:'FINAL',status:{SuccessValue:Buffer.from(JSON.stringify(result)).toString('base64')},
      transaction:{hash:transaction.transactionHash,signer_id:signerId,receiver_id:economyId,actions:[{FunctionCall:{method_name:call.method,deposit:'0',args:Buffer.from(JSON.stringify(call.args)).toString('base64')}}]},
      transaction_outcome:{outcome:{status:{SuccessReceiptId:receiptId}}},
      receipts_outcome:[{id:receiptId,outcome:{executor_id:economyId,status:{SuccessValue:Buffer.from(JSON.stringify(result)).toString('base64')}}}]};
  }
  const open=(canReplace)=>createRankingDispatch({database,drafts,economyId,signerId,prepare,rpc,canReplace,
    async broadcast(transaction) {
      const persisted=database.prepare('SELECT signed_transaction FROM near_ranking_transactions WHERE transaction_hash=?').get(transaction.transactionHash);
      assert.equal(persisted.signed_transaction,transaction.signedTransaction);
      state.sent.push(transaction);
      const signed=transactions.SignedTransaction.decode(Buffer.from(transaction.signedTransaction,'base64'));
      const fn=signed.transaction.actions[0].functionCall;
      state.receipt=receipt(transaction,{method:fn.methodName,args:JSON.parse(Buffer.from(fn.args))});
      if(!state.available)throw new Error('network timeout');
    }});
  return {database,drafts,saved,state,open,prepare,rpc,receipt,entitlement};
}

test('ranking persists signed proposal before broadcast and reconciles the exact hash after restart',async()=>{
  const f=await setup();
  try {
    assert.equal(await f.open().propose(key),null);
    assert.equal(f.state.prepared,1);
    const unknown=f.state.sent[0];
    assert.equal(await f.open().propose(key),null);
    assert.deepEqual(f.state.sent,[unknown,unknown]);
    f.state.available=true;
    const result=await f.open().propose(key);
    assert.equal(result.status,'proposed');
    assert.equal(result.transactionHash,unknown.transactionHash);
    assert.equal(f.state.prepared,1);
    assert.equal(f.state.sent.length,2);
    assert.deepEqual(await f.open().claimsForAccount(accountId),[]);
  } finally {f.database.close();}
});

test('backend never publishes, materializes only verified publication and exposes finalized ranking claims',async()=>{
  const f=await setup();
  try {
    assert.equal(await f.open().finalize({...key,accountId}),null);
    assert.equal(f.state.prepared,0);
    f.state.record.publishedAtMs=2*DAY;
    f.state.available=true;
    const result=await f.open().finalize({...key,accountId});
    assert.equal(result.status,'finalized');
    assert.equal(f.state.prepared,1);
    const call=transactions.SignedTransaction.decode(Buffer.from(f.state.sent[0].signedTransaction,'base64')).transaction.actions[0].functionCall;
    assert.equal(call.methodName,'finalize_ranking_allocation');
    const claims=await f.open().claimsForAccount(accountId);
    assert.equal(claims.length,1);
    assert.equal(claims[0].source,'ranking');
    assert.equal(claims[0].operationId,f.entitlement.operationId);
    assert.equal(claims[0].amountAtomic,f.entitlement.amountAtomic);
    assert.equal(claims[0].receiptId,receiptId);
    assert.deepEqual(await f.open().claimsForAccount('other.testnet'),[]);
    f.state.record.publishedAtMs=null;
    assert.deepEqual(await f.open().claimsForAccount(accountId),[]);
  } finally {f.database.close();}
});

test('relay skips unavailable campaigns and proposes a compatible enabled draft',async()=>{
  const f=await setup();
  try {
    const second=f.drafts.prepare({campaignId:'season-two',mode:key.mode,seasonStartMs:0,dayIndex:0,
      rubricVersion:'fixture-v1',evidenceHash:'a'.repeat(64),entries:[{accountId,scoreAtomic:'1000000'}]});
    f.state.record={...f.state.record,draft:second.draft,draftHash:second.hash,draftJson:JSON.stringify(second.draft)};
    f.state.campaigns={'season-two':{closed:false,closesAtMs:28*DAY,maxAward:'6250000000000000000000000'}};
    f.state.available=true;
    const ranking=f.open();
    assert.equal(await ranking.submitNextDraft([]),null);
    assert.equal(await ranking.submitNextDraft(['hunt']),null);
    assert.equal(f.state.prepared,0);
    assert.equal((await ranking.submitNextDraft(['hunt'])).status,'proposed');
    assert.equal(await ranking.submitNextDraft(['hunt']),null);
    assert.equal(f.state.prepared,1);
  }finally{f.database.close();}
});

test('claim discovery materializes only the requesting account after owner publication',async()=>{
  const f=await setup();
  try {
    const ranking=f.open();
    f.state.available=true;
    assert.equal((await ranking.propose(key)).status,'proposed');
    await ranking.materializeForAccount(accountId);
    assert.equal(f.state.prepared,1);
    f.state.record.publishedAtMs=2*DAY;
    await ranking.materializeForAccount('other.testnet');
    assert.equal(f.state.prepared,1);
    await ranking.materializeForAccount(accountId);
    assert.equal((await ranking.claimsForAccount(accountId)).length,1);
    await ranking.materializeForAccount(accountId);
    assert.equal(f.state.prepared,2);
  }finally{f.database.close();}
});

test('ranking replaces an expired transaction and preserves both signed attempts',async()=>{
  const f=await setup();
  try {
    await f.open().propose(key);
    const original=f.state.sent[0];
    const reopened=f.open(async (previous,call)=>{
      assert.equal(previous.transactionHash,original.transactionHash);
      assert.equal(call.method,'propose_ranking_draft');
      assert.equal(call.args.draft_hash,f.saved.hash);
      return true;
    });
    await reopened.recover();
    const replacement=f.state.sent[1];
    assert.notEqual(replacement.transactionHash,original.transactionHash);
    const attempts=f.database.prepare('SELECT transaction_hash FROM near_ranking_transaction_attempts').all();
    assert.deepEqual(new Set(attempts.map(row=>row.transaction_hash)),new Set([
      original.transactionHash,replacement.transactionHash,
    ]));
    f.state.available=true;
    assert.equal((await f.open().propose(key)).transactionHash,replacement.transactionHash);
    assert.equal(f.state.prepared,2);
  } finally {f.database.close();}
});

test('receipt verifier rejects wrong call, hash, receiver, signer, nonfinal receipt and mismatched view',async()=>{
  const f=await setup();
  try {
    const call={method:'propose_ranking_draft',args:{draft_json:JSON.stringify(f.saved.draft),draft_hash:f.saved.hash}};
    const transaction=await f.prepare(call);
    const verify=createRankingReceiptVerifier({economyId,signerId,rpc:f.rpc});
    const original=f.receipt(transaction,call);f.state.available=true;
    for(const mutate of [r=>r.transaction.hash='B'.repeat(44),r=>r.transaction.receiver_id='evil.testnet',r=>r.transaction.signer_id='evil.testnet',
      r=>r.final_execution_status='EXECUTED_OPTIMISTIC',r=>r.transaction.actions[0].FunctionCall.method_name='publish_ranking_draft',
      r=>r.receipts_outcome[0].outcome.executor_id='evil.testnet',r=>r.receipts_outcome[0].outcome.status={Failure:{}},
      r=>r.transaction.actions.push(r.transaction.actions[0])]) {
      f.state.receipt=structuredClone(original);mutate(f.state.receipt);
      assert.equal(await verify({call,transaction,draft:f.saved}),null);
    }
    f.state.receipt=original;
    assert.equal((await verify({call,transaction,draft:f.saved})).status,'proposed');
    f.state.record.draftHash='b'.repeat(64);
    assert.equal(await verify({call,transaction,draft:f.saved}),null);
  } finally {f.database.close();}
});
