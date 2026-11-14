import {actionCreators as action} from '@near-js/transactions';
import {PublicKey} from '@near-js/crypto';
import {openNearWallet} from './game-wallet-entry.js';
import passportUrl from '../../near-passport/target/wasm32-unknown-unknown/release/near_passport.wasm?url';
import poolUrl from '../../near-pool/target/wasm32-unknown-unknown/release/near_pool.wasm?url';
import guildUrl from '../../near-guild/target/wasm32-unknown-unknown/release/near_guild.wasm?url';
import marketUrl from '../../near-market/target/wasm32-unknown-unknown/release/near_market.wasm?url';
import manifest from '../../../config/economy-deployment-manifest.json';
const operator='xuancanh1.testnet',collection='fox.'+operator,token='foxo.'+operator;
const el=Object.fromEntries(['module','connect','refresh','deploy','review','status'].map(id=>[id,document.getElementById(id)]));
let wallet,connected,busy=false,draft=null;
class Code extends Uint8Array {toJSON(){return Array.from(this);}}
const urls={passport:passportUrl,pool:poolUrl,guild:guildUrl,market:marketUrl};
const modules=Object.fromEntries(manifest.modules.filter(row=>Object.hasOwn(urls,row.name))
  .map(row=>[row.name,{url:urls[row.name],args:row.init,accountId:row.accountId}]));
const expectedConfig={
  passport:{ownerId:operator,collectionId:collection,network:'near-testnet',careerSignerId:modules.passport.args.career_signer_id},
  pool:{ownerId:operator,tokenId:token,receiptSignerId:modules.pool.args.receipt_signer_id},
  guild:{economy_mt:modules.guild.args.economy_mt,foxo_contract_id:token},
  market:{ownerId:operator,foxoContractId:token,collectionId:collection,passportContractId:modules.market.args.passport_contract_id},
};
function base58(bytes){const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n,out='';for(const byte of bytes)n=n*256n+BigInt(byte);while(n){out=chars[Number(n%58n)]+out;n/=58n;}for(const byte of bytes){if(byte)break;out='1'+out;}return out;}
async function rpc(method,params){const response=await fetch('https://near-testnet.drpc.org',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({jsonrpc:'2.0',id:'fox-module',method,params})});if(!response.ok)throw Error('Testnet RPC unavailable');const data=await response.json();if(data.error)throw Object.assign(Error('Testnet read failed'),{kind:data.error.cause?.name});if(!data.result)throw Error('Testnet result unavailable');return data.result;}
async function inspect(){
 draft=null;el.deploy.disabled=true;
 if((await rpc('status',[])).chain_id!=='testnet')throw Error('Wrong network');
 const name=el.module.value,spec=modules[name],contract=spec.accountId;
 const response=await fetch(spec.url);if(!response.ok)throw Error('Local Wasm unavailable');const bytes=await response.arrayBuffer();
 if(!WebAssembly.validate(bytes))throw Error('Local Wasm invalid');
 const hash=base58(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
 const account=await rpc('query',{request_type:'view_account',account_id:contract,finality:'final'}).catch(error=>{if(error.kind==='UNKNOWN_ACCOUNT')return null;throw error;});
 const funding=(BigInt(bytes.byteLength)+80000n)*10n**19n;
 el.review.textContent=JSON.stringify({network:'near-testnet',contract,wasmCodeHash:hash,wasmBytes:bytes.byteLength,exists:!!account,storageTransferYocto:funding.toString(),init:spec.args,automaticFunding:false,automaticEnable:false},null,2);
 if(account){
   if(account.code_hash!==hash)throw Error('Existing contract code differs from the reviewed Wasm.');
   const view=await rpc('query',{request_type:'call_function',account_id:contract,method_name:'get_config',
     args_base64:'e30=',block_id:account.block_hash});
   if(view.block_hash!==account.block_hash||view.block_height!==account.block_height||!Array.isArray(view.result))throw Error('Finalized config unavailable.');
   const config=JSON.parse(new TextDecoder().decode(Uint8Array.from(view.result)));
   if(!Object.entries(expectedConfig[name]).every(([key,value])=>config[key]===value))throw Error('Contract configuration differs from the deployment manifest.');
   el.status.textContent='Wasm and initialization verified at finalized block '+account.block_height+'.';
   return;
 }
 if(!connected)return;
 const [keys,balance]=await Promise.all([rpc('query',{request_type:'view_access_key_list',account_id:operator,finality:'final'}),rpc('query',{request_type:'view_account',account_id:operator,finality:'final'})]);
 const full=keys.keys.filter(row=>row.access_key.permission==='FullAccess');
 const key=full.find(row=>row.public_key===connected.publicKey)||(full.length===1?full[0]:null);
 if(!key)throw Error('Cannot identify the operator public key.');if(BigInt(balance.amount)<=funding+10n**22n)throw Error('Insufficient deploy balance plus gas reserve.');
 draft={name,contract,hash,actions:[action.createAccount(),action.transfer(funding),action.addKey(PublicKey.fromString(key.public_key),action.fullAccessKey()),action.deployContract(new Code(bytes)),action.functionCall('new',spec.args,40000000000000n,0n)]};
 el.deploy.disabled=false;
}
async function run(fn){if(busy)return;busy=true;el.deploy.disabled=el.connect.disabled=el.refresh.disabled=el.module.disabled=true;try{if(fn)await fn();await inspect();}catch(error){draft=null;el.deploy.disabled=true;el.status.textContent=error.message;}finally{busy=false;el.connect.disabled=!wallet||!!connected;el.refresh.disabled=el.module.disabled=false;}}
el.connect.onclick=()=>run(async()=>{connected=(await wallet.signIn({})).find(row=>row.accountId===operator);if(!connected){await wallet.signOut();throw Error('Select '+operator);}});
el.refresh.onclick=()=>run();el.module.onchange=()=>run();
el.deploy.onclick=()=>run(async()=>{
 const reviewed=draft;if(!reviewed)throw Error('Refresh deployment review first');
 await inspect();if(!draft||draft.contract!==reviewed.contract||draft.hash!==reviewed.hash)throw Error('Deployment review changed');
 el.status.textContent='Review the deployment transaction in Intear.';
 const result=await wallet.signAndSendTransaction({signerId:operator,receiverId:reviewed.contract,actions:draft.actions});
 if(typeof result?.status?.SuccessValue!=='string'||!result.transaction?.hash)throw Error('Deployment outcome unknown. Refresh before retrying.');
 el.status.textContent='Wallet returned transaction '+result.transaction.hash+'. Checking finalized code…';
});
openNearWallet().then(value=>{wallet=value;el.connect.disabled=false;}).catch(error=>el.status.textContent=error.message);run();
