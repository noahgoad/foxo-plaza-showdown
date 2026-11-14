import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './crafting-wasm.test.mjs';

const owner='operator.testnet', signer='signer.testnet', alice='alice.testnet', bob='bob.testnet';
const contract='economy.operator.testnet';
const materials=(alloy=0,core=0,catalyst=0)=>({alloy,core,catalyst});
const manifest='a'.repeat(64);
const near=10n**24n;

test('cosmetics keep one owner and invalidate equipped selection on MT transfer',async()=>{
  const call=await fixture();
  call('new',{owner_id:owner,foxo_contract_id:'foxo.testnet',network:'near-testnet',settlement_signer_id:signer},owner);
  call('set_crafting_enabled',{enabled:true},owner);
  call('add_recipe',{recipe:{recipeId:'finish',version:1,sku:'finish-violet',inputs:materials(1),feeAtomic:'1'}},owner);
  call('grant_materials',{account_id:alice,match_id:'loot',materials:materials(1)},signer);
  call('ft_on_transfer',{sender_id:alice,amount:'1',msg:JSON.stringify({action:'craft',operationId:'one',recipeId:'finish',recipeVersion:1})},'foxo.testnet');
  const id=alice+':one',token='item:'+id;
  call('set_crafting_enabled',{enabled:false},owner);
  call('begin_mt_migration',{manifest_hash:manifest},owner);
  call('import_mt_account',{account_id:alice,expected_available:materials(),expected_reserved:materials(),expected_consumed:materials(1),expected_item_ids:[id]},owner);
  call('finalize_mt_migration',{manifest_hash:manifest,expected_accounts:1,expected_supply:['0','0','0'],expected_items:1},owner);
  for(const account of [alice,bob])call('storage_deposit',{account_id:account},account,near);
  call('set_mt_enabled',{enabled:true},owner);
  call('equip',{item_id:id},alice,1n);
  assert.equal(call('mt_supply',{token_id:token}),'1');
  assert.equal(call('mt_balance_of',{account_id:alice,token_id:token}),'1');
  call('mt_transfer',{receiver_id:bob,token_id:token,amount:'1'},alice,1n);
  assert.equal(call('get_item',{item_id:id}).ownerId,bob);
  assert.equal(call('get_equipped',{account_id:alice}),null);
  assert.equal(call('mt_balance_of',{account_id:alice,token_id:token}),'0');
  assert.equal(call('mt_token',{token_ids:[token]})[0].owner_id,bob);
  assert.equal(call('mt_metadata_base_by_token_id',{token_ids:[token]})[0].id,'cosmetic:finish-violet');
  assert.throws(()=>call('storage_unregister',{},bob,1n),/outstanding/);
  call('mt_transfer_call',{receiver_id:alice,token_id:token,amount:'1',msg:''},bob,1n);
  assert.equal(call('get_item',{item_id:id}).ownerId,alice);
  assert.deepEqual(call('mt_resolve_transfer',{call_id:0},contract,0n,contract,false),['0']);
  assert.equal(call('get_item',{item_id:id}).ownerId,bob);
  call('mt_transfer_call',{receiver_id:alice,token_id:token,amount:'1',msg:''},bob,1n);
  assert.deepEqual(call('mt_resolve_transfer',{call_id:1},contract,0n,contract,'["0"]'),['1']);
  assert.equal(call('get_item',{item_id:id}).ownerId,alice);
  assert.equal(call('mt_supply',{token_id:token}),'1');
});
async function migrated() {
  const logs=[];
  const call=await fixture(logs);
  call('new',{owner_id:owner,foxo_contract_id:'foxo.testnet',network:'near-testnet',settlement_signer_id:signer},owner);
  call('set_crafting_enabled',{enabled:true},owner);
  call('grant_materials',{account_id:alice,match_id:'m1',materials:materials(12,2,1)},signer);
  call('set_crafting_enabled',{enabled:false},owner);
  call('begin_mt_migration',{manifest_hash:manifest},owner);
  assert.throws(()=>call('set_mt_enabled',{enabled:true},owner),/Finalize/);
  const args={account_id:alice,expected_available:materials(12,2,1),expected_reserved:materials(),expected_consumed:materials()};
  assert.throws(()=>call('import_mt_account',{...args,expected_available:materials(11,2,1)},owner),/mismatch/);
  assert.equal(call('import_mt_account',args,owner),true);
  assert.equal(call('import_mt_account',args,owner),false);
  assert.throws(()=>call('finalize_mt_migration',{manifest_hash:manifest,expected_accounts:1,expected_supply:['11','2','1']},owner),/mismatch/);
  call('finalize_mt_migration',{manifest_hash:manifest,expected_accounts:1,expected_supply:['12','2','1']},owner);
  call('storage_deposit',{account_id:alice},alice,near);
  call('storage_deposit',{account_id:bob},bob,near);
  call('set_mt_enabled',{enabled:true},owner);
  return {call,logs};
}

