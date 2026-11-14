import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { utils, KeyPair } from 'near-api-js';
import { createHash } from 'node:crypto';

const {values}=parseArgs({options:{apply:{type:'boolean',default:false}}});
const root=new URL('../../',import.meta.url);
const configUrl=new URL('config/economy.testnet.json',root);
const config=JSON.parse(await readFile(configUrl,'utf8'));
const manifest=JSON.parse(await readFile(new URL('config/economy-deployment-manifest.json',root),'utf8'));
const setup=JSON.parse(await readFile(new URL('contracts/near-fox/mint-console/backend-setup.json',root),'utf8'));
const rpc=async(method,params)=>{
  const response=await fetch('https://near-testnet.drpc.org',{method:'POST',
    headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),
    body:JSON.stringify({jsonrpc:'2.0',id:'local-enablement',method,params})});
  if(!response.ok)throw Error('RPC HTTP '+response.status);
  const value=await response.json();
  if(value.error||value.result===undefined)throw Error(value.error?.cause?.name||'Testnet RPC failed');
  return value.result;
};
if((await rpc('status',[])).chain_id!=='testnet')throw Error('Wrong network');
const {header}=await rpc('block',{finality:'final'});
const query=async(account_id,request)=>{
  const value=await rpc('query',{account_id,block_id:header.hash,...request});
  if(value.block_hash!==header.hash||value.block_height!==header.height)throw Error('Pinned finality mismatch');
  return value;
};
const view=async(account_id,method_name,args={})=>{
  const value=await query(account_id,{request_type:'call_function',method_name,
    args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
  return JSON.parse(Buffer.from(value.result).toString());
};
const proof={network:'near-testnet',block:{hash:header.hash,height:header.height},features:{}};
for(const module of manifest.modules){
  const expected=utils.serialize.base_encode(createHash('sha256').update(await readFile(new URL(module.wasm,root))).digest());
  const actual=await query(module.accountId,{request_type:'view_account'});
  if(actual.code_hash!==expected)throw Error('Wasm mismatch '+module.name);
}
for(const [name,spec]of Object.entries(setup.signers)){
  const secret=(await readFile(new URL('outputs/near-secrets/'+name+'.key',root),'utf8')).trim();
  if(KeyPair.fromString(secret).getPublicKey().toString()!==spec.publicKey)throw Error('Local signer key differs');
  const access=await query(spec.accountId,{request_type:'view_access_key_list'});
  if(!access.keys.some(row=>row.public_key===spec.publicKey&&row.access_key.permission==='FullAccess'))throw Error('Signer setup needs a wallet signature for '+name);
}
const economy='economy.'+manifest.operatorId,passport='passport.'+manifest.operatorId;
const [economic,career,migration,recipe]=await Promise.all([view(economy,'get_config'),
  view(passport,'get_config'),view(economy,'get_mt_migration'),
  view(economy,'get_recipe',{recipe_id:'violet-fox-finish',recipe_version:1})]);
if(economic.foxoContractId!==config.contracts.token||economic.network!=='near-testnet'||
    economic.settlementSignerId!==setup.signers.settler.accountId||!economic.craftingEnabled||
    !economic.ordersEnabled||!migration?.finalized||!migration.enabled)throw Error('Economy activation needs a wallet signature');
if(career.collectionId!==config.contracts.collection||career.network!=='near-testnet'||
    career.careerSignerId!==setup.signers.career.accountId||!career.appendEnabled)throw Error('Passport activation needs a wallet signature');
const {onchainPilotRecipe}=await import('../../assets/near-fox/economy-catalogue.js');
const expectedRecipe=onchainPilotRecipe();
if(!recipe||recipe.sku!==expectedRecipe.sku||recipe.feeAtomic!==expectedRecipe.feeAtomic||
  Object.keys(expectedRecipe.inputs).some(key=>recipe.inputs[key]!==expectedRecipe.inputs[key]))throw Error('Recipe publication needs a wallet signature');
config.features.passport=true;
config.features.materials=true;
config.features.crafting=true;
config.features.orders=true;
proof.features={passport:true,materials:true,crafting:true,orders:true};
const campaignId='fox-pilot-1-fixed';
const campaign=await view(economy,'get_campaign',{campaign_id:campaignId});
const seasonDuration=28*86400000;
const seasonStartMs=campaign?.closesAtMs-seasonDuration;
const fixedReady=Boolean(economic.settlementEnabled && campaign && !campaign.closed &&
  campaign.maxAward==='5000000000000000000000000' && Number.isSafeInteger(seasonStartMs) &&
  seasonStartMs%86400000===0 && Date.now()<campaign.closesAtMs);
config.features.nearRewards=fixedReady;
proof.features.nearRewards=fixedReady;
if(values.apply){
  if(fixedReady)await writeFile(new URL('config/pilot.testnet.json',root),
    JSON.stringify({campaignId,seasonStartMs},null,2)+'\n');
  await writeFile(configUrl,JSON.stringify(config,null,2)+'\n');
  for(const module of manifest.modules){
    if(module.name==='economy')module.runtimeConfig={settlementSignerId:setup.signers.settler.accountId};
    if(module.name==='passport')module.runtimeConfig={careerSignerId:setup.signers.career.accountId};
  }
  await writeFile(new URL('config/economy-deployment-manifest.json',root),JSON.stringify(manifest,null,2)+'\n');
  await writeFile(new URL('docs/evidence/economy-v2-1/activation-status.json',root),JSON.stringify(proof,null,2)+'\n');
}
console.log(JSON.stringify({...proof,applied:values.apply},null,2));
