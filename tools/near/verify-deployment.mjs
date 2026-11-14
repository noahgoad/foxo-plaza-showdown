import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {utils} from 'near-api-js';

export async function verifyDeployment({manifest,readAsset,rpc}) {
  if(manifest.network!=='near-testnet')throw Error('Testnet deployment only');
  if((await rpc('status',[])).chain_id!=='testnet')throw Error('Wrong RPC network');
  const {header}=await rpc('block',{finality:'final'});
  if(!header?.hash||!Number.isSafeInteger(header.height))throw Error('Finalized block unavailable');
  const reports=[];
  for(const module of manifest.modules) {
    if(!module.accountId.endsWith('.'+manifest.operatorId)||!/^contracts\/near-[a-z]+\/target\/wasm32-unknown-unknown\/release\/[a-z_]+\.wasm$/.test(module.wasm))throw Error('Invalid deployment manifest');
    const bytes=await readAsset(module.wasm);
    if(!WebAssembly.validate(bytes))throw Error('Invalid local Wasm: '+module.name);
    const expectedCodeHash=utils.serialize.base_encode(createHash('sha256').update(bytes).digest());
    const report={name:module.name,accountId:module.accountId,expectedCodeHash,wasmBytes:bytes.length,status:'UNKNOWN',config:null};
    try {
      const account=await rpc('query',{request_type:'view_account',account_id:module.accountId,block_id:header.hash});
      if(account.block_hash!==header.hash || account.block_height!==header.height)throw Error('Finality mismatch');
      report.codeHash=account.code_hash;
      if(account.code_hash!==expectedCodeHash)report.status='CODE_MISMATCH';
      else {
        const query=await rpc('query',{request_type:'call_function',account_id:module.accountId,method_name:'get_config',args_base64:'e30=',block_id:header.hash});
        if(query.block_hash!==header.hash || query.block_height!==header.height || !Array.isArray(query.result))throw Error('Config finality mismatch');
        const config=JSON.parse(Buffer.from(query.result).toString('utf8'));report.config=config;
        const expected=module.name==='economy'?{ownerId:manifest.operatorId,network:'near-testnet',foxoContractId:manifest.tokenId,settlementSignerId:module.init.settlement_signer_id}:
          module.name==='passport'?{ownerId:manifest.operatorId,network:'near-testnet',collectionId:manifest.collectionId,careerSignerId:module.init.career_signer_id}:
          module.name==='pool'?{ownerId:manifest.operatorId,tokenId:manifest.tokenId,receiptSignerId:module.init.receipt_signer_id}:
          module.name==='guild'?{economy_mt:module.init.economy_mt,foxo_contract_id:manifest.tokenId}:
          module.name==='market'?{ownerId:manifest.operatorId,foxoContractId:manifest.tokenId,collectionId:manifest.collectionId,passportContractId:module.init.passport_contract_id}:null;
        if(!expected)throw Error('Unsupported deployment module');
        const target={...expected,...module.runtimeConfig};
        report.status=Object.entries(target).every(([key,value])=>config[key]===value)?'VERIFIED':'CONFIG_MISMATCH';
      }
    } catch(error) {report.reason=error.code??error.message;}
    reports.push(report);
  }
  return {network:manifest.network,block:{hash:header.hash,height:header.height},modules:reports,verified:reports.every(row=>row.status==='VERIFIED')};
}
async function main(){
  const {values}=parseArgs({options:{output:{type:'string'}}});
  const root=new URL('../../',import.meta.url),manifest=JSON.parse(await readFile(new URL('config/economy-deployment-manifest.json',root),'utf8'));
  const endpoint = new URL(process.env.NEAR_DEPLOYMENT_RPC || 'https://near-testnet.drpc.org');
  if (endpoint.protocol !== 'https:') throw Error('The Testnet RPC must use HTTPS.');
  const rpc=async(method,params)=>{const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({jsonrpc:'2.0',id:'verify-deployment',method,params})});if(!response.ok)throw Error('RPC HTTP '+response.status);const data=await response.json();if(data.error)throw Object.assign(Error('RPC read failed'),{code:data.error.cause?.name});return data.result;};
  const report=await verifyDeployment({manifest,readAsset:path=>readFile(new URL(path,root)),rpc});
  const output=JSON.stringify(report,null,2)+'\n';
  if(values.output){const path=resolve(values.output);await mkdir(dirname(path),{recursive:true});await writeFile(path,output);console.log('Deployment evidence saved. Verified: '+report.verified);}else console.log(output);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
