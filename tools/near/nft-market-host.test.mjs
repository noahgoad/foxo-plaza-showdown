import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wasm = new URL('../../contracts/near-market/target/wasm32-unknown-unknown/release/near_market.wasm', import.meta.url);
const token = 'foxo.testnet';
const contract = 'market.operator.testnet';
const owner = 'operator.testnet';
const signer = 'signer.testnet';
const alice = 'alice.testnet';
const fee = '5000000000000000000000000';

export async function fixture(logs = [], options = {}) {
  const module = await WebAssembly.compile(await readFile(wasm));
  const registers = new Map();
  let storage = new Map();
  let input, result, predecessor, transactionSigner, deposit, instance, transferSucceeded;
  const read = (length, address) => Buffer.from(new Uint8Array(instance.exports.memory.buffer, Number(address), Number(length)));
  const write = (bytes, address) => new Uint8Array(instance.exports.memory.buffer, Number(address), bytes.length).set(bytes);
  const register = (id, value) => registers.set(id, Buffer.from(value));
  const key = (length, address) => read(length, address).toString('hex');
  const env = {
    log_utf8: (length, pointer) => logs.push(read(length, pointer).toString()),
    input: id => register(id, input),
    current_account_id: id => register(id, contract),
    predecessor_account_id: id => register(id, predecessor),
    signer_account_id: id => register(id, transactionSigner),
    register_len: id => BigInt(registers.get(id)?.length ?? -1),
    read_register: (id, pointer) => write(registers.get(id), pointer),
    value_return: (length, pointer) => { result = JSON.parse(read(length, pointer)); },
    panic_utf8: (length, pointer) => { throw new Error(read(length, pointer).toString()); },
    block_timestamp: () => BigInt(options.nowMs?.() ?? 100 * 86_400_000) * 1_000_000n,
    attached_deposit: pointer => {
      const bytes = Buffer.alloc(16);
      bytes.writeBigUInt64LE(deposit & ((1n << 64n)-1n));
      bytes.writeBigUInt64LE(deposit >> 64n,8);
      write(bytes, pointer);
    },
    sha256: (length, pointer, id) => register(id, createHash('sha256').update(read(length, pointer)).digest()),
    storage_has_key: (length, address) => storage.has(key(length, address)) ? 1n : 0n,
    storage_usage: () => BigInt([...storage].reduce((sum,[k,v]) => sum + k.length/2 + v.length,0)),
    storage_read: (length, address, id) => {
      const value = storage.get(key(length, address));
      if (!value) return 0n;
      register(id, value);
      return 1n;
    },
    storage_write: (length, address, valueLength, valueAddress, id) => {
      const k = key(length, address);
      const previous = storage.get(k);
      if (previous) register(id, previous);
      storage.set(k, read(valueLength, valueAddress));
      return previous ? 1n : 0n;
    },
    storage_remove: (length, address, id) => {
      const k = key(length, address);
      const value = storage.get(k);
      if (!value) return 0n;
      register(id, value);
      storage.delete(k);
      return 1n;
    },
    prepaid_gas: () => 250_000_000_000_000n,
    promise_batch_create: () => 0n,
    promise_batch_then: () => 1n,
    promise_batch_action_function_call: () => {},
    promise_batch_action_function_call_weight: () => {},
    promise_batch_action_transfer: () => {},
    promise_return: () => {},
    promise_results_count: () => 1n,
    promise_result: (_index, id) => {
      if (!transferSucceeded) return 2n;
      register(id, typeof transferSucceeded === 'string' ? transferSucceeded : '');
      return 1n;
    },
  };
  for (const { name } of WebAssembly.Module.imports(module)) {
    env[name] ??= () => { throw new Error('Unexpected host call: ' + name); };
  }
  return (method, args, caller = alice, attached = 0n, signedBy = caller, receiptSucceeded = false) => {
    input = JSON.stringify(args);
    predecessor = caller;
    transactionSigner = signedBy;
    deposit = attached;
    transferSucceeded = receiptSucceeded;
    result = undefined;
    registers.clear();
    instance = new WebAssembly.Instance(module, { env });
    const snapshot = new Map(storage);
    try {
      instance.exports[method]();
      return result;
    } catch (error) {
      storage = snapshot;
      throw error;
    }
  };
}


