import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'near-workspaces';

const yocto = '1';
const gas = '100000000000000';
const day = 86_400_000;
const unit = 10n ** 24n;
const budget = String(16_000n * unit);
const award = String(5n * unit);

test('catalogue craft requires the account license and refunds an unlicensed attempt',async()=>{
  const worker=await Worker.init();
  try {
    const root=worker.rootAccount;
    const economy=await root.createSubAccount('economy'),token=await root.createSubAccount('token');
    const player=await root.createSubAccount('player');
    await economy.deploy(process.env.PREVIOUS_ECONOMY_WASM || '/wasm/near_economy.wasm');
    await root.call(economy,'new',{owner_id:root.accountId,foxo_contract_id:token.accountId,network:'near-testnet',settlement_signer_id:root.accountId});
    const prior=await economy.view('get_config',{});
    await economy.deploy('/wasm/near_economy.wasm');
    assert.deepEqual(await economy.view('get_config',{}),prior);
    const recipe={recipeId:'aurora-weapon-finish',version:2,sku:'weapon-finish-aurora-v2',
      inputs:{alloy:1,core:0,catalyst:1},feeAtomic:String(5n*unit)};
    await root.call(economy,'add_recipe',{recipe});
    await root.call(economy,'set_crafting_enabled',{enabled:true});
    await root.call(economy,'grant_materials',{account_id:player.accountId,match_id:'catalogue',materials:recipe.inputs});
    const args={sender_id:player.accountId,amount:recipe.feeAtomic,msg:JSON.stringify({
      action:'craft',operationId:'one',recipeId:recipe.recipeId,recipeVersion:2,
    })};
    const license={account_id:player.accountId,license_id:'armorer:aurora-v2'};
    assert.equal(await token.call(economy,'ft_on_transfer',args),recipe.feeAtomic);
    assert.equal(await economy.view('get_item',{item_id:player.accountId+':one'}),null);
    const evidence={account_id:player.accountId,matches:[
      {match_id:'boss',kind:'boss_clear'},{match_id:'trial',kind:'match'},{match_id:'third',kind:'match'},
    ]};
    await assert.rejects(player.call(economy,'record_profession_matches',evidence),/Unauthorized result signer/);
    await assert.rejects(root.call(economy,'set_recipe_license',{...license,granted:true}),/MethodNotFound/);
    assert.equal(await root.call(economy,'record_profession_matches',evidence),true);
    assert.equal(await root.call(economy,'record_profession_matches',evidence),false);
    assert.equal(await token.call(economy,'ft_on_transfer',args),'0');
    assert.equal((await economy.view('get_item',{item_id:player.accountId+':one'})).sku,recipe.sku);
    assert.equal(await economy.view('get_recipe_license',license),true);
    await assert.rejects(root.call(economy,'add_recipe',{recipe:{...recipe,sku:'guild-banner-beacon-v2'}}),/Guild contract/);
  }finally{await worker.tearDown();}
});

