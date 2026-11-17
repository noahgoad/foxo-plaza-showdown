import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createGuildMissions, qualifiesGuildMission } from '../../server/near/guild-missions.mjs';
import { rankingMetricsHash } from '../../server/near/ranking-rubric.mjs';
import { guildTermsHash } from '../../src/economy/near-guild.js';
import { guildDeployment } from '../../assets/near-fox/guild-deployment.js';

test('Guild missions verify membership, match evidence and single use across projects',async()=>{
  const database=new DatabaseSync(':memory:');
  try{
    database.exec('CREATE TABLE near_results(match_id,account_id,payload,result_hash); CREATE TABLE near_result_metrics(match_id,account_id,payload,metrics_hash)');
    const account='player.testnet';
    let clock=100_000;
    const project={guild_id:'beacon',deadline:'900000000000',status:'open',fee_payer:'leader.testnet',sku:'guild-banner-beacon-v2'};
    const rpc=async(_,args)=>{
      if(args.request_type==='view_account')return {block_hash:'final',code_hash:guildDeployment.codeHash};
      const body=JSON.parse(Buffer.from(args.args_base64,'base64'));
      const value=args.method_name==='member'?body.account_id===account:args.method_name==='guild'?{active:true}:
        {...project,terms_hash:await guildTermsHash({contract:guildDeployment.accountId,projectId:body.project_id,project})};
      return {block_hash:'final',result:[...Buffer.from(JSON.stringify(value))]};
    };
    const mission=createGuildMissions({database,rpc,now:()=>clock});
    assert.equal((await mission('other.testnet',{projectId:'first',mode:'boss'},'accept')).status,403);
    for(const projectId of ['first','second'])assert.equal((await mission(account,{projectId,mode:'boss'},'accept')).data.missions[0].status,'accepted');
    const insert=(matchId,finishedAt,hashOverride)=>{
      const result={matchId,accountId:account,mode:'boss',rulesVersion:'near-authoritative-boss-1',won:true,left:false};
      const resultHash=createHash('sha256').update(JSON.stringify(result)).digest('hex');
      const metric={matchId,accountId:account,mode:'boss',source:'authoritative-simulation',rulesVersion:'fixture',resultHash,finishedAt,
        signals:{left:false,durationMs:60000,activeMs:24000,shieldBreaks:1}};
      metric.metricsHash=rankingMetricsHash(metric);
      database.prepare('INSERT INTO near_results VALUES (?,?,?,?)').run(matchId,account,JSON.stringify({...result,resultHash,finishedAt}),hashOverride||resultHash);
      database.prepare('INSERT INTO near_result_metrics VALUES (?,?,?,?)').run(matchId,account,JSON.stringify(metric),metric.metricsHash);
    };
    insert('started_before_accept',130000);
    insert('bad_hash',175000,'bad');
    insert('verified',180000);
    clock=185000;
    const confirmed=(await mission(account,{projectId:'first'},'status')).data.missions[0];
    assert.equal(confirmed.status,'confirmed');
    assert.equal(confirmed.matchId,'verified');
    assert.deepEqual((await mission(account,{projectId:'first'},'status')).data.missions[0],confirmed);
    assert.equal((await mission(account,{projectId:'second'},'status')).data.missions[0].status,'accepted');
  }finally{database.close();}
});

test('Trait Hunt requires authoritative win telemetry with a carrier or trait objective', () => {
  const account = 'player.testnet';
  const result = { matchId:'hunt-match', accountId:account, mode:'hunt', rulesVersion:'near-practice-1', won:true, left:false };
  const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  const finishedAt = 180_000;
  const makeRow = (source, captures) => {
    const metric = { matchId:result.matchId, accountId:account, mode:'hunt', source, resultHash, finishedAt,
      signals:{ left:false, durationMs:60_000, activeMs:20_000, captures, traits:0, kills:20 } };
    metric.metricsHash = rankingMetricsHash(metric);
    return { match_id:result.matchId, result_hash:resultHash, metrics_hash:metric.metricsHash,
      payload:JSON.stringify({...result,resultHash,finishedAt}), metric:JSON.stringify(metric) };
  };
  const terms = { account, mode:'hunt', acceptedAt:100_000, deadline:200_000 };
  assert.equal(qualifiesGuildMission(makeRow('authoritative-simulation',1), terms)?.matchId, result.matchId);
  assert.equal(qualifiesGuildMission(makeRow('authoritative-simulation',0), terms), null);
  assert.equal(qualifiesGuildMission(makeRow('local',1), terms), null);
});
