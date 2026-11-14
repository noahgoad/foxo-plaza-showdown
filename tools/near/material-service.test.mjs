import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { KeyPair, InMemorySigner, keyStores, transactions, utils } from 'near-api-js';
import { createMaterialService } from '../../server/near/material-service.mjs';
import { rankingMetricsHash } from '../../server/near/ranking-rubric.mjs';

test('material relay persists exact grant, reconciles timeout, and never pays a duplicate result', async t => {
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  database.exec(`CREATE TABLE near_results(match_id,account_id,result_hash,payload);
    CREATE TABLE near_result_metrics(match_id,account_id,metrics_hash,payload)`);
  const data={matchId:'boss-1',accountId:'alice.testnet',mode:'boss',won:true,left:false,xp:500,
    nft:null,rulesVersion:'near-authoritative-boss-1'};
  const resultHash=createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const result={...data,resultHash,finishedAt:1000};
  const metric={matchId:data.matchId,accountId:data.accountId,mode:data.mode,source:'authoritative-simulation',
    resultHash,rulesVersion:'ranking-fixture',signals:{difficulty:'normal',durationMs:60000,activeMs:50000},finishedAt:1000};
  metric.metricsHash=rankingMetricsHash(metric);
  database.prepare('INSERT INTO near_results VALUES(?,?,?,?)').run(data.matchId,data.accountId,resultHash,JSON.stringify(result));
  database.prepare('INSERT INTO near_result_metrics VALUES(?,?,?,?)').run(data.matchId,data.accountId,metric.metricsHash,JSON.stringify(metric));
  const economyId='economy.testnet',signerId='signer.testnet';
  const pair=KeyPair.fromRandom('ed25519'),store=new keyStores.InMemoryKeyStore();
  await store.setKey('testnet',signerId,pair);
  let prepared=0,sends=0,known=false,transaction,call;
  const receiptId='R'.repeat(44);
  const rpc=async(method,params)=>{
    if(method==='block')return {header:{hash:'B'.repeat(44),timestamp_nanosec:'2000000000'}};
    if(method==='query')return {result:[...Buffer.from(JSON.stringify({grantDay:0,grantedToday:{alloy:0,core:0,catalyst:0}}))]};
    if(!known)throw new Error('unknown inclusion');
    return {final_execution_status:'FINAL',status:{SuccessValue:'dHJ1ZQ=='},
      transaction:{hash:transaction.transactionHash,signer_id:signerId,receiver_id:economyId,
        actions:[{FunctionCall:{method_name:call.method,deposit:'0',args:Buffer.from(JSON.stringify(call.args)).toString('base64')}}]},
      transaction_outcome:{outcome:{status:{SuccessReceiptId:receiptId}}},
      receipts_outcome:[{id:receiptId,outcome:{executor_id:economyId,status:{SuccessValue:'dHJ1ZQ=='}}}]};
  };
  const options={database,economyId,signerId,rpc,verifyDeployment:async()=>{},
    async prepare(value) {
      prepared++;call=value;
      const tx=transactions.createTransaction(signerId,pair.getPublicKey(),economyId,1n,
        [transactions.functionCall(value.method,value.args,100000000000000n,0n)],new Uint8Array(32));
      const [hash,signed]=await transactions.signTransaction(tx,new InMemorySigner(store),signerId,'testnet');
      return transaction={transactionHash:utils.serialize.base_encode(hash),signedTransaction:Buffer.from(signed.encode()).toString('base64')};
    },
    async broadcast(value) {
      sends++;
      assert.equal(database.prepare('SELECT transaction_hash FROM near_material_settlements').get().transaction_hash,value.transactionHash);
      throw new Error('transport timeout');
    },
  };
  const errors=[];
  await createMaterialService(options).tick({onError:e=>errors.push(e.message)});
  assert.equal(prepared,1);assert.equal(sends,1);
  assert.deepEqual(call.args.materials,{alloy:4,core:1,catalyst:0});
  known=true;
  await createMaterialService(options).tick({onError:e=>errors.push(e.message)});
  await createMaterialService(options).tick({onError:e=>errors.push(e.message)});
  assert.equal(prepared,1);assert.equal(sends,1);
  assert.equal(database.prepare('SELECT receipt_id FROM near_material_settlements').get().receipt_id,receiptId);
  assert.deepEqual(errors,[]);
});