test('cosmetic MT receiver failure restores owner and successful receiver retains exactly one item',async()=>{
  const worker=await Worker.init();
  try {
    const root=worker.rootAccount;
    const token=await root.createSubAccount('token'),economy=await root.createSubAccount('economy'),seller=await root.createSubAccount('seller');
    await token.deploy('/wasm/sandbox_mock_ft.wasm');await economy.deploy('/wasm/near_economy.wasm');
    await root.call(token,'new',{owner_id:root.accountId,supply:String(10n*unit)});
    await root.call(economy,'new',{owner_id:root.accountId,foxo_contract_id:token.accountId,network:'near-testnet',settlement_signer_id:root.accountId});
    for(const account of [seller,economy])await root.call(token,'storage_deposit',{account_id:account.accountId},{attachedDeposit:'12500000000000000000000'});
    await root.call(token,'ft_transfer',{receiver_id:seller.accountId,amount:String(unit)},{attachedDeposit:yocto});
    await root.call(economy,'add_recipe',{recipe:{recipeId:'finish',version:1,sku:'finish',inputs:{alloy:1,core:0,catalyst:0},feeAtomic:String(unit)}});
    await root.call(economy,'set_crafting_enabled',{enabled:true});
    await root.call(economy,'grant_materials',{account_id:seller.accountId,match_id:'loot',materials:{alloy:1,core:0,catalyst:0}});
    await seller.call(token,'ft_transfer_call',{receiver_id:economy.accountId,amount:String(unit),msg:JSON.stringify({action:'craft',operationId:'one',recipeId:'finish',recipeVersion:1})},{attachedDeposit:yocto,gas});
    const itemId=seller.accountId+':one',tokenId='item:'+itemId,manifest='a'.repeat(64),zero={alloy:0,core:0,catalyst:0};
    await root.call(economy,'set_crafting_enabled',{enabled:false});
    await root.call(economy,'begin_mt_migration',{manifest_hash:manifest});
    await root.call(economy,'import_mt_account',{account_id:seller.accountId,expected_available:zero,expected_reserved:zero,expected_consumed:{alloy:1,core:0,catalyst:0},expected_item_ids:[itemId]});
    await root.call(economy,'finalize_mt_migration',{manifest_hash:manifest,expected_accounts:1,expected_supply:['0','0','0'],expected_items:1});
    for(const account of [seller,token])await root.call(economy,'storage_deposit',{account_id:account.accountId},{attachedDeposit:String(unit/10n)});
    await root.call(economy,'set_mt_enabled',{enabled:true});
    await seller.call(economy,'equip',{item_id:itemId},{attachedDeposit:yocto});
    await seller.call(economy,'mt_transfer_call',{receiver_id:token.accountId,token_id:tokenId,amount:'1',msg:'reject'},{attachedDeposit:yocto,gas});
    assert.equal((await economy.view('get_item',{item_id:itemId})).ownerId,seller.accountId);
    assert.equal(await economy.view('get_equipped',{account_id:seller.accountId}),null);
    await seller.call(economy,'mt_transfer_call',{receiver_id:token.accountId,token_id:tokenId,amount:'1',msg:'accept'},{attachedDeposit:yocto,gas});
    assert.equal((await economy.view('get_item',{item_id:itemId})).ownerId,token.accountId);
    assert.equal(await economy.view('mt_balance_of',{account_id:seller.accountId,token_id:tokenId}),'0');
    assert.equal(await economy.view('mt_supply',{token_id:tokenId}),'1');
    await assert.rejects(seller.call(economy,'mt_resolve_transfer',{call_id:0}),/private/);
    await root.call(economy,'set_crafting_enabled',{enabled:true});
    await root.call(economy,'grant_materials',{account_id:seller.accountId,match_id:'mt-loot',materials:{alloy:4,core:2,catalyst:0}});
    await seller.call(economy,'mt_transfer_call',{receiver_id:token.accountId,token_id:'alloy',amount:'2',msg:'partial'},{attachedDeposit:yocto,gas});
    assert.equal(await economy.view('mt_balance_of',{account_id:seller.accountId,token_id:'alloy'}),'3');
    assert.equal(await economy.view('mt_balance_of',{account_id:token.accountId,token_id:'alloy'}),'1');
    await seller.call(economy,'mt_transfer_call',{receiver_id:token.accountId,token_id:'core',amount:'2',msg:'reject'},{attachedDeposit:yocto,gas});
    assert.equal(await economy.view('mt_balance_of',{account_id:seller.accountId,token_id:'core'}),'2');
    assert.equal(await economy.view('mt_supply',{token_id:'alloy'}),'4');
    assert.equal(await economy.view('mt_supply',{token_id:'core'}),'2');
  } finally {await worker.tearDown();}
});

test('market delivery charges only filled gross and preserves unfilled refund', async () => {
  const worker=await Worker.init();
  try {
    const root=worker.rootAccount;
    const token=await root.createSubAccount('token'),economy=await root.createSubAccount('economy');
    const seller=await root.createSubAccount('seller'),buyer=await root.createSubAccount('buyer');
    await token.deploy('/wasm/sandbox_mock_ft.wasm');await economy.deploy('/wasm/near_economy.wasm');
    await root.call(token,'new',{owner_id:root.accountId,supply:String(1000n*unit)});
    await root.call(economy,'new',{owner_id:root.accountId,foxo_contract_id:token.accountId,network:'near-testnet',settlement_signer_id:root.accountId});
    for(const account of [economy,seller,buyer])await root.call(token,'storage_deposit',{account_id:account.accountId},{attachedDeposit:'12500000000000000000000'});
    for(const account of [seller,buyer])await root.call(token,'ft_transfer',{receiver_id:account.accountId,amount:String(100n*unit)},{attachedDeposit:yocto});
    await root.call(economy,'set_crafting_enabled',{enabled:true});await root.call(economy,'set_orders_enabled',{enabled:true});
    const recipe={recipeId:'test-finish',version:1,sku:'test-finish',inputs:{alloy:1,core:0,catalyst:0},feeAtomic:String(unit)};
    await root.call(economy,'add_recipe',{recipe});
    await root.call(economy,'grant_materials',{account_id:seller.accountId,match_id:'loot-1',materials:recipe.inputs});
    const transfer=(actor,amount,msg)=>actor.call(token,'ft_transfer_call',{receiver_id:economy.accountId,amount:String(amount),msg:JSON.stringify(msg)},{attachedDeposit:yocto,gas});
    await transfer(seller,unit,{action:'craft',operationId:'craft-1',recipeId:recipe.recipeId,recipeVersion:1});
    const block=await root.provider.block({finality:'final'}),now=Math.floor(Number(block.header.timestamp_nanosec)/1000000);
    await buyer.call(economy,'deposit_order_storage',{}, {attachedDeposit:String(unit)});
    await transfer(buyer,20n*unit,{action:'fund_order',operationId:'buy-1',recipeId:recipe.recipeId,recipeVersion:1,quantity:2,unitPrice:String(10n*unit),expiresAtMs:now+3600000});
    const orderId=buyer.accountId+':buy-1',itemId=seller.accountId+':craft-1';
    await seller.call(economy,'fill_order',{order_id:orderId,item_id:itemId},{attachedDeposit:yocto});
    assert.equal((await economy.view('get_item',{item_id:itemId})).ownerId,buyer.accountId);
    assert.equal(await economy.view('get_order_credit',{account_id:seller.accountId}),String(975n*unit/100n));
    assert.equal((await economy.view('get_order_ledger')).marketFees,String(unit/4n));
    await buyer.call(economy,'close_order',{order_id:orderId},{attachedDeposit:yocto});
    assert.equal(await economy.view('get_order_credit',{account_id:buyer.accountId}),String(10n*unit));
    for(const account of [seller,buyer])await account.call(economy,'withdraw_order_credit',{}, {attachedDeposit:yocto,gas});
    assert.equal((await economy.view('get_order_ledger')).payable,'0');
    assert.equal(await token.view('ft_balance_of',{account_id:seller.accountId}),String(10875n*unit/100n));
    assert.equal(await token.view('ft_balance_of',{account_id:buyer.accountId}),String(90n*unit));
  } finally {await worker.tearDown();}
});

