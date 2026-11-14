import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { utils } from 'near-api-js';
import { createFixedTransactionTransport } from './transaction-transport.mjs';
import { createCareerChain } from './career-chain.mjs';
import { createCareerService } from './career-service.mjs';
import { testnetRequest } from './testnet-rpc.mjs';

export async function bootstrapCareer({ database, passport, usage, config, environment = process.env }) {
  if (!config.features.passport) return null;
  const contractId = environment.NEAR_PASSPORT_CONTRACT;
  const signerId = environment.NEAR_CAREER_SIGNER;
  const file = environment.NEAR_CAREER_KEY_FILE;
  const storageDepositAtomic = environment.NEAR_CAREER_STORAGE_DEPOSIT;
  if (!contractId || !signerId || !file || !storageDepositAtomic) throw new Error('Career signer configuration is incomplete');
  const endpoint = new URL(environment.NEAR_CAREER_RPC || 'https://near-testnet.drpc.org');
  if (endpoint.protocol !== 'https:') throw new Error('Career RPC must use HTTPS');
  const rpc = async (method, params) => {
    const response = await testnetRequest(method, params, { endpoint: endpoint.href.replace(/\/$/, ''), id: 'fox-career', timeoutMs: 15_000 });
    if (!response.ok) throw new Error('Career RPC unavailable');
    const value = await response.json();
    if (value.error || value.result === undefined) throw new Error('Career RPC failed');
    return value.result;
  };
  const collectionId = config.contracts.collection;
  const codeHash = utils.serialize.base_encode(createHash('sha256').update(await readFile(
    new URL('../../contracts/near-passport/target/wasm32-unknown-unknown/release/near_passport.wasm', import.meta.url))).digest());
  async function verifyDeployment() {
    if ((await rpc('status', [])).chain_id !== 'testnet') throw new Error('Career network mismatch');
    const code = await rpc('query', { request_type: 'view_account', account_id: contractId, finality: 'final' });
    if (code.code_hash !== codeHash) throw new Error('Career Wasm mismatch');
    const observed = await rpc('query', { request_type: 'call_function', account_id: contractId,
      block_id: code.block_hash, method_name: 'get_config', args_base64: 'e30=' });
    if (observed.block_hash !== code.block_hash || observed.block_height !== code.block_height ||
        !Array.isArray(observed.result)) throw new Error('Career finality mismatch');
    const value = JSON.parse(Buffer.from(observed.result).toString());
    if (value.network !== 'near-testnet' || value.collectionId !== collectionId ||
        value.careerSignerId !== signerId || value.appendEnabled !== true) throw new Error('Career contract configuration mismatch');
    return {blockHash:code.block_hash,blockHeight:code.block_height};
  }
  await verifyDeployment();
  const secretKey = (await readFile(file, 'utf8')).trim();
  const transport = await createFixedTransactionTransport({ database, signerId, economyId: contractId, secretKey,
    rpc, careerDepositAtomic: storageDepositAtomic });
  const chain = createCareerChain({ database, network: 'near-testnet', contractId, signerId, storageDepositAtomic,
    rpc, canReplace: transport.canReplace, async prepare(draft) {
      await verifyDeployment();
      const action = draft.actions[0].params;
      return transport.prepare({ method: action.methodName, args: action.args });
    }, async broadcast(transaction) {
      await verifyDeployment();
      return transport.broadcast(transaction);
    } });
  const service=createCareerService({ database, passport, usage, chain, contractId, collectionId });
  return {...service,async readCareer(nft,{offset=0,limit=20}={}){
    if(nft.collectionId!==collectionId)throw new Error('Unsupported career collection');
    const block=await verifyDeployment();
    const view=async(method,args)=>{
      const observed=await rpc('query',{request_type:'call_function',account_id:contractId,
        block_id:block.blockHash,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
      if(observed.block_hash!==block.blockHash||observed.block_height!==block.blockHeight||!Array.isArray(observed.result))throw new Error('Career history finality mismatch');
      return JSON.parse(Buffer.from(observed.result).toString());
    };
    const identity={collection_id:collectionId,token_id:nft.tokenId};
    const [summary,records]=await Promise.all([view('get_career',identity),
      view('get_history',{...identity,offset,limit:Math.min(limit,50)})]);
    if(!['revision','matches','wins','bossWins','xp'].every(key=>Number.isSafeInteger(summary[key])&&summary[key]>=0)||
      !Array.isArray(records))throw new Error('Invalid finalized career summary');
    const history=records.map(record=>{
      if(record.collectionId!==collectionId||record.tokenId!==nft.tokenId)throw new Error('Career identity mismatch');
      return {...record,accountId:record.actorId,finishedAt:record.finishedAtMs,finalized:true};
    });
    return {...block,summary,history,nextOffset:offset+history.length<summary.revision?offset+history.length:null};
  }};
}
