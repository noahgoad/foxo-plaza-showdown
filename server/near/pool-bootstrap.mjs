import {readFile} from 'node:fs/promises';
import {createFixedTransactionTransport} from './transaction-transport.mjs';
import {preparePoolBossReceipt} from './pool-boss-receipt.mjs';
import {poolDeployment} from '../../assets/near-fox/pool-deployment.js';
import {testnetRequest} from './testnet-rpc.mjs';

export async function bootstrapPool({database, config, environment=process.env}) {
  const signerId=environment.NEAR_SETTLEMENT_SIGNER;
  const keyFile=environment.NEAR_SETTLEMENT_KEY_FILE;
  if (!signerId || !keyFile || !poolDeployment.upgradeCodeHash) return null;
  const economyId=poolDeployment.accountId;
  const rpc=async(method,params)=>{
    const response=await testnetRequest(method,params,{id:'boss-pool'});
    if(!response.ok)throw Error('Pool RPC unavailable');
    const envelope=await response.json();
    if(envelope.error || !envelope.result)throw Error('Pool RPC failed');
    return envelope.result;
  };
  const transport=await createFixedTransactionTransport({database,signerId,economyId,rpc,poolOnly:true,
    secretKey:(await readFile(keyFile,'utf8')).trim()});
  const view=async(method_name,args,block_id)=>{
    const q=await rpc('query',{request_type:'call_function',account_id:economyId,method_name,block_id,
      args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
    if(q.block_hash!==block_id || !Array.isArray(q.result))throw Error('Pool view unavailable');
    return JSON.parse(Buffer.from(q.result).toString());
  };
  const candidates=database.prepare(`SELECT match_id,account_id FROM near_results
    WHERE json_extract(payload,'$.mode')='boss' AND json_extract(payload,'$.won')=1
    AND json_extract(payload,'$.left')=0 AND json_extract(payload,'$.finishedAt')>=?
    ORDER BY json_extract(payload,'$.finishedAt') DESC`);
  const latestClear=database.prepare(`SELECT match_id FROM near_results
    WHERE account_id=? AND json_extract(payload,'$.mode')='boss'
    AND json_extract(payload,'$.won')=1 AND json_extract(payload,'$.left')=0
    AND json_extract(payload,'$.finishedAt')>=?
    ORDER BY json_extract(payload,'$.finishedAt') DESC LIMIT 1`);
  return {async eligibility(accountId) {
    const candidate=latestClear.get(accountId,Date.now()-86400000);
    if(!candidate)return {status:'boss_clear_required'};
    const request=preparePoolBossReceipt({database,matchId:candidate.match_id,player:accountId,poolId:economyId,signerId});
    const {args}=request.actions[0].params;
    const code=await rpc('query',{request_type:'view_account',account_id:economyId,finality:'final'});
    if(code.code_hash!==poolDeployment.upgradeCodeHash)return {status:'unavailable'};
    const recorded=await view('get_boss_clear',{account_id:accountId,match_id:candidate.match_id},code.block_hash);
    return {status:recorded===args.finished_at_ms?'confirmed':'pending'};
  },async tick({onError}) {
    const code=await rpc('query',{request_type:'view_account',account_id:economyId,finality:'final'});
    if(code.code_hash!==poolDeployment.upgradeCodeHash)return;
    const settings=await view('get_config',{},code.block_hash);
    if(settings.receiptSignerId!==signerId || settings.tokenId!==config.contracts.token)return;
    const state=await view('get_pool',{},code.block_hash);
    if(state.ends_at_ms && state.ends_at_ms<=Date.now())return;
    const seen=new Set();
    for(const row of candidates.all(Date.now()-86400000)){
      if(seen.has(row.account_id))continue;
      seen.add(row.account_id);
      try{
        const request=preparePoolBossReceipt({database,matchId:row.match_id,player:row.account_id,poolId:economyId,signerId});
        const {args,methodName}=request.actions[0].params;
        if(await view('get_boss_clear',{account_id:args.account_id,match_id:args.match_id},code.block_hash)===args.finished_at_ms)continue;
        await transport.broadcast(await transport.prepare({method:methodName,args}));
      }catch(error){onError(error);}
    }
  }};
}