test('MT migration checks exact snapshots, one authoritative balance and duplicate batches',async()=>{
  const {call,logs}=await migrated();
  assert.deepEqual(call('mt_batch_supply',{token_ids:['alloy','core','catalyst','unknown']}),['12','2','1',null]);
  assert.equal(call('mt_balance_of',{account_id:alice,token_id:'alloy'}),'12');
  assert.throws(()=>call('mt_batch_transfer',{receiver_id:bob,token_ids:['alloy','alloy'],amounts:['2','2']},alice,1n),/duplicate/);
  assert.throws(()=>call('mt_batch_transfer',{receiver_id:bob,token_ids:['alloy','core'],amounts:['2','3']},alice,1n),/Insufficient/);
  assert.equal(call('mt_balance_of',{account_id:alice,token_id:'alloy'}),'12');
  assert.throws(()=>call('mt_transfer',{receiver_id:'unregistered.testnet',token_id:'alloy',amount:'1'},alice,1n),/registered/);
  call('mt_batch_transfer',{receiver_id:bob,token_ids:['alloy','core'],amounts:['3','1']},alice,1n);
  assert.deepEqual(call('mt_batch_balance_of',{account_id:bob,token_ids:['alloy','core']}),['3','1']);
  assert.equal(call('get_inventory',{account_id:alice}).available.alloy,9);
  assert.equal(call('mt_metadata_contract',{}).spec,'mt-1.0.0');
  assert.equal(call('mt_metadata_base_by_token_id',{token_ids:['alloy']})[0].decimals,'0');
  assert.ok(logs.some(log=>log.includes('"standard":"nep245"')&&log.includes('"event":"mt_transfer"')));
});

test('MT callbacks return unused amounts, fail closed on malformed receipt, and reject replay/spoof',async()=>{
  const {call}=await migrated();
  call('mt_transfer_call',{receiver_id:bob,token_id:'alloy',amount:'5',msg:'accept some'},alice,1n);
  assert.throws(()=>call('storage_unregister',{},alice,1n),/outstanding/);
  assert.throws(()=>call('mt_resolve_transfer',{call_id:0},bob),/private/);
  assert.deepEqual(call('mt_resolve_transfer',{call_id:0},contract,0n,contract,'["2"]'),['3']);
  assert.equal(call('mt_balance_of',{account_id:alice,token_id:'alloy'}),'9');
  assert.throws(()=>call('mt_resolve_transfer',{call_id:0},contract),/resolved/);
  call('mt_transfer_call',{receiver_id:bob,token_id:'core',amount:'1',msg:''},alice,1n);
  assert.deepEqual(call('mt_resolve_transfer',{call_id:1},contract,0n,contract,'malformed'),['0']);
  call('mt_transfer_call',{receiver_id:bob,token_id:'catalyst',amount:'1',msg:''},alice,1n);
  assert.deepEqual(call('mt_resolve_transfer',{call_id:2},contract,0n,contract,false),['0']);
  assert.deepEqual(call('mt_batch_supply',{token_ids:['alloy','core','catalyst']}),['12','2','1']);
  call('mt_transfer_call',{receiver_id:bob,token_id:'core',amount:'2',msg:''},alice,1n);
  call('mt_transfer',{receiver_id:alice,token_id:'core',amount:'1'},bob,1n);
  assert.deepEqual(call('mt_resolve_transfer',{call_id:3},contract,0n,contract,'["999"]'),['1']);
  assert.equal(call('mt_balance_of',{account_id:alice,token_id:'core'}),'2');
});

test('material mint and craft burn keep MT supply aligned with the authoritative ledger',async()=>{
  const {call,logs}=await migrated();
  call('set_crafting_enabled',{enabled:true},owner);
  call('grant_materials',{account_id:'new.testnet',match_id:'fresh-grant',materials:materials(2,0,0)},signer);
  assert.equal(call('mt_supply',{token_id:'alloy'}),'14');
  const recipe={recipeId:'mt-test',version:1,sku:'mt-test',inputs:materials(2),feeAtomic:'1'};
  call('add_recipe',{recipe},owner);
  call('storage_deposit',{account_id:'new.testnet'},'new.testnet',near);
  const result=call('ft_on_transfer',{sender_id:'new.testnet',amount:'1',msg:JSON.stringify({action:'craft',operationId:'craft-mt',recipeId:'mt-test',recipeVersion:1})},'foxo.testnet');
  assert.equal(result,'0');
  assert.equal(call('mt_supply',{token_id:'alloy'}),'12');
  assert.ok(logs.some(log=>log.includes('"event":"mt_burn"')));
});

test('MT deposits cover account rows and pending storage, withdrawals cannot consume locked deposit',async()=>{
  const {call}=await migrated();
  const bounds=call('storage_balance_bounds',{});
  const fresh='fresh.testnet';
  assert.throws(()=>call('storage_deposit',{account_id:fresh},fresh,1n),/Insufficient/);
  call('storage_deposit',{account_id:fresh,registration_only:true},fresh,BigInt(bounds.min));
  assert.equal(call('storage_balance_of',{account_id:fresh}).available,'0');
  assert.equal(call('storage_unregister',{},fresh,1n),true);
  assert.equal(call('storage_balance_of',{account_id:fresh}),null);
  const storage=call('storage_balance_of',{account_id:alice});
  assert.throws(()=>call('storage_withdraw',{amount:storage.total},alice,1n),/exceeds/);
  assert.throws(()=>call('mt_transfer',{receiver_id:bob,token_id:'alloy',amount:'1'},alice),/1 yocto/);
});
