import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './crafting-wasm.test.mjs';
const owner='operator.testnet', signer='signer.testnet', seller='alice.testnet', buyer='bob.testnet', token='foxo.testnet';
const now=100*86400000, deposit=10n**23n;
async function setup(options){
 const logs=[],call=await fixture(logs,options);
 call('new',{owner_id:owner,foxo_contract_id:token,network:'near-testnet',settlement_signer_id:signer},owner);
 call('set_crafting_enabled',{enabled:true},owner);
 call('add_recipe',{recipe:{recipeId:'finish',version:1,sku:'finish-violet',inputs:{alloy:1,core:0,catalyst:0},feeAtomic:'1'}},owner);
 call('grant_materials',{account_id:seller,match_id:'loot',materials:{alloy:1,core:0,catalyst:0}},signer);
 call('ft_on_transfer',{sender_id:seller,amount:'1',msg:JSON.stringify({action:'craft',operationId:'one',recipeId:'finish',recipeVersion:1})},token);
 return {call,logs,item:seller+':one'};
}
function listing(call,item,operation='sale'){return call('create_cosmetic_sale',{operation_id:operation,item_id:item,expected_transfer_version:call('get_cosmetic_item_version',{item_id:item}),price_atomic:'10001',expires_at_ms:now+10000},seller,deposit);}
function buy(call,sale,who=buyer,operation='buy',extra={}){return call('ft_on_transfer',{sender_id:who,amount:'10001',msg:JSON.stringify({action:'buy_sale',operationId:operation,saleId:sale,...extra})},token);}
test('cosmetic sale is off by default, single asset, delivered before 250bps credit and rejects a second payment',async()=>{
 const {call,logs,item}=await setup();
 assert.throws(()=>listing(call,item),/paused/);
 assert.throws(()=>call('set_sales_enabled',{enabled:true},buyer),/owner/);
 call('set_sales_enabled',{enabled:true},owner);
 const sale=listing(call,item);
 assert.equal(sale,seller+':sale');
 assert.equal(buy(call,sale,seller),'10001');
 assert.equal(buy(call,sale,buyer,'bundle',{assets:[item]}),'10001');
 assert.equal(buy(call,sale),'0');
 assert.equal(call('get_item',{item_id:item}).ownerId,buyer);
 assert.equal(call('get_order_credit',{account_id:seller}),'9751');
 assert.equal(call('get_order_ledger',{}).marketFees,'250');
 assert.equal(call('get_cosmetic_sale',{sale_id:sale}).status,'sold');
 assert.equal(call('get_cosmetic_sale',{sale_id:sale}).purchaseOperationId,'buy');
 assert.equal(call('get_cosmetic_purchase',{account_id:buyer,operation_id:'buy'}),sale);
 assert.equal(call('get_cosmetic_purchase',{account_id:buyer,operation_id:'missing'}),null);
 assert.equal(buy(call,sale),'10001');
 assert.equal(buy(call,sale,'carol.testnet','race'),'10001');
 assert.equal(call('get_order_credit',{account_id:seller}),'9751');
 assert.ok(logs.some(x=>x.includes('cosmetic_sale_filled')));
});
test('cancel works while paused without charging principal, cancelled listings refund all FT',async()=>{
 const {call,item}=await setup();call('set_sales_enabled',{enabled:true},owner);
 const sale=listing(call,item);call('set_sales_enabled',{enabled:false},owner);
 assert.throws(()=>call('cancel_cosmetic_sale',{sale_id:sale},buyer,1n),/seller/);
 call('cancel_cosmetic_sale',{sale_id:sale},seller,1n);
 assert.equal(call('get_item',{item_id:item}).ownerId,seller);
 assert.equal(buy(call,sale),'10001');
 assert.equal(call('get_order_ledger',{}).marketFees,'0');
 call('set_sales_enabled',{enabled:true},owner);
 assert.throws(()=>call('create_cosmetic_sale',{operation_id:'expired',item_id:item,expected_transfer_version:call('get_cosmetic_item_version',{item_id:item}),price_atomic:'10001',expires_at_ms:now},seller,deposit),/expiry/);
 assert.throws(()=>listing(call,item,'sale'),/exists/);
 assert.throws(()=>call('create_cosmetic_sale',{operation_id:'cheap',item_id:item,expected_transfer_version:call('get_cosmetic_item_version',{item_id:item}),price_atomic:'10001',expires_at_ms:now+10},seller,1n),/storage/);
});

