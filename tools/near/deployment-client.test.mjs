import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEconomyDeployment} from '../../src/economy/near-deployment.js';
test('economic signing gate requires matching finalized code and token configuration',async()=>{
  const options={deployment:{accountId:'economy.testnet',codeHash:'hash'},tokenId:'foxo.testnet',readCode:async()=>({codeHash:'hash',blockHash:'final'}),
    view:async(_,method,args,settings)=>{assert.equal(settings.blockId,'final');return {blockHash:'final',value:{network:'near-testnet',foxoContractId:'foxo.testnet'}};}};
  assert.equal((await verifyEconomyDeployment(options)).blockHash,'final');
  await assert.rejects(verifyEconomyDeployment({...options,deployment:{...options.deployment,codeHash:null}}),/not verified/);
  await assert.rejects(verifyEconomyDeployment({...options,readCode:async()=>({codeHash:'different',blockHash:'final'})}),/code changed/);
  await assert.rejects(verifyEconomyDeployment({...options,tokenId:'evil.testnet'}),/configuration/);
});
