import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createRankingPilot, createRankingPilots } from '../../server/near/ranking-pilot.mjs';
import { createRankingDrafts } from '../../server/near/ranking.mjs';
import { rankingMetricsHash } from '../../server/near/ranking-rubric.mjs';
import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';

test('ranking boards select per-mode campaigns and preserve the default Boss route', async t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE near_results(match_id, account_id, result_hash, payload); CREATE TABLE near_result_metrics(match_id, account_id, metrics_hash, payload)');
  const config = JSON.parse(readFileSync(new URL('../../config/economy.testnet.json', import.meta.url)));
  const campaigns = new Map();
  const rpc = async (method, query) => {
    if (method === 'block') return { header: { hash: 'block', timestamp_nanosec: '1794700900000000000' } };
    if (query.request_type === 'view_account') return { block_hash: 'block', code_hash: economyDeployment.professionCodeHash };
    const { campaign_id } = JSON.parse(Buffer.from(query.args_base64, 'base64'));
    const value = query.method_name === 'get_campaign' ? campaigns.get(campaign_id) ?? null : null;
    return { block_hash: 'block', result: [...Buffer.from(JSON.stringify(value))] };
  };
  const ranking = createRankingPilots({ database, config, rpc, now: () => 1794700900000 });
  assert.equal((await ranking.board(0)).mode, 'boss');
  const trial = await ranking.board(0, 'trials');
  assert.equal(trial.campaignId, 'fox-pilot-1-trials-ranking');
  assert.equal(trial.campaignActive, false);
  campaigns.set(trial.campaignId, { closesAtMs: 1794700800000 + 28 * 86_400_000,
    maxAward: '6250000000000000000000000', closed: false });
  assert.equal((await ranking.board(0, 'trials')).campaignActive, true);
  assert.equal((await ranking.board(0, 'hunt')).campaignActive, false);
});

test('ranking pilot shows zero invented rows, stages only after finalized rollover, and exposes awards only after publication', async t => {
  const config = JSON.parse(readFileSync(new URL('../../config/economy.testnet.json', import.meta.url)));
  const pilot = JSON.parse(readFileSync(new URL('../../config/ranking-pilot.testnet.json', import.meta.url)));
  const rubric = JSON.parse(readFileSync(new URL('../../config/ranking-rubrics.testnet.json', import.meta.url)));
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE near_results(match_id, account_id, result_hash, payload); CREATE TABLE near_result_metrics(match_id, account_id, metrics_hash, payload)');
  const day = 86_400_000;
  let localTime = pilot.seasonStartMs + day + 300_000;
  let chainTime = pilot.seasonStartMs + day;
  let published = null;
  let campaign = { remaining: '1000000000000000000000000000', closed: false,
    closesAtMs: pilot.seasonStartMs + 28 * day, maxAward: '6250000000000000000000000' };
  const rpc = async (method, query) => {
    if (method === 'block') return { header: { hash: 'block', timestamp_nanosec: String(BigInt(chainTime)*1_000_000n) } };
    assert.equal(query.block_id, 'block');
    if (query.request_type === 'view_account') return { block_hash:'block', code_hash:economyDeployment.professionCodeHash };
    const args = JSON.parse(Buffer.from(query.args_base64,'base64'));
    assert.equal(args.campaign_id,pilot.campaignId);
    const value = query.method_name === 'get_campaign' ? campaign : published;
    return { block_hash:'block', result:[...Buffer.from(JSON.stringify(value))] };
  };
  const drafts = createRankingDrafts({database, config, now:()=>chainTime});
  const service = createRankingPilot({database, config, rpc, drafts, now:()=>localTime, pilot, rubric});
  const args = {campaignId:pilot.campaignId, mode:'boss', budgetDay:'2026-11-14'};
  const stage = () => service.stageClosedDay({onError:error=>{throw error;}});
  const add = (matchId, accountId, signals) => {
    const result = {matchId, accountId, mode:'boss', left:false};
    const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    const finishedAt = pilot.seasonStartMs + 1000;
    database.prepare('INSERT INTO near_results VALUES (?,?,?,?)').run(matchId,accountId,resultHash,JSON.stringify({...result, resultHash, finishedAt}));
    const metric = {...result, resultHash, finishedAt, signals, source:'authoritative-simulation', rulesVersion:rubric.version};
    metric.metricsHash = rankingMetricsHash(metric);
    database.prepare('INSERT INTO near_result_metrics VALUES (?,?,?,?)').run(matchId,accountId,metric.metricsHash,JSON.stringify(metric));
  };
  assert.deepEqual((await service.board(0)).entries,[]);
  add('low','other.testnet',{durationMs:250407,activeMs:5000,left:false,difficulty:null});
  add('valid','player.testnet',{durationMs:60000,activeMs:60000,left:false,difficulty:'normal',
    bossDamage:100,bossMaxHp:600,allyHealing:300,allyBlocked:300,shieldBreaks:3});
  const [{ breakdown, ...standing }] = (await service.board(0)).entries;
  assert.deepEqual(standing,{accountId:'player.testnet',scoreAtomic:'333333',rank:1});
  assert.equal(breakdown.bestOf,3);
  assert.deepEqual(breakdown.matches.map(({matchId,scoreAtomic})=>[matchId,scoreAtomic]),[['valid','1000000']]);
  await stage();
  assert.equal(drafts.forSubmission(args),null);
  localTime += 300_000;
  chainTime += 300_000;
  await stage();
  const saved = drafts.forSubmission(args);
  assert.ok(saved);
  assert.equal(saved.draft.allocations.length,1);
  published = {draft:saved.draft,publishedAtMs:null,reviewAfterMs:chainTime+day};
  assert.equal((await service.board(0)).entries[0].amountAtomic,undefined);
  published.publishedAtMs = chainTime+day;
  assert.equal((await service.board(0)).entries[0].amountAtomic,saved.draft.allocations[0].amountAtomic);
  assert.equal((await service.board(0)).entries[0].breakdown.matches[0].matchId,'valid');
  published.draft = {...published.draft,evidenceHash:'0'.repeat(64)};
  assert.equal((await service.board(0)).entries[0].breakdown,undefined);
  campaign = {...campaign, maxAward:'1'};
  await assert.rejects(service.board(0),/terms differ/);
  assert.equal(await service.board(28),null);
});