test('expiry boundary refunds all principal without consuming the buyer operation',async()=>{
 let timestamp=now;
 const {call,item}=await setup({nowMs:()=>timestamp});
 call('set_sales_enabled',{enabled:true},owner);
 const sale=listing(call,item);
 timestamp=now+10000;
 assert.equal(buy(call,sale),'10001');
 assert.equal(call('get_order_credit',{account_id:seller}),'0');
 const fresh=call('create_cosmetic_sale',{operation_id:'fresh',item_id:item,expected_transfer_version:call('get_cosmetic_item_version',{item_id:item}),price_atomic:'10001',expires_at_ms:timestamp+100},seller,deposit);
 assert.equal(buy(call,fresh),'0');
});

async function migrate(call,item){
 call('set_crafting_enabled',{enabled:false},owner);
 const manifest='a'.repeat(64),zero={alloy:0,core:0,catalyst:0};
 call('begin_mt_migration',{manifest_hash:manifest},owner);
 call('import_mt_account',{account_id:seller,expected_available:zero,expected_reserved:zero,expected_consumed:{alloy:1,core:0,catalyst:0},expected_item_ids:[item]},owner);
 call('finalize_mt_migration',{manifest_hash:manifest,expected_accounts:1,expected_supply:['0','0','0'],expected_items:1},owner);
 call('set_mt_enabled',{enabled:true},owner);
 call('storage_deposit',{account_id:seller},seller,10n**24n);
}

test('MT delivery failure rolls back sale and money; successful delivery shares retryable seller payout credits',async()=>{
 const {call,item}=await setup();await migrate(call,item);
 call('set_sales_enabled',{enabled:true},owner);
 const sale=listing(call,item);
 assert.throws(()=>buy(call,sale),/register MT storage/);
 assert.equal(call('get_cosmetic_sale',{sale_id:sale}).status,'open');
 assert.equal(call('get_order_credit',{account_id:seller}),'0');
 assert.equal(call('get_order_ledger',{}).marketFees,'0');
 assert.equal(call('get_item',{item_id:item}).ownerId,seller);
 call('storage_deposit',{account_id:buyer},buyer,10n**24n);
 assert.equal(buy(call,sale),'0');
 assert.equal(call('mt_balance_of',{account_id:buyer,token_id:'item:'+item}),'1');
 call('withdraw_order_credit',{},seller,1n);
 const contract='economy.operator.testnet';
 assert.equal(call('finish_order_payout',{payout_id:0},contract,0n,contract,false),false);
 assert.equal(call('get_order_credit',{account_id:seller}),'9751');
 call('withdraw_order_credit',{},seller,1n);
 assert.equal(call('finish_order_payout',{payout_id:1},contract,0n,contract,true),true);
 assert.equal(call('get_order_credit',{account_id:seller}),'0');
 assert.equal(call('get_order_ledger',{}).marketFees,'250');
});

test('MT transfers invalidate old listings even when the original owner receives the item back',async()=>{
 const {call,item}=await setup();await migrate(call,item);
 call('storage_deposit',{account_id:buyer},buyer,10n**24n);
 call('set_sales_enabled',{enabled:true},owner);
 const sale=listing(call,item),args={token_id:'item:'+item,amount:'1'};
 call('mt_transfer',{...args,receiver_id:buyer},seller,1n);
 assert.equal(buy(call,sale),'10001');
 call('mt_transfer',{...args,receiver_id:seller},buyer,1n);
 assert.equal(buy(call,sale),'10001');
 assert.throws(()=>call('create_cosmetic_sale',{
  operation_id:'stale-review',item_id:item,expected_transfer_version:0,
  price_atomic:'10001',expires_at_ms:now+10000
 },seller,deposit),/Cosmetic transfer version changed/);
 assert.equal(call('get_cosmetic_sale',{sale_id:seller+':stale-review'}),null);
 const fresh=listing(call,item,'fresh');
 assert.equal(buy(call,fresh),'0');
 assert.equal(call('get_order_credit',{account_id:seller}),'9751');
});
