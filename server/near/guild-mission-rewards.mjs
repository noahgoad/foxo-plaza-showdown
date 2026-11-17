import { createHash } from 'node:crypto';
import { guildMissionCodeHashes } from '../../assets/near-fox/economy-deployment.js';

export function createGuildMissionRewards({ database, economyId, signerId, rpc, transport }) {
  const pending = new Map();

  async function load(account) {
    const exists = database.prepare("SELECT 1 FROM sqlite_schema WHERE name='near_guild_missions'").get();
    if (!exists) return [];
    const rows = database.prepare(`SELECT g.project_id,g.mode,g.match_id,r.result_hash
      FROM near_guild_missions g JOIN near_results r
        ON g.match_id=r.match_id AND g.account_id=r.account_id
      WHERE g.account_id=? AND g.match_id IS NOT NULL AND length(g.project_id)<=48
        AND g.mode IN ('boss','control','trials')
      ORDER BY g.completed_at DESC LIMIT 100`).all(account);
    if (!rows.length) return [];

    const code = await rpc('query',{request_type:'view_account',account_id:economyId,finality:'final'});
    if (!guildMissionCodeHashes.includes(code.code_hash) || !code.block_hash) return [];
    const view = async (method_name,args) => {
      const result = await rpc('query',{request_type:'call_function',account_id:economyId,
        method_name,finality:'final',args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
      if (!Array.isArray(result.result)) throw Error('Guild reward state unavailable.');
      return JSON.parse(Buffer.from(result.result).toString());
    };
    const config = await view('get_config',{});
    const entries = [];
    let attempted = false;
    for (const row of rows) {
      const campaignId = 'guild-mission:' + row.project_id;
      const digest = createHash('sha256').update([row.project_id,row.mode,account].join('/')).digest('hex');
      const operationId = 'guild-mission:' + digest;
      const read = () => view('get_entitlement',{operation_id:operationId});
      let entitlement = await read();
      if (!entitlement && !attempted && config.settlementEnabled && config.settlementSignerId === signerId) {
        const campaign = await view('get_campaign',{campaign_id:campaignId});
        const now = Date.now();
        if (campaign && !campaign.closed && campaign.closesAtMs > now &&
            BigInt(campaign.maxAward) > 0n && BigInt(campaign.remaining) >= BigInt(campaign.maxAward)) {
          attempted = true;
          const payload = {version:1,network:'near-testnet',contractId:economyId,signerEpoch:config.signerEpoch,
            operationId,campaignId,accountId:account,matchId:row.match_id,rulesVersion:'guild-mission-v1',
            expiresAtMs:Math.min(now+600_000,campaign.closesAtMs),amountAtomic:campaign.maxAward,resultHash:row.result_hash};
          try {
            await transport.broadcast(await transport.prepare({method:'settle_guild_mission',
              args:{project_id:row.project_id,mode:row.mode,payload}}));
          } catch {
            // A timeout may follow a successful send. Read final state before displaying any reward.
          }
          entitlement = await read();
        }
      }
      if (entitlement?.status === 'reserved' && entitlement.accountId === account &&
          entitlement.operationId === operationId) {
        entries.push({source:'guild',mode:row.mode,operationId,amountAtomic:entitlement.amountAtomic});
      }
    }
    return entries;
  }

  return account => {
    if (pending.has(account)) return pending.get(account);
    const request = load(account).finally(() => pending.delete(account));
    pending.set(account,request);
    return request;
  };
}
