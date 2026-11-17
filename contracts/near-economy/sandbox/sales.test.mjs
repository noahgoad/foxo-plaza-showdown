import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'near-workspaces';
const unit=10n**24n,gas='100000000000000',one='1';
test('fixed cosmetic sale delivers before net credit and real FT resolver refunds duplicate, stale and failed delivery',async()=>{
 const worker=await Worker.init();try{
  const root=worker.rootAccount,token=await root.createSubAccount('token'),economy=await root.createSubAccount('economy'),seller=await root.createSubAccount('seller'),buyer=await root.createSubAccount('buyer');
  await token.deploy('/wasm/sandbox_mock_ft.wasm');await economy.deploy('/wasm/near_economy.wasm');
  await root.call(token,'new',{owner_id:root.accountId,supply:String(1000n*unit)});
  await root.call(economy,'new',{owner_id:root.accountId,foxo_contract_id:token.accountId,network:'near-testnet',settlement_signer_id:root.accountId});
  for(const account of [economy,seller,buyer])await root.call(token,'storage_deposit',{account_id:account.accountId},{attachedDeposit:'12500000000000000000000'});
  for(const account of [seller,buyer])await root.call(token,'ft_transfer',{receiver_id:account.accountId,amount:String(100n*unit)},{attachedDeposit:one});
  await root.call(economy,'set_crafting_enabled',{enabled:true});await root.call(economy,'set_sales_enabled',{enabled:true});
  await root.call(economy,'add_recipe',{recipe:{recipeId:'finish',version:1,sku:'finish-a',inputs:{alloy:1,core:0,catalyst:0},feeAtomic:String(unit)}});
  await root.call(economy,'grant_materials',{account_id:seller.accountId,match_id:'loot',materials:{alloy:1,core:0,catalyst:0}});
  const transfer=(actor,amount,msg)=>actor.call(token,'ft_transfer_call',{receiver_id:economy.accountId,amount:String(amount),msg:JSON.stringify(msg)},{attachedDeposit:one,gas});
  await transfer(seller,unit,{action:'craft',operationId:'one',recipeId:'finish',recipeVersion:1});
  const item=seller.accountId+':one',manifest='a'.repeat(64),zero={alloy:0,core:0,catalyst:0};
  await root.call(economy,'set_crafting_enabled',{enabled:false});await root.call(economy,'begin_mt_migration',{manifest_hash:manifest});
  await root.call(economy,'import_mt_account',{account_id:seller.accountId,expected_available:zero,expected_reserved:zero,expected_consumed:{alloy:1,core:0,catalyst:0},expected_item_ids:[item]});
  await root.call(economy,'finalize_mt_migration',{manifest_hash:manifest,expected_accounts:1,expected_supply:['0','0','0'],expected_items:1});
  await seller.call(economy,'storage_deposit',{}, {attachedDeposit:String(unit/10n)});await root.call(economy,'set_mt_enabled',{enabled:true});
  const block=await root.provider.block({finality:'final'}),now=Math.floor(Number(block.header.timestamp_nanosec)/1000000);
  const sale=await seller.call(economy,'create_cosmetic_sale',{operation_id:'sale',item_id:item,expected_transfer_version:await economy.view('get_cosmetic_item_version',{item_id:item}),price_atomic:'10001',expires_at_ms:now+3600000},{attachedDeposit:await economy.view('get_cosmetic_sale_storage_charge'),gas});
  const msg={action:'buy_sale',operationId:'purchase',saleId:sale};
  const balance=()=>token.view('ft_balance_of',{account_id:buyer.accountId});
  const before=await balance();await transfer(buyer,10001n,msg);
  assert.equal(await balance(),before);assert.equal((await economy.view('get_cosmetic_sale',{sale_id:sale})).status,'open');
  assert.equal(await economy.view('get_order_credit',{account_id:seller.accountId}),'0');
  await buyer.call(economy,'storage_deposit',{}, {attachedDeposit:String(unit/10n)});
  await transfer(buyer,10001n,msg);assert.equal(await balance(),String(BigInt(before)-10001n));
  assert.equal((await economy.view('get_item',{item_id:item})).ownerId,buyer.accountId);
  assert.equal(await economy.view('get_cosmetic_purchase',{account_id:buyer.accountId,operation_id:'purchase'}),sale);
  assert.equal(await economy.view('get_order_credit',{account_id:seller.accountId}),'9751');
  assert.equal((await economy.view('get_order_ledger')).marketFees,'250');
  await transfer(buyer,10001n,msg);assert.equal(await balance(),String(BigInt(before)-10001n));
  await seller.call(economy,'withdraw_order_credit',{}, {attachedDeposit:one,gas});
  assert.equal(await token.view('ft_balance_of',{account_id:seller.accountId}),String(99n*unit+9751n));
  const stale=await buyer.call(economy,'create_cosmetic_sale',{operation_id:'stale',item_id:item,expected_transfer_version:await economy.view('get_cosmetic_item_version',{item_id:item}),price_atomic:'10001',expires_at_ms:now+3600000},{attachedDeposit:await economy.view('get_cosmetic_sale_storage_charge'),gas});
  await buyer.call(economy,'mt_transfer',{receiver_id:seller.accountId,token_id:'item:'+item,amount:'1'},{attachedDeposit:one});
  await seller.call(economy,'mt_transfer',{receiver_id:buyer.accountId,token_id:'item:'+item,amount:'1'},{attachedDeposit:one});
  const sellerBefore=await token.view('ft_balance_of',{account_id:seller.accountId});await transfer(seller,10001n,{action:'buy_sale',operationId:'stale-buy',saleId:stale});
  assert.equal(await token.view('ft_balance_of',{account_id:seller.accountId}),sellerBefore);
  assert.equal((await economy.view('get_order_ledger')).marketFees,'250');
 }finally{await worker.tearDown();}
});

