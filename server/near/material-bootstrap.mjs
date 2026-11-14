import { readFile } from 'node:fs/promises';
import { createProfessionService } from './professions.mjs';
import { economyDeployment, guildMissionUpgrade } from '../../assets/near-fox/economy-deployment.js';
import { createFixedTransactionTransport } from './transaction-transport.mjs';
import { createMaterialService } from './material-service.mjs';
import { testnetRequest } from './testnet-rpc.mjs';

export async function bootstrapMaterials({ database, config, environment = process.env }) {
  if (!config.features.materials) return null;
  const economyId=environment.NEAR_ECONOMY_CONTRACT;
  const signerId=environment.NEAR_SETTLEMENT_SIGNER;
  const keyFile=environment.NEAR_SETTLEMENT_KEY_FILE;
  if(!economyId||!signerId||!keyFile)throw new Error('Material signer configuration is incomplete');
  const endpoint=new URL(environment.NEAR_MATERIAL_RPC || 'https://near-testnet.drpc.org');
  if(endpoint.protocol!=='https:')throw new Error('Material RPC must use HTTPS');
  const rpc=async(method,params)=>{
    const response=await testnetRequest(method,params,{endpoint:endpoint.href.replace(/\/$/, ''),id:'fox-materials',timeoutMs:15_000});
    if(!response.ok)throw new Error('Material RPC unavailable');
    const result=await response.json();
    if(result.error||result.result===undefined)throw new Error('Material RPC failed');
    return result.result;
  };
  if(economyId!==economyDeployment.accountId)throw new Error('Material contract account mismatch');
  async function verifyDeployment() {
    if((await rpc('status',[])).chain_id!=='testnet')throw new Error('Material network mismatch');
    const code=await rpc('query',{request_type:'view_account',account_id:economyId,finality:'final'});
    if(!economyDeployment.acceptedCodeHashes.includes(code.code_hash))throw new Error('Material Wasm mismatch');
    const view=await rpc('query',{request_type:'call_function',account_id:economyId,block_id:code.block_hash,
      method_name:'get_config',args_base64:'e30='});
    if(view.block_hash!==code.block_hash||view.block_height!==code.block_height||!Array.isArray(view.result))throw new Error('Material finality mismatch');
    const observed=JSON.parse(Buffer.from(view.result).toString());
    if(observed.network!=='near-testnet'||observed.foxoContractId!==config.contracts.token ||
        observed.settlementSignerId!==signerId||observed.craftingEnabled!==true)throw new Error('Material contract configuration mismatch');
    return code.code_hash;
  }
  await verifyDeployment();
  const secretKey=(await readFile(keyFile,'utf8')).trim();
  const transport=await createFixedTransactionTransport({database,economyId,signerId,secretKey,rpc,materialOnly:true});
  const materials = createMaterialService({database,economyId,signerId,rpc,prepare:transport.prepare,
    broadcast:transport.broadcast,canReplace:transport.canReplace,verifyDeployment});
  const professions = createProfessionService({ database, ...transport,
    verifyDeployment: async () => [economyDeployment.professionCodeHash, guildMissionUpgrade.codeHash].includes(await verifyDeployment()),
    view: async (method_name, args) => {
      const response = await rpc('query', { request_type: 'call_function', account_id: economyId,
        method_name, finality: 'final', args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
      return JSON.parse(Buffer.from(response.result).toString());
    },
  });
  return { async tick(options) {
    for (const service of [materials, professions]) {
      try { await service.tick(options); }
      catch (error) { options.onError(error); }
    }
  } };
}
