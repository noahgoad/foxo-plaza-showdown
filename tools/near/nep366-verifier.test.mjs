import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {KeyPair, transactions, utils} from 'near-api-js';
import {createNep366Verifier} from '../../server/near/nep366-verifier.mjs';

const receiverId = 'economy.testnet';
const pair = KeyPair.fromRandom('ed25519');
const senderId = 'alice.testnet';
const block = {header:{hash:'pinned-block',height:100,gas_price:'100000000'}};
const permission = {FunctionCall:{receiver_id:receiverId,method_names:['claim']}};
function fixture() {
  const state = {key:{block_hash:block.header.hash,nonce:7,permission},chain:'testnet'};
  const rpc = async (method, params) => {
    if(method==='status') return {chain_id:state.chain};
    if(method==='block') return block;
    if(method==='query') {
      assert.equal(params.block_id,block.header.hash);
      assert.equal(params.account_id,senderId);
      return state.key;
    }
    if(method==='EXPERIMENTAL_protocol_config') {
      assert.equal(params.block_id,block.header.hash);
      const fee={execution:10,send_not_sir:8,send_sir:5};
      return {chain_id:'testnet',max_gas_price:'1000000000000',gas_limit:1_000_000_000_000_000,
        gas_price_adjustment_rate:[1,100],runtime_config:{transaction_costs:{
          action_receipt_creation_config:fee,
          action_creation_config:{delegate_cost:fee,function_call_cost:fee,function_call_cost_per_byte:fee},
        }}};
    }
    throw Error(method);
  };
  const verify=createNep366Verifier({rpc,maxHeightDelta:10});
  const input = {
    senderId, receiverId, nonce:'8', maxBlockHeight:'108', publicKey:pair.getPublicKey().toString(),
    methodName:'claim', argsBase64:'e30=', gas:'1000000000000', deposit:'0',
  };
  function sign(fields = input) {
    const delegateAction = {
      senderId:fields.senderId,receiverId:fields.receiverId,nonce:BigInt(fields.nonce),
      maxBlockHeight:BigInt(fields.maxBlockHeight),publicKey:pair.getPublicKey(),
      actions:[transactions.functionCall(fields.methodName,Buffer.from(fields.argsBase64,'base64'),BigInt(fields.gas),BigInt(fields.deposit))],
    };
    const signature=pair.sign(createHash('sha256').update(transactions.encodeDelegateAction(delegateAction)).digest()).signature;
    return {...fields,signature:utils.serialize.base_encode(signature)};
  }
  return {verify,input,sign,state};
}

test('checks canonical NEP-366 signature, scoped finalized access key and bounded height',async()=>{
  const {verify,sign,state,input}=fixture();
  const approved=await verify(sign(),{accountId:senderId,issuedAtMs:10,expiresAtMs:100});
  assert.equal(approved.accountId,senderId);
  assert.equal(approved.maximumCostAtomic,'1000000000198000000000');
  assert.equal(approved.signatureValid,true);
  assert.equal(approved.nonceValid,true);
  await assert.rejects(verify({...sign(),argsBase64:'e1tdfQ=='},{accountId:senderId}),/signature/);
  const check=(signed)=>verify(signed,{accountId:senderId,issuedAtMs:10,expiresAtMs:100});
  await assert.rejects(check(sign({...input,maxBlockHeight:'111'})),/height/);
  await assert.rejects(check(sign({...input,deposit:'1'})),/deposit/);
  await assert.rejects(check(sign({...input,nonce:'9'})),/nonce/);
  state.key={...state.key,permission:'FullAccess'};
  await assert.rejects(check(sign()),/permission/);
});