test('material order escrows FOXO and settles a partial delivery atomically', async () => {
 const worker = await Worker.init();
 try {
  const root = worker.rootAccount;
  const token = await root.createSubAccount('token');
  const economy = await root.createSubAccount('economy');
  const seller = await root.createSubAccount('seller');
  const buyer = await root.createSubAccount('buyer');
  await token.deploy('/wasm/sandbox_mock_ft.wasm');
  const previousWasm = process.env.FOXO_PREVIOUS_ECONOMY_WASM;
  await economy.deploy(previousWasm || '/wasm/near_economy.wasm');
  await root.call(token,'new',{owner_id:root.accountId,supply:String(1000n*unit)});
  await root.call(economy,'new',{owner_id:root.accountId,foxo_contract_id:token.accountId,network:'near-testnet',settlement_signer_id:root.accountId});
  for (const account of [economy,seller,buyer]) {
   await root.call(token,'storage_deposit',{account_id:account.accountId},{attachedDeposit:String(unit/10n)});
  }
  await root.call(token,'ft_transfer',{receiver_id:buyer.accountId,amount:String(unit)},{attachedDeposit:one});
  const manifest = 'b'.repeat(64);
  await root.call(economy,'begin_mt_migration',{manifest_hash:manifest});
  await root.call(economy,'finalize_mt_migration',{manifest_hash:manifest,expected_accounts:0,expected_supply:['0','0','0'],expected_items:0});
  await root.call(economy,'set_mt_enabled',{enabled:true});
  await root.call(economy,'set_orders_enabled',{enabled:true});
  await root.call(economy,'set_crafting_enabled',{enabled:true});
  for (const account of [seller,buyer]) await account.call(economy,'storage_deposit',{}, {attachedDeposit:String(unit/10n)});
  await buyer.call(economy,'deposit_order_storage',{}, {attachedDeposit:String(unit)});
  await root.call(economy,'grant_materials',{account_id:seller.accountId,match_id:'loot',materials:{alloy:3,core:0,catalyst:0}});
  if (previousWasm) {
   const ledger = await economy.view('get_ledger');
   await economy.deploy('/wasm/near_economy.wasm');
   assert.deepEqual(await economy.view('get_ledger'),ledger);
   assert.equal((await economy.view('get_inventory',{account_id:seller.accountId})).available.alloy,3);
  }
  assert.equal(await economy.view('can_fund_material_order',{account_id:buyer.accountId}),true);
  const {header} = await root.provider.block({finality:'final'});
  const orderId = buyer.accountId+':alloy-batch';
  await buyer.call(token,'ft_transfer_call',{
   receiver_id:economy.accountId,amount:'30000',msg:JSON.stringify({action:'fund_order',operationId:'alloy-batch',
    recipeId:'alloy',recipeVersion:0,quantity:3,unitPrice:'10000',expiresAtMs:Math.floor(Number(header.timestamp_nanosec)/1e6)+3_600_000})
  },{attachedDeposit:one,gas});
  assert.equal((await economy.view('get_order',{order_id:orderId})).remaining,3);
  await assert.rejects(buyer.call(economy,'fill_material_order',{order_id:orderId,quantity:1},{attachedDeposit:one,gas}));
  await assert.rejects(seller.call(economy,'fill_material_order',{order_id:orderId,quantity:4},{attachedDeposit:one,gas}));
  await seller.call(economy,'fill_material_order',{order_id:orderId,quantity:2},{attachedDeposit:one,gas});
  assert.equal((await economy.view('get_inventory',{account_id:buyer.accountId})).available.alloy,2);
  assert.equal(await economy.view('get_order_credit',{account_id:seller.accountId}),'19500');
  assert.equal((await economy.view('get_order',{order_id:orderId})).remaining,1);
  await buyer.call(economy,'close_order',{order_id:orderId},{attachedDeposit:one,gas});
  assert.equal(await economy.view('get_order_credit',{account_id:buyer.accountId}),'10000');
  assert.equal((await economy.view('get_order_ledger')).escrow,'0');
 } finally { await worker.tearDown(); }
});
