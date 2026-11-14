import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { guildTermsJSON, guildTermsHash, contributionDraft, contributionMatches, readGuildSnapshot, guildGate } from '../../src/economy/near-guild.js';
const p={guild_id:'fox',deadline:'1800000000000000001',sku:'guild-banner-beacon-v2',fee_payer:'alice.testnet',status:'open',fee_state:'unfunded',totals:['0','0','0']};
const opts={contract:'guild.testnet',projectId:'banner',project:p};
test('guild terms match sorted serde_json bytes including exact nanosecond deadline',async()=>{
 const raw=guildTermsJSON(opts);assert.match(raw,/"deadline":1800000000000000001,/);
 assert.equal(await guildTermsHash(opts),createHash('sha256').update(raw).digest('hex'));
 assert.throws(()=>guildTermsJSON({...opts,project:{...p,deadline:1800000000000000001}}),/deadline/);
});
test('contributions are exact MT calls with immutable persisted operation identity',()=>{
 const draft=contributionDraft({guild:'guild.testnet',economy:'eco.testnet',account:'alice.testnet',projectId:'banner',project:{...p,terms_hash:'a'.repeat(64)},operationId:'op-1',amounts:['12','1','0']});
 assert.equal(draft.method,'mt_batch_transfer_call');assert.deepEqual(draft.args.token_ids,['alloy','core']);assert.deepEqual(draft.args.amounts,['12','1']);
 assert.ok(contributionMatches({project_id:'banner',contributor:'alice.testnet',token_ids:['alloy','core'],amounts:['12','1'],status:'escrow'},draft));
 assert.throws(()=>contributionDraft({...draft,economy:'eco.testnet',guild:'guild.testnet',account:'alice.testnet',projectId:'banner',operationId:'op-1',project:{...p,terms_hash:'a'.repeat(64)},amounts:['49','0','0']}),/target/);
});
test('guild action gates membership, full targets, fee, expiry and archived display',()=>{
 const state={guild:{active:true,leader:'alice.testnet',treasurer:'bob.testnet'},member:true,account:'alice.testnet',project:{...p,deadline:'9999999999999999999'}};
 assert.throws(()=>guildGate('commit',state),/fully funded/);
 assert.throws(()=>guildGate('contribute',{...state,member:false}),/member/);
 assert.throws(()=>guildGate('contribute',{...state,project:{...state.project,status:'committing'}}),/closed/);
 assert.throws(()=>guildGate('commit',{...state,project:{...state.project,totals:['48','2','2']}}),/15 FOXO/);
});
test('snapshot fails closed before querying unpinned deployment',async()=>{
 await assert.rejects(readGuildSnapshot({deployment:{accountId:null},economy:{accountId:null}}),/deployment/);
});


test('guild snapshot pins code and configuration at finality and rejects bad terms',async()=>{
 const project={...p,sku:'guild-banner-beacon-v2'};project.terms_hash=await guildTermsHash({contract:'guild.testnet',projectId:'banner',project});
 const calls=[];
 const opts={deployment:{accountId:'guild.testnet',codeHash:'g'},economy:{accountId:'eco.testnet',codeHash:'e'},token:'foxo.testnet',account:'alice.testnet',guildId:'fox',projectId:'banner',
  readCode:async(id,settings)=>{calls.push({id,settings});return {codeHash:id==='guild.testnet'?'g':'e',blockHash:'final'};},
  view:async(id,method,args,settings)=>{assert.equal(settings.blockId,'final');const value={get_config:id==='guild.testnet'?{economy_mt:'eco.testnet',foxo_contract_id:'foxo.testnet'}:{network:'near-testnet',foxoContractId:'foxo.testnet'},get_mt_migration:{finalized:true},guild:{active:true},member:true,project}[method];return {blockHash:'final',value};}};
 assert.equal((await readGuildSnapshot(opts)).project.terms_hash,project.terms_hash);assert.deepEqual(calls.at(-1).settings,{blockId:'final'});
 await assert.rejects(readGuildSnapshot({...opts,readCode:async()=>({codeHash:'wrong',blockHash:'final'})}),/code hash mismatch/);
 project.terms_hash='0'.repeat(64);await assert.rejects(readGuildSnapshot(opts),/terms hash/);
});
