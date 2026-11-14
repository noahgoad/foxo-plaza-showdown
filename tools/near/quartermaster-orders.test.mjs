import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFundedQuartermasterOrders,readPublishedQuartermasterOrders,quartermasterStorageDeposit} from '../../server/near/quartermaster-orders.mjs';

test('Quartermaster storage quote covers only the shortfall and first registration',()=>{
 assert.equal(quartermasterStorageDeposit({charge:'81920',credit:'0',registration:'10240'}),'92160');
 assert.equal(quartermasterStorageDeposit({charge:'81920',credit:'81919',registration:'0'}),'1');
 assert.equal(quartermasterStorageDeposit({charge:'81920',credit:'81920',registration:'0'}),'0');
});
test('sponsored order persists signed bytes, requires actual escrow proof, and publishes its source once',async t=>{
 const database=new DatabaseSync(':memory:');t.after(()=>database.close());
 const recipe={sku:'finish-a',recipeId:'finish',recipeVersion:1,enabled:true,transferability:'tradable'};
 const terms={operationId:'op',proposal:{sku:'finish-a',quantity:2,priceAtomic:'5',expiresAtMs:2000},totalAtomic:'10',source:'Sponsored',fundingId:'sponsor'};
 let prepared=0,sent=0,final=false,bad=false,args;
 const txHash='A'.repeat(44),receiptId='B'.repeat(44);
 const options={database,economyId:'economy.testnet',economyCodeHash:'verified',tokenId:'foxo.testnet',buyerId:'npc.testnet',catalogue:[recipe],now:()=>1000,
  prepare:async call=>{prepared++;args=call.args;assert.equal(call.receiverId,'foxo.testnet');assert.equal(call.deposit,'1');return {transactionHash:txHash,signedTransaction:'YWJj'};},
  broadcast:async()=>{sent++;assert.equal(database.prepare('SELECT signed_bytes FROM near_quartermaster_transactions').get().signed_bytes,'YWJj');throw Error('timeout');},
  rpc:async(method,params)=>{
   if(method==='status')return {chain_id:'testnet'};
   if(method==='query') {
    if(params.request_type==='view_account')return {code_hash:'verified',block_hash:'block'};
    if(params.method_name?.startsWith('get_order_storage_'))return {block_hash:'block',block_height:2,result:[...Buffer.from(JSON.stringify('100'))]};
    const value=params.method_name==='get_recipe'?{sku:'finish-a',recipeId:'finish',version:1}:{buyerId:'npc.testnet',recipeId:'finish',recipeVersion:1,unitPrice:bad?'999':'5',expiresAtMs:2000,remaining:2};
    return {block_hash:'block',block_height:2,result:[...Buffer.from(JSON.stringify(value))]};
   }
   if(!final)throw Error('unknown');
   return {final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:txHash,signer_id:'npc.testnet',receiver_id:'foxo.testnet',actions:[{FunctionCall:{method_name:'ft_transfer_call',deposit:'1',args:Buffer.from(JSON.stringify(args)).toString('base64')}}]},
    receipts_outcome:[{id:receiptId,outcome:{executor_id:'economy.testnet',status:{SuccessValue:''},logs:['EVENT_JSON:'+JSON.stringify({standard:'fox_economy',event:'order_funded',data:[{orderId:'npc.testnet:op',accountId:'npc.testnet',amountAtomic:'10'}]})]}}]};
  }};
 let adapter=createFundedQuartermasterOrders(options);
 assert.equal((await adapter.reserve(terms)).status,'UNKNOWN');
 adapter=createFundedQuartermasterOrders(options);final=true;bad=true;
 assert.equal((await adapter.reconcile(terms)).status,'UNKNOWN');
 bad=false;const receipt=await adapter.reconcile(terms);assert.equal(receipt.status,'FINALIZED');
 await adapter.publish({...terms,receipt});await adapter.publish({...terms,receipt});
 assert.equal(prepared,1);assert.equal(sent,2);assert.equal(adapter.list().length,1);assert.equal(adapter.list()[0].source,'Sponsored');
 assert.deepEqual(readPublishedQuartermasterOrders(database).map(row=>({...row})),[
  {orderId:'npc.testnet:op',source:'Sponsored'},
 ]);
 await assert.rejects(adapter.reserve({...terms,totalAtomic:'11'}),/collision/);
 const disabled=createFundedQuartermasterOrders({...options,catalogue:[{...recipe,enabled:false}]});
 await assert.rejects(disabled.reserve({...terms,operationId:'other'}),/Unsupported/);
});