const seller='seller.testnet',buyer='buyer.testnet',nft='fox.testnet',storage=5n*10n**22n;
async function setup(){
 const call=await fixture();call('new',{owner_id:owner,foxo_contract_id:token,nft_contract_id:nft,passport_contract_id:'passport.testnet'},owner);
 for(const account of [seller,buyer,'other.testnet'])call('fund_account',{},account,storage);
 call('fund_listing',{token_id:'001'},seller,storage);
 call('nft_on_approve',{token_id:'001',owner_id:seller,approval_id:1,msg:JSON.stringify({price_atomic:'10001',expires_at_ns:'999999999999999999',career_revision:'7'})},nft);
 return call;
}
function prepare(call,id='buy',who=buyer){call('prepare_purchase',{purchase_id:id,token_id:'001',approval_id:1,price_atomic:'10001',career_revision:'7'},who,storage);}
function pay(call,id='buy',who=buyer,msg={purchase_id:id}){return call('ft_on_transfer',{sender_id:who,amount:'10001',msg:JSON.stringify(msg)},token);}
const selfCall=(call,method,args,result)=>call(method,args,contract,0n,contract,result);
test('native storage, authentic collection, exact terms, pause, self trade and bundle fail closed',async()=>{
 const call=await setup();assert.equal(call('get_enabled',{}),false);
 assert.equal(call('get_listing_slot',{account_id:seller,token_id:'001'}),true);
 assert.equal(call('get_listing_slot',{account_id:buyer,token_id:'001'}),false);
 assert.deepEqual(call('get_account_state',{account_id:seller}),{credit:'0',withdraw_pending:'0'});
 assert.equal(call('get_account_state',{account_id:'unfunded.testnet'}),null);
 assert.throws(()=>call('fund_listing',{token_id:'002'},seller,1n),/storage/);
 assert.throws(()=>call('nft_on_approve',{token_id:'001',owner_id:seller,approval_id:2,msg:'{}'},buyer),/collection/);
 assert.throws(()=>call('prepare_purchase',{purchase_id:'self',token_id:'001',approval_id:1,price_atomic:'10001',career_revision:'7'},seller,storage),/Self trade/);
 prepare(call);assert.equal(pay(call),'10001');call('set_enabled',{enabled:true},owner);
 assert.equal(pay(call,'buy',buyer,{purchase_id:'buy',assets:['001']}),'10001');
 assert.equal(pay(call,'missing'),'10001');assert.equal(pay(call),'0');
 assert.deepEqual(call('get_ledger',{}),{principal:'10001',credits:'0',fees:'0',withdraw_pending:'0'});
 assert.equal(pay(call),'10001');assert.throws(()=>prepare(call,'race','other.testnet'),/Stale terms/);
});
test('career lookup failure restores full buyer credit; callback is private and replay is blocked',async()=>{
 const call=await setup();prepare(call);call('set_enabled',{enabled:true},owner);pay(call);
 assert.throws(()=>call('resolve_career',{purchase_id:'buy'},buyer),/private/);
 selfCall(call,'resolve_career',{purchase_id:'buy'},false);
 assert.equal(call('get_purchase',{purchase_id:'buy'}).status,'refundable');
 assert.deepEqual(call('get_ledger',{}),{principal:'0',credits:'10001',fees:'0',withdraw_pending:'0'});
 assert.throws(()=>selfCall(call,'resolve_career',{purchase_id:'buy'},'{"revision":7}'),/not pending/);
});
test('career revision mismatch cannot deliver NFT; successful delivery alone creates fee and seller credit',async()=>{
 let call=await setup();prepare(call);call('set_enabled',{enabled:true},owner);pay(call);selfCall(call,'resolve_career',{purchase_id:'buy'},'{"revision":8}');
 assert.equal(call('get_credit',{account_id:buyer}),'10001');
 call=await setup();prepare(call);call('set_enabled',{enabled:true},owner);pay(call);selfCall(call,'resolve_career',{purchase_id:'buy'},'{"revision":7}');
 assert.equal(call('get_credit',{account_id:seller}),'0');selfCall(call,'resolve_purchase',{purchase_id:'buy'},true);
 assert.deepEqual(call('get_ledger',{}),{principal:'0',credits:'9751',fees:'250',withdraw_pending:'0'});
 assert.throws(()=>selfCall(call,'resolve_purchase',{purchase_id:'buy'},true),/not pending/);
 call('withdraw_credit',{},seller,1n);assert.deepEqual(call('get_account_state',{account_id:seller}),{credit:'0',withdraw_pending:'9751'});
 selfCall(call,'resolve_withdraw',{account_id:seller,attempt:1},false);assert.equal(call('get_credit',{account_id:seller}),'9751');
 call('withdraw_credit',{},seller,1n);assert.throws(()=>selfCall(call,'resolve_withdraw',{account_id:seller,attempt:1},true),/Unknown withdrawal/);
 selfCall(call,'resolve_withdraw',{account_id:seller,attempt:2},true);assert.equal(call('get_credit',{account_id:seller}),'0');
 assert.deepEqual(call('get_ledger',{}),{principal:'0',credits:'0',fees:'250',withdraw_pending:'0'});
});

