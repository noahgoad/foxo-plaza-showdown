import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const deployedHash='14bf13c2b5b32327c5ce0322e9e0442df1991c0f85ba18a8aa7412b8590090f1';
const upgradeHash='9d6c61fc549fdbe8bd8afa9c2812ad4875568ec5c0cf768ac6e1ee7648b20902';
const original=process.env.FOX_LEGACY_WASM || new URL('../target/near_fox.opt.wasm',import.meta.url);
const upgrade=process.env.FOX_UPGRADE_WASM || new URL('../target/epoch-upgrade/wasm32-unknown-unknown/release/near_fox.wasm',import.meta.url);
const owner='operator.testnet', contract='fox.'+owner, alice='alice.test.near', bob='bob.test.near';

// Exercise both exact modules against the same raw storage, independently of
// Sandbox's legacy Wasm preparation pipeline. Real chain execution is separate.
function execute(module, storage, method, args, caller, deposit=0n) {
  const registers=new Map();
  let instance,result;
  const read=(len,ptr)=>Buffer.from(new Uint8Array(instance.exports.memory.buffer,Number(ptr),Number(len)));
  const write=(bytes,ptr)=>new Uint8Array(instance.exports.memory.buffer,Number(ptr),bytes.length).set(bytes);
  const reg=(id,value)=>registers.set(id,Buffer.from(value));
  const key=(len,ptr)=>read(len,ptr).toString('hex');
  const hosts={
    input:id=>reg(id,JSON.stringify(args)),
    current_account_id:id=>reg(id,contract),
    predecessor_account_id:id=>reg(id,caller),
    register_len:id=>registers.has(id)?BigInt(registers.get(id).length):((1n<<64n)-1n),
    read_register:(id,ptr)=>write(registers.get(id),ptr),
    value_return:(len,ptr)=>{result=JSON.parse(read(len,ptr));},
    panic_utf8:(len,ptr)=>{throw Error(read(len,ptr).toString());},
    log_utf8:()=>{},
    sha256:(len,ptr,id)=>reg(id,createHash('sha256').update(read(len,ptr)).digest()),
    storage_has_key:(len,ptr)=>storage.has(key(len,ptr))?1n:0n,
    storage_usage:()=>BigInt([...storage].reduce((n,[k,v])=>n+k.length/2+v.length+40,0)),
    attached_deposit:ptr=>{
      const value=Buffer.alloc(16);
      value.writeBigUInt64LE(deposit & ((1n<<64n)-1n));
      value.writeBigUInt64LE(deposit>>64n,8);
      write(value,ptr);
    },
    storage_read:(len,ptr,id)=>{
      const value=storage.get(key(len,ptr));
      if(!value)return 0n;
      reg(id,value);
      return 1n;
    },
    storage_write:(len,ptr,valueLen,valuePtr,id)=>{
      const k=key(len,ptr);
      const prior=storage.get(k);
      if(prior)reg(id,prior);
      storage.set(k,read(valueLen,valuePtr));
      return prior?1n:0n;
    },
    storage_remove:(len,ptr,id)=>{
      const k=key(len,ptr);
      const prior=storage.get(k);
      if(!prior)return 0n;
      reg(id,prior);
      storage.delete(k);
      return 1n;
    },
    promise_batch_create:()=>0n,
    promise_batch_action_transfer:()=>{},
  };
  const env=Object.fromEntries(WebAssembly.Module.imports(module).map(({name})=>[
    name,hosts[name]??(()=>{throw Error('Unexpected host call: '+name);}),
  ]));
  instance=new WebAssembly.Instance(module,{env});
  instance.exports[method]();
  return result;
}

function legacyFixture(){
  const legacyBytes=readFileSync(original),upgradeBytes=readFileSync(upgrade);
  assert.equal(hash(legacyBytes),deployedHash);
  assert.equal(hash(upgradeBytes),upgradeHash);
  const legacy=new WebAssembly.Module(legacyBytes),next=new WebAssembly.Module(upgradeBytes);
  const storage=new Map();
  const call=(module,name,args={},account=owner,deposit=0n)=>execute(module,storage,name,args,account,deposit);
  call(legacy,'new',{owner_id:owner});
  for(let id=1;id<=88;id++) {
    const token_id=String(id).padStart(3,'0');
    call(legacy,'nft_mint',{token_id,receiver_id:id%2?alice:bob,token_metadata:{
      title:'Fox #'+token_id,media:'https://example.test/'+token_id+'.png',media_hash:Buffer.alloc(32).toString('base64'),copies:1,
    }},owner,10n**23n);
  }
  call(legacy,'nft_approve',{token_id:'045',account_id:bob},alice,10n**22n);
  return {legacy,next,call,storage};
}

test('exact deployed Fox Wasm state remains readable and transferable after the pinned upgrade',()=>{
  const {legacy,next,call}=legacyFixture();
  const page={from_index:'0',limit:88};
  assert.equal(call(next,'nft_total_supply'),'88');
  assert.deepEqual(call(next,'nft_metadata'),call(legacy,'nft_metadata'));
  assert.deepEqual(call(next,'nft_tokens',page),call(legacy,'nft_tokens',page));
  assert.equal(call(next,'nft_is_approved',{token_id:'045',approved_account_id:bob}),true);
  assert.equal(call(next,'get_ownership_epoch',{token_id:'045'}),'0');
  call(next,'nft_transfer',{receiver_id:bob,token_id:'045'},alice,1n);
  call(next,'nft_transfer',{receiver_id:alice,token_id:'045'},bob,1n);
  assert.equal(call(next,'get_ownership_epoch',{token_id:'045'}),'2');
  assert.equal(call(next,'get_ownership_epoch',{token_id:'088'}),'0');
  assert.equal(call(next,'nft_token',{token_id:'045'}).owner_id,alice);
});


test('NEAR Sandbox upgrades raw storage written by the exact deployed Wasm', {
  skip: process.env.FOX_EXACT_SANDBOX !== '1',
},async()=>{
  const {Worker}=await import('near-workspaces');
  const {legacy,call,storage}=legacyFixture();
  const page={from_index:'0',limit:88};
  const expected=call(legacy,'nft_tokens',page);
  const worker=await Worker.init();
  try {
    const root=worker.rootAccount;
    const fox=await root.createSubAccount('fox');
    await fox.deploy(original);
    await fox.patchStateRecords({records:[...storage].map(([key,value])=>({
      Data:{account_id:fox.accountId,data_key:Buffer.from(key,'hex').toString('base64'),value:value.toString('base64')},
    }))});
    await fox.deploy(upgrade);
    assert.deepEqual(await fox.view('nft_tokens',page),expected);
    assert.equal(await fox.view('nft_total_supply',{}),'88');
    assert.equal(await fox.view('nft_is_approved',{token_id:'045',approved_account_id:bob}),true);
    assert.equal(await fox.view('get_ownership_epoch',{token_id:'045'}),'0');
    const lender=await root.createSubAccount('alice'),borrower=await root.createSubAccount('bob');
    assert.equal(lender.accountId,alice);
    await lender.call(fox,'nft_transfer',{receiver_id:borrower.accountId,token_id:'045'},{attachedDeposit:'1'});
    await borrower.call(fox,'nft_transfer',{receiver_id:lender.accountId,token_id:'045'},{attachedDeposit:'1'});
    assert.equal(await fox.view('get_ownership_epoch',{token_id:'045'}),'2');
    assert.equal((await fox.view('nft_token',{token_id:'045'})).owner_id,lender.accountId);
  } finally {await worker.tearDown();}
});
