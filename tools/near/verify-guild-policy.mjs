import {economyDeployment} from '../../assets/near-fox/economy-deployment.js';
import { readFile } from 'node:fs/promises';

const manifest=JSON.parse(await readFile(new URL('../../config/economy-deployment-manifest.json',import.meta.url),'utf8'));
const pins=JSON.parse(await readFile(new URL('../../contracts/near-fox/mint-console/activation-pins.json',import.meta.url),'utf8'));
const economy=manifest.modules.find(row=>row.name==='economy').accountId;
const guild=manifest.modules.find(row=>row.name==='guild').accountId;
const rpc=async(method,params)=>{
  const response=await fetch('https://near-testnet.drpc.org',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'verify-guild-policy',method,params}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Testnet RPC HTTP '+response.status);
  const {result,error}=await response.json();
  if(error||!result)throw new Error('Guild policy RPC query failed');
  return result;
};
if((await rpc('status',[])).chain_id!=='testnet')throw new Error('Wrong network');
const {header}=await rpc('block',{finality:'final'});
async function atBlock(account_id,params){
  const result=await rpc('query',{account_id,block_id:header.hash,...params});
  if(result.block_hash!==header.hash||result.block_height!==header.height)throw new Error('Finalized block mismatch');
  return result;
}
for(const id of [economy,guild]){
  const code=await atBlock(id,{request_type:'view_account'});
  if(!(id===economy ? economyDeployment.acceptedCodeHashes : [pins[id]]).includes(code.code_hash))throw new Error('Unexpected Wasm for '+id);
}
const account=Buffer.from(guild),length=Buffer.alloc(4);
length.writeUInt32LE(account.length);
const key=Buffer.concat([Buffer.from('guild/v1/policy'),length,account]).toString('base64');
const state=await atBlock(economy,{request_type:'view_state',prefix_base64:key});
const row=state.values.find(entry=>entry.key===key);
if(!row)throw new Error('Guild commit policy has not been configured');
const bytes=Buffer.from(row.value,'base64');
if(bytes.length!==17||bytes[0]!==1)throw new Error('Guild commit policy is disabled or invalid');
const credit=bytes.readBigUInt64LE(1)+(bytes.readBigUInt64LE(9)<<64n);
console.log(JSON.stringify({network:'near-testnet',economy,guild,blockHeight:header.height,
  blockHash:header.hash,commitEnabled:true,storageCreditYoctoNear:credit.toString()},null,2));

