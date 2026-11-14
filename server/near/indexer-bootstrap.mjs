import { createFinalizedTestnetBlockSource } from './finalized-block-source.mjs';
import { createEconomyIndexer } from './indexer.mjs';
import { createEconomyReadModels } from './read-models.mjs';
import { viewNearContract } from '../../src/ui/near-testnet-assets.js';
import { atomic } from '../../src/economy/schema.js';
import { randomUUID } from 'node:crypto';
import { testnetRequest } from './testnet-rpc.mjs';
import { reconcileLedger } from '../../tools/near/reconcile-ledger.mjs';

export function bootstrapEconomyIndex({ database, environment = process.env }) {
  const contractId=environment.NEAR_ECONOMY_CONTRACT;
  const startHeight=Number(environment.NEAR_INDEX_START_HEIGHT);
  if(!environment.NEAR_INDEX_START_HEIGHT || environment.NEAR_INDEX_ENABLED === '0')return null;
  if(!contractId||!Number.isSafeInteger(startHeight)||startHeight<1)throw new Error('Economy index configuration is incomplete');
  const source=createFinalizedTestnetBlockSource({
    apiKey:environment.NEAR_INDEX_FASTNEAR_API_KEY,
    rpcOrigin:environment.NEAR_INDEX_RPC_URL,
    archivalRpcOrigin:environment.NEAR_INDEX_ARCHIVAL_RPC_URL,
    dataOrigin:environment.NEAR_INDEX_DATA_URL,
  });
  const settings={network:'near-testnet',contractId,startHeight,getFinalizedBlock:source};
  const index=createEconomyIndexer(database,settings);
  const read=createEconomyReadModels({database,...settings});
  const owner = randomUUID();
  const leaseMs = 45_000;
  database.exec(`CREATE TABLE IF NOT EXISTS near_economy_index_lease (
    contract_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`);
  const acquire = database.prepare(`INSERT INTO near_economy_index_lease VALUES(?,?,?)
    ON CONFLICT(contract_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE owner=excluded.owner OR expires_at<=?`);
  const release = database.prepare('DELETE FROM near_economy_index_lease WHERE contract_id=? AND owner=?');
  const hasLease = () => {
    const time = Date.now();
    return acquire.run(contractId,owner,time+leaseMs,time).changes === 1;
  };
  let head=null,error=null,retryAt=0,retryDelay=5000;
  let ledger=null,custody=null,nextLedgerRead=0;
  const batchSize=Number(environment.NEAR_INDEX_BATCH_SIZE ?? (environment.NEAR_INDEX_FASTNEAR_API_KEY ? 12 : 4));
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('Invalid economy index batch size');
  }
  async function refreshLedger(){
    if(Date.now()<nextLedgerRead)return;
    nextLedgerRead=Date.now()+30000;
    try {
      const {value,blockHeight,blockHash}=await viewNearContract(contractId,'get_ledger');
      const buckets=['rewardAvailable','campaignAvailable','fixedReserved','rewardReserved','rewardInFlight','rewardPaid'];
      for(const key of buckets)atomic(value[key]);
      ledger={blockHeight,blockHash,observedAt:Date.now(),
        fundedAtomic:buckets.reduce((total,key)=>total+atomic(value[key]),0n).toString(),
        availableAtomic:value.rewardAvailable,campaignAtomic:value.campaignAvailable,paidAtomic:value.rewardPaid};
      if (environment.NEAR_TOKEN_CONTRACT) {
        const rpc = async (method, params) => {
          const response = await testnetRequest(method, params, {id:'economy-custody'});
          const {result,error} = await response.json();
          if (!response.ok || error || !result) throw Error('Custody RPC unavailable');
          return result;
        };
        const report = await reconcileLedger({economy:contractId,token:environment.NEAR_TOKEN_CONTRACT,
          rpc,block:{height:blockHeight,hash:blockHash}});
        if (report.status !== 'UNKNOWN') custody={...report,observedAt:Date.now()};
      }
    }catch{
      // The last finalized observation remains available during an RPC outage.
    }
  }
  return {
    async tick(){
      await refreshLedger();
      if(Date.now()<retryAt || !hasLease())return;
      try {
        head=await source.getFinalizedHead();
        for(let i=0;i<batchSize;i++){
          if(!hasLease())break;
          const current=index.cursor();
          if(current && current.height>=head.height)break;
          if((await index.ingestNext(head)).status==='UNAVAILABLE')break;
        }
        error=null;
        retryDelay=5000;
      }catch(problem){
        error=problem.message;
        const suggested=Number.isFinite(problem.retryAfterMs)?problem.retryAfterMs:0;
        const delay=Math.max(retryDelay,suggested,problem.status===429?30_000:0);
        retryAt=Date.now()+delay;
        acquire.run(contractId,owner,retryAt+leaseMs,Date.now());
        retryDelay=Math.min(60000,retryDelay*2);
        throw problem;
      }
    },
    close(){release.run(contractId,owner);},
    cosmeticSaleIds: read.cosmeticSaleIds,
    snapshot(){
      const value=read.snapshot({finalizedHead:head});
      return {...value,ledger,custody,status:error||!head?'SYNCING':value.status,
        latestFinalizedBlock:head,lagBlocks:head && value.cursor ? Math.max(0,head.height-value.cursor.height) : null,
        retryAtMs:Date.now()<retryAt?retryAt:null,error:error?'Indexer source is unavailable. Last confirmed data is shown.':null};
    },
  };
}
