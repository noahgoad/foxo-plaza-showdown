import { createRankingPilots } from './ranking-pilot.mjs';
import { readFile } from 'node:fs/promises';
import { createFixedRewardService } from './fixed-reward-service.mjs';
import { createRankingDrafts } from './ranking.mjs';
import { createRankingDispatch } from './ranking-dispatch.mjs';
import { createFixedTransactionTransport } from './transaction-transport.mjs';
import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';
import { testnetRequest } from './testnet-rpc.mjs';
import { createGuildMissionRewards } from './guild-mission-rewards.mjs';

export async function bootstrapFixedRewards({ database, config, environment = process.env }) {
  if (!config.features.nearRewards) return null;
  const { NEAR_ECONOMY_CONTRACT: economyId, NEAR_SETTLEMENT_SIGNER: signerId,
    NEAR_SETTLEMENT_KEY_FILE: keyFile, NEAR_FIXED_CAMPAIGN: campaignId,
    NEAR_SEASON_START_MS: start } = environment;
  const seasonStartMs = Number(start);
  if (!economyId || !signerId || !keyFile || !campaignId || !Number.isSafeInteger(seasonStartMs)) {
    throw new Error('Fixed reward configuration is incomplete');
  }
  const rpc = async (method, params) => {
    const response = await testnetRequest(method, params, { id: 'fixed-rewards', timeoutMs: 15_000 });
    if (!response.ok) throw new Error('Fixed reward RPC unavailable');
    const envelope = await response.json();
    if (envelope.error || envelope.result === undefined) throw new Error('Fixed reward RPC failed');
    return envelope.result;
  };
  if (economyId !== economyDeployment.accountId || (await rpc('status', [])).chain_id !== 'testnet') {
    throw new Error('Fixed reward deployment does not match Testnet');
  }
  const code = await rpc('query', { request_type: 'view_account', account_id: economyId, finality: 'final' });
  if (!economyDeployment.acceptedCodeHashes.includes(code.code_hash) || !code.block_hash) throw new Error('Fixed reward Wasm mismatch');
  async function view(method, args) {
    const query = await rpc('query', { request_type: 'call_function', account_id: economyId, block_id: code.block_hash,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    if (query.block_hash !== code.block_hash || !Array.isArray(query.result)) throw new Error('Fixed reward finality mismatch');
    return JSON.parse(Buffer.from(query.result).toString());
  }
  const [contract, campaign] = await Promise.all([
    view('get_config', {}), view('get_campaign', { campaign_id: campaignId }),
  ]);
  if (contract.network !== 'near-testnet' || contract.foxoContractId !== config.contracts.token ||
      contract.settlementSignerId !== signerId || !contract.settlementEnabled ||
      !campaign || campaign.closed || campaign.maxAward !== '5000000000000000000000000' ||
      campaign.closesAtMs !== seasonStartMs + config.pilot.seasonDays * 86_400_000) {
    throw new Error('Fixed reward campaign or signer configuration mismatch');
  }
  const secretKey = (await readFile(keyFile, 'utf8')).trim();
  const enableRanking = config.ranking.enabledModes.length > 0;
  const transport = await createFixedTransactionTransport({ database, economyId, signerId, secretKey, rpc, enableRanking, enableGuildMissions:true });
  const fixed = createFixedRewardService({ database, config, economyId, signerId, campaignId, seasonStartMs,
    rpc, prepare: transport.prepare, broadcast: transport.broadcast, canReplace: transport.canReplace });
  const guildClaims = createGuildMissionRewards({database,economyId,signerId,rpc,transport});
  const claims = async account => {
    const current = fixed.claims(account);
    const guild = await guildClaims(account).catch(() => []);
    return {...current,entries:[...guild,...current.entries]};
  };
  if (!enableRanking) return {...fixed,claims};
  const drafts = createRankingDrafts({ database, config });
  const pilot = createRankingPilots({ database, config, rpc, drafts });
  const ranking = createRankingDispatch({ database, drafts,
    economyId, signerId, rpc, prepare: transport.prepare, broadcast: transport.broadcast, canReplace: transport.canReplace });
  const pendingAccounts = new Set();
  return {
    ...fixed,
    rankingBoard: pilot.board,
    async claims(account) {
      if (pendingAccounts.size < 256) pendingAccounts.add(account);
      const current = await claims(account);
      const entries = await ranking.claimsForAccount(account);
      return { ...current, entries: [...entries, ...current.entries] };
    },
    async tick(options = {}) {
      await fixed.tick(options);
      await ranking.recover(options);
      const onError = options.onError ?? console.error;
      await pilot.stageClosedDay({ onError });
      try {
        await ranking.submitNextDraft(config.ranking.enabledModes);
      } catch (error) {
        onError(error, { action: 'ranking-propose' });
      }
      const account = pendingAccounts.values().next().value;
      if (account) {
        pendingAccounts.delete(account);
        try {
          await ranking.materializeForAccount(account);
        } catch (error) {
          pendingAccounts.add(account);
          onError(error, { action: 'ranking-finalize' });
        }
      }
    },
  };
}