test('two prepared buyers compete for one NFT; failed NFT receipt credits only funded buyer once',async()=>{
 const call=await setup();prepare(call);prepare(call,'rival','other.testnet');call('set_enabled',{enabled:true},owner);
 assert.equal(pay(call),'0');assert.equal(pay(call,'rival','other.testnet'),'10001');
 selfCall(call,'resolve_career',{purchase_id:'buy'},'{"revision":7}');selfCall(call,'resolve_purchase',{purchase_id:'buy'},false);
 assert.equal(call('get_purchase',{purchase_id:'buy'}).status,'refundable');
 assert.deepEqual(call('get_ledger',{}),{principal:'0',credits:'10001',fees:'0',withdraw_pending:'0'});
 assert.equal(call('get_credit',{account_id:'other.testnet'}),'0');assert.equal(pay(call,'rival','other.testnet'),'10001');
 assert.throws(()=>selfCall(call,'resolve_purchase',{purchase_id:'unknown'},true),/Unknown purchase/);
});
test('cancel during pause and changed approval invalidate prepared terms without consuming buyer payment',async()=>{
 const call=await setup();prepare(call);call('cancel_listing',{token_id:'001'},seller);call('set_enabled',{enabled:true},owner);assert.equal(pay(call),'10001');
 call('nft_on_approve',{token_id:'001',owner_id:seller,approval_id:2,msg:JSON.stringify({price_atomic:'10001',expires_at_ns:'999999999999999999',career_revision:'7'})},nft);
 assert.equal(pay(call),'10001');assert.throws(()=>prepare(call,'again'),/Stale terms/);
 assert.deepEqual(call('get_ledger',{}),{principal:'0',credits:'0',fees:'0',withdraw_pending:'0'});
});

test('a buyer can cancel only their prepared purchase and the FT call returns its entire payment',async()=>{
 const call=await setup();prepare(call);call('set_enabled',{enabled:true},owner);
 assert.throws(()=>call('cancel_purchase',{purchase_id:'buy'},seller),/Only buyer/);
 call('cancel_purchase',{purchase_id:'buy'},buyer);
 assert.equal(call('get_purchase',{purchase_id:'buy'}).status,'cancelled');assert.equal(pay(call),'10001');
 assert.equal(call('get_listing',{token_id:'001'}).status,'open');
 prepare(call,'next');assert.equal(pay(call,'next'),'0');
 assert.throws(()=>call('cancel_purchase',{purchase_id:'next'},buyer),/already funded/);
});
