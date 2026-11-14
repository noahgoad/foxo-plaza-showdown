import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {utils} from 'near-api-js';
import {verifyDeployment} from './verify-deployment.mjs';
test('deployment verification pins code and configuration, rejecting mismatches and unavailable accounts',async()=>{
  const bytes=Buffer.from([0,97,115,109,1,0,0,0]);
  const hash=utils.serialize.base_encode(createHash('sha256').update(bytes).digest());
  const manifest={network:'near-testnet',operatorId:'owner.testnet',tokenId:'token.testnet',collectionId:'fox.testnet',
    modules:[{name:'pool',accountId:'pool.owner.testnet',wasm:'contracts/near-pool/target/wasm32-unknown-unknown/release/near_pool.wasm',init:{receipt_signer_id:'signer.testnet'}}]};
  let badCode=false,badConfig=false,missing=false;
  const rpc=async(method,params)=>{
    if(method==='status')return {chain_id:'testnet'};
    if(method==='block')return {header:{hash:'final',height:1}};
    assert.equal(params.block_id,'final');
    if(missing)throw Object.assign(Error('missing'),{code:'UNKNOWN_ACCOUNT'});
    const base={block_hash:'final',block_height:1};
    if(params.request_type==='view_account')return {...base,code_hash:badCode?'other':hash};
    return {...base,result:[...Buffer.from(JSON.stringify({ownerId:'owner.testnet',tokenId:badConfig?'fake.testnet':'token.testnet',receiptSignerId:'signer.testnet'}))]};
  };
  const run=()=>verifyDeployment({manifest,readAsset:async()=>bytes,rpc});
  assert.equal((await run()).verified,true);
  badCode=true;assert.equal((await run()).modules[0].status,'CODE_MISMATCH');
  badCode=false;badConfig=true;assert.equal((await run()).modules[0].status,'CONFIG_MISMATCH');
  missing=true;assert.equal((await run()).modules[0].status,'UNKNOWN');
  await assert.rejects(verifyDeployment({manifest:{...manifest,network:'mainnet'},readAsset:async()=>bytes,rpc}),/Testnet/);
});