test('fixed reward survives campaign closure and a failed FT claim, then pays once', async () => {
  const worker = await Worker.init();
  try {
    const root = worker.rootAccount;
    const token = await root.createSubAccount('token');
    const economy = await root.createSubAccount('economy');
    const alice = await root.createSubAccount('alice');
    await token.deploy('/wasm/sandbox_mock_ft.wasm');
    await economy.deploy('/wasm/near_economy.wasm');
    await root.call(token, 'new', { owner_id: root.accountId, supply: budget });
    await root.call(economy, 'new', { owner_id: root.accountId, foxo_contract_id: token.accountId,
      network: 'near-testnet', settlement_signer_id: root.accountId });
    const register = account => root.call(token, 'storage_deposit', { account_id: account.accountId },
      { attachedDeposit: '12500000000000000000000' });
    await register(economy);
    await root.call(token, 'ft_transfer_call', { receiver_id: economy.accountId, amount: budget,
      msg: JSON.stringify({ action: 'fund_rewards' }) }, { attachedDeposit: yocto, gas });
    assert.equal((await economy.view('get_ledger')).rewardAvailable, budget);
    const created = Date.now();
    const seasonStart = Math.floor(created / day) * day;
    await root.call(economy, 'open_fixed_campaign', { campaign_id: 'pilot', season_start_ms: seasonStart });
    await root.call(economy, 'set_settlement_enabled', { enabled: true });
    const reservation = { id: 'op', campaignId: 'pilot', accountId: alice.accountId, matchId: 'match',
      taskId: 'boss-clear', mode: 'boss', amountAtomic: award, createdAtMs: created,
      startByMs: created + 600_000, completeByMs: created + 3_600_000, dayIndex: 0,
      windowIndex: Math.floor((created - seasonStart) / (day / 6)) };
    const held = await root.call(economy, 'reserve_fixed_reward', { reservation });
    assert.equal(held.status, 'reserved');
    assert.equal((await economy.view('get_ledger')).fixedReserved, award);
    await root.call(economy, 'close_campaign', { campaign_id: 'pilot' });
    const completion = { reservation_id: 'op', started_at_ms: held.reservedAtMs,
      finished_at_ms: held.reservedAtMs + 1, result_hash: 'a'.repeat(64) };
    const settle = () => root.call(economy, 'settle_fixed_reward', completion);
    assert.equal((await settle()).amountAtomic, award);
    assert.equal((await settle()).amountAtomic, award);
    assert.equal((await economy.view('get_ledger')).fixedReserved, '0');
    const claim = () => alice.call(economy, 'claim', { operation_id: 'op' }, { attachedDeposit: yocto, gas });
    assert.equal(await claim(), false);
    assert.equal((await economy.view('get_ledger')).rewardReserved, award);
    assert.equal(await token.view('ft_balance_of', { account_id: alice.accountId }), '0');
    await register(alice);
    assert.equal(await claim(), true);
    assert.equal(await token.view('ft_balance_of', { account_id: alice.accountId }), award);
    await assert.rejects(claim);
    assert.equal((await economy.view('get_ledger')).rewardPaid, award);
  } finally {
    await worker.tearDown();
  }
});
