import { createHuntRelay } from './hunt-relay.mjs';
import { NearWalletAuth } from './near-wallet-auth.mjs';
import { createNearSocialProvider } from './near/social-verifier.mjs';
import { createSocialWalletProvisioner } from './near/social-wallet.mjs';
import { testnetRequest } from './near/testnet-rpc.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const port = Number(process.env.NEAR_RELAY_PORT || process.env.PORT || 8818);
const origins = process.env.NEAR_GAME_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean);
const pilotOrigin = 'http://127.0.0.1:8819';
const socialOrigins = (process.env.NEAR_SOCIAL_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const nearAuth = new NearWalletAuth({
  origins: socialOrigins.length ? [...new Set([...(origins ?? []), ...socialOrigins])] : origins,
  socialOrigins,
  provisionSocialWallet: socialOrigins.length && !process.env.NEAR_SOCIAL_ISSUER && !process.env.NEAR_SOCIAL_CLIENT_ID
    ? createSocialWalletProvisioner() : undefined,
  socialProvider: socialOrigins.length ? createNearSocialProvider({
    clientId: process.env.NEAR_SOCIAL_CLIENT_ID || undefined,
    issuer: process.env.NEAR_SOCIAL_ISSUER || undefined,
  }) : undefined,
});
const options = { nearAuth };
let database;
let rewardTimer;
let telemetryTimer;
let indexTimer;
let indexWork;
let economyIndex;
let settlementWork;
let shuttingDown=false;
if (process.env.NEAR_QUARTERMASTER_KEY_FILE) {
  const { openRewardDatabase } = await import('./rewards/database.mjs');
  const { bootstrapQuartermasterPilot } = await import('./near/quartermaster-pilot.mjs');
  const file = resolve(process.env.NEAR_ECONOMY_DB || 'outputs/near-economy.sqlite');
  mkdirSync(dirname(file), { recursive: true });
  database = openRewardDatabase(file);
  options.nearRoutes = await bootstrapQuartermasterPilot({ database, keyFile:process.env.NEAR_QUARTERMASTER_KEY_FILE,
    round:Number(process.env.NEAR_QUARTERMASTER_ROUND ?? '1'),
    origin:pilotOrigin, rpc:async (method, params) => {
      const response = await testnetRequest(method, params, { id:'quartermaster-pilot', timeoutMs:15_000 });
      if (!response.ok) throw Error('Quartermaster RPC unavailable.');
      const envelope = await response.json();
      if (envelope.error || envelope.result === undefined) throw Error('Quartermaster RPC failed.');
      return envelope.result;
    } });
} else if (process.env.NEAR_AUTHORITATIVE_RESULTS === '1') {
  const { createResultOutbox } = await import('./near/result-outbox.mjs');
  const { rankingMetricsFromSimulation } = await import('./near/ranking-rubric.mjs');
  const { openRewardDatabase } = await import('./rewards/database.mjs');
  const { SimulationRunner } = await import('./rewards/runner.mjs');
  const { createFoxPassport } = await import('./near/passport.mjs');
  const { createFoxUsage } = await import('./near/usage.mjs');
  const { createFoxPassportRoutes } = await import('./near/passport-routes.mjs');
  const { createGuildMissions } = await import('./near/guild-missions.mjs');
  const { createGuildCommunity } = await import('./near/community-events.mjs');
  const { createProductTelemetry } = await import('./near/product-telemetry.mjs');
  const file = resolve(process.env.NEAR_ECONOMY_DB || 'outputs/near-economy.sqlite');
  mkdirSync(dirname(file), { recursive: true });
  database = openRewardDatabase(file);
  const telemetry = createProductTelemetry(database);
  telemetry.expire();
  telemetryTimer=setInterval(()=>telemetry.expire(),3_600_000).unref();
  const { bootstrapFixedRewards } = await import('./near/reward-bootstrap.mjs');
  const config = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/economy.testnet.json', import.meta.url), 'utf8'));
  const practiceOnly = process.env.NEAR_PRACTICE_ONLY === '1';
  if (practiceOnly) {
    Object.assign(config.features, { nearRewards:false, passport:false, materials:false });
    config.ranking.enabledModes = [];
  }
  options.nearFixedRewards = await bootstrapFixedRewards({ database, config });
  const usage = createFoxUsage({ database });
  let career;
  const passport = createFoxPassport({ database, usage,
    readCareer:config.features.passport?(...args)=>career.readCareer(...args):null });
  options.nearUsage = usage;
  options.nearPassport = passport;
  const { bootstrapEconomyIndex } = await import('./near/indexer-bootstrap.mjs');
  economyIndex=bootstrapEconomyIndex({ database });
  const { readPublishedQuartermasterOrders } = await import('./near/quartermaster-orders.mjs');
  const gasBudget = practiceOnly ? '0' : process.env.NEAR_GAS_SPONSOR_BUDGET_ATOMIC;
  let gasSponsor;
  if (gasBudget && gasBudget !== '0') {
    const { NEAR_GAS_SPONSOR_ACCOUNT: signerId, NEAR_GAS_SPONSOR_KEY_FILE: keyFile } = process.env;
    const { poolDeployment } = await import('../assets/near-fox/pool-deployment.js');
    if (!signerId || !keyFile || [poolDeployment.receiptSignerId, process.env.NEAR_SETTLEMENT_SIGNER,
        process.env.NEAR_CAREER_SIGNER].includes(signerId)) throw Error('Use a separate Testnet gas sponsor account.');
    const { readFile } = await import('node:fs/promises');
    const { createGasSponsorDispatch } = await import('./near/gas-sponsor-dispatch.mjs');
    const rpc = async (method, params) => {
      const response = await testnetRequest(method, params, { id:'gas-sponsor', timeoutMs:10_000 });
      if (!response.ok) throw Error('Sponsor RPC unavailable');
      const envelope = await response.json();
      if (envelope.error || envelope.result === undefined) throw Error('Sponsor RPC failed');
      return envelope.result;
    };
    gasSponsor = await createGasSponsorDispatch({ database, rpc, signerId, secretKey: (await readFile(keyFile, 'utf8')).trim(),
      enabled: true, budgetAtomic: gasBudget, maxDepositAtomic: '0', maxGas:'20000000000000', oneRegistrationPerAccount:true,
      allowlist: { [poolDeployment.accountId]: ['register'] } });
  }
  const guildRpc = async (method,params)=>{
      const response=await testnetRequest(method,params,{id:'guild-missions',timeoutMs:10_000});
      if(!response.ok)throw Error('Guild Testnet RPC unavailable.');
      const envelope=await response.json();
      if(envelope.error||envelope.result===undefined)throw Error('Guild Testnet RPC unavailable.');
      return envelope.result;
  };
  options.nearRoutes = createFoxPassportRoutes({ passport, usage, nearAuth, fixedRewards: options.nearFixedRewards,
    guildMissions:createGuildMissions({database,rpc:guildRpc}),
    guildCommunity:createGuildCommunity({database,rpc:guildRpc}),
    economyIndex,quartermaster:{enabled:false,budgetFoxo:config.quartermaster.budgetFoxo},
    quartermasterOrders: { list: () => readPublishedQuartermasterOrders(database) }, gasSponsor,
    gasEligibility: async account => (await bossPool?.eligibility(account))?.status === 'confirmed',
    rankingStatus: () => {
      const rows=database.prepare(`SELECT json_extract(payload,'$.mode') AS mode, COUNT(*) AS results
        FROM near_result_metrics GROUP BY mode`).all();
      return {enabledModes:config.ranking.enabledModes,
        modes:['hunt','boss','control','trials'].map(mode=>({mode,results:rows.find(row=>row.mode===mode)?.results??0}))};
    } });
  const careerModes = config.features.passport || config.features.materials ? ['boss','trials'] : [];
  options.nearResults = createResultOutbox(database, { passport, usage, confirmPractice: !config.features.passport,
    careerModes, rankingMetrics: (room, snapshot, finishedAt, _rubric, { opponents }) =>
      rankingMetricsFromSimulation(room, snapshot, finishedAt, undefined, { careerModes, opponents }) });
  const { bootstrapCareer } = await import('./near/career-bootstrap.mjs');
  career = await bootstrapCareer({ database, passport, usage, config });
  const { bootstrapMaterials } = await import('./near/material-bootstrap.mjs');
  const materials = await bootstrapMaterials({ database, config });
  const { bootstrapPool } = await import('./near/pool-bootstrap.mjs');
  const bossPool = practiceOnly ? null : await bootstrapPool({ database, config });
  const { createHuntReplayService } = await import('./near/replay-service.mjs');
  options.nearReplay = createHuntReplayService(database);
  options.cupDatabase = database;
  const existingRoutes=options.nearRoutes;
  options.nearRoutes=async request=>{
    if (request.method==='POST' && request.url==='/near/telemetry') {
      if (!nearAuth.origins.has(request.headers.origin)) return {status:403,data:{accepted:false}};
      const accepted=telemetry.record(request.body);
      return {status:accepted?200:400,data:{accepted}};
    }
    if(request.method==='POST' && request.url==='/near/replay/share'){
      const account=nearAuth.account(request.body?.nearSession,request.headers.origin);
      const matchId=request.body?.matchId;
      if(typeof matchId!=='string'||matchId.length>120)return {status:400,data:{error:'Invalid match.'}};
      const key=options.nearReplay.share(matchId,account);
      return key?{status:200,data:{key}}:{status:404,data:{error:'Replay unavailable.'}};
    }
    const replayPath=/^\/near\/replay\/([\w-]{24})$/.exec(request.url);
    if(request.method==='GET' && replayPath){
      const replay=options.nearReplay.read(replayPath[1]);
      return replay?{status:200,data:replay}:{status:404,data:{error:'Replay unavailable.'}};
    }
    if(request.method==='POST' && request.url==='/near/pool/eligibility'){
      const account=nearAuth.account(request.body?.nearSession,request.headers.origin);
      return {status:200,data:bossPool ? await bossPool.eligibility(account) : {status:'unavailable'}};
    }
    return existingRoutes(request);
  };
  if(economyIndex) {
    indexTimer=setInterval(()=>{
      if(indexWork||shuttingDown)return;
      indexWork=economyIndex.tick()
        .catch(error=>console.error('Economy index recovery failed',error.message))
        .finally(()=>{indexWork=null;});
    },5000);
    indexTimer.unref();
  }
  if (options.nearFixedRewards || career || materials || bossPool || gasSponsor) {
    rewardTimer = setInterval(() => {
      if (settlementWork||shuttingDown) return;
      settlementWork=(async()=>{
        for(const [name,service] of [['rewards',options.nearFixedRewards],['career',career],
          ['materials',materials],['bossPool',bossPool],['gasSponsor',gasSponsor]]){
          try{await service?.tick({onError:error=>console.error(name+' settlement failed',error.message)});}
          catch(error){console.error(name+' recovery failed',error.message);}
        }
      })().finally(()=>{settlementWork=null;});
    }, 5000);
    rewardTimer.unref();
  }
  options.hostedPractice = practiceOnly && process.env.NEAR_HOSTED_PRACTICE === '1';
  if (!options.hostedPractice) options.runner = new SimulationRunner({
    relayURL: 'http://127.0.0.1:' + port,
    gameURL: process.env.NEAR_GAME_URL || 'http://127.0.0.1:8817/dist/',
  });
}
const server = createHuntRelay(options);
server.listen(port, process.env.NEAR_QUARTERMASTER_KEY_FILE ? '127.0.0.1' : '0.0.0.0', () => {
  console.log('NEAR room relay listening on ' + port);
});
if (database) {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    shuttingDown = true;
    clearInterval(rewardTimer);
    clearInterval(telemetryTimer);
    clearInterval(indexTimer);
    for (const room of server.rooms.values()) server.closeRoom(room.code, 'Match server restarting');
    await options.runner?.closeAll();
    await settlementWork;
    await indexWork;
    economyIndex?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    database.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

