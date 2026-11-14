import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createResultOutbox } from '../../server/near/result-outbox.mjs';
import { createHuntRelay } from '../../server/hunt-relay.mjs';
import { createFoxUsage } from '../../server/near/usage.mjs';
import { createFoxPassport } from '../../server/near/passport.mjs';
import { rankingMetricsFromSimulation } from '../../server/near/ranking-rubric.mjs';

const room = {
  nearAuthoritative: true, roundId: 'round', config: { mode: 'boss' },
  roster: [{ nid: 0, nearWallet: 'alice.testnet', nftTokenId: '045', nftContract: 'fox.testnet' }],
};
const snapshot = { core: { phase: 'finished', roundId: 'round', result: {
  roundId: 'round', boss: { win: true },
  players: [{ id: 'hunt-0', left: false, activity: { bossShields: 1 }, experience: { total: 99_999 } }],
} } };

test('Hunt encounter counts are stable on replay and exclude bots, leavers and unobserved opponents', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const day = 86_400_000;
    let now = day + 100;
    const writer = createResultOutbox(db, { rankingMetrics: rankingMetricsFromSimulation, now: () => now });
    const roster = ['alice', 'bob', 'carol', 'dave', 'dummy'].map((name, nid) => ({
      nid, nearWallet: name + '.testnet', bot: nid === 4, team: nid < 3 ? 0 : 1,
    }));
    const results = roundId => {
      const players = roster.map(({ nid }) => ({ id: 'hunt-' + nid, left: nid === 3,
        rankingTelemetry: { version: 1, activeMs: 500, opponents: nid === 0 ? ['hunt-1', 'hunt-3', 'hunt-4'] : [] } }));
      writer.record({ ...room, roundId, roster, config: { mode: 'hunt', difficulty: 'normal' } },
        { core: { phase: 'finished', roundId, result: { roundId, winner: null, rankingDurationMs: 1000, players } } });
      const metric = account => JSON.parse(db.prepare('SELECT payload FROM near_result_metrics WHERE match_id=? AND account_id=?')
        .get(roundId, account + '.testnet').payload).signals;
      return [metric('alice'), metric('bob'), metric('carol')];
    };
    const first = results('first');
    assert.deepEqual(first.map(value => value.humanOpponentCount), [1, 1, 0]);
    assert.equal(first[0].maxOpponentMeetings, 1);
    now += 100;
    assert.equal(results('second')[0].maxOpponentMeetings, 2);
    now += day;
    assert.equal(results('third')[0].maxOpponentMeetings, 1);
    assert.deepEqual(results('first'), first);
  } finally { db.close(); }
});

test('metrics and result commit atomically; telemetry collisions cannot replace an accepted result',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const writer=createResultOutbox(db,{rankingMetrics:rankingMetricsFromSimulation,now:()=>1000});
    const full=structuredClone(snapshot);
    full.core.result.rankingDurationMs=1000;
    full.core.result.players[0].rankingTelemetry={version:1,activeMs:900,allyHealing:1,allyBlocked:2};
    full.core.result.players[0].raidStats={damage:10,breaks:1};
    full.core.result.boss.maxHp=100;
    writer.record(room,full);writer.record(room,full);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM near_result_metrics').get().count,1);
    const metric=JSON.parse(db.prepare('SELECT payload FROM near_result_metrics').get().payload);
    assert.equal(metric.signals.allyHealing,1);
    assert.equal(metric.enabled,false);
    full.core.result.players[0].rankingTelemetry.allyHealing=999;
    assert.throws(()=>writer.record(room,full),/Conflicting authoritative metrics/);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM near_result_metrics').get().payload).signals.allyHealing,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM near_results').get().count,1);
  } finally {db.close();}
});

test('authoritative practice unlocks local Boss progression once and quitting earns no rank', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const passport = createFoxPassport({ database: db });
    const outbox = createResultOutbox(db, { passport, confirmPractice: true });
    outbox.record(room, snapshot);
    outbox.record(room, snapshot);
    const abandoned = structuredClone(snapshot);
    abandoned.core.roundId = abandoned.core.result.roundId = 'abandoned';
    abandoned.core.result.players[0].left = true;
    outbox.record({ ...room, roundId: 'abandoned' }, abandoned);
    assert.equal(passport.rank('alice.testnet').bossWins, 1);
    assert.equal(passport.rank('alice.testnet').matches, 1);
    assert.equal(passport.tokenCareer({ collectionId: 'fox.testnet', tokenId: '045' }).bossWins, 1);
  } finally {
    db.close();
  }
});

test('an NFT result requires the accepted session and credits the original actor after transfer', async () => {
  const db = new DatabaseSync(':memory:');
  const nft = { collectionId: 'fox.testnet', tokenId: '045' };
  let ownerId = 'alice.testnet';
  let blockHeight = 1;
  const usage = createFoxUsage({ database: db, now: () => 1_000,
    readIdentity: async () => ({ ...nft, ownerId, blockHeight }) });
  const outbox = createResultOutbox(db, { usage, now: () => 2_000 });
  try {
    assert.throws(() => outbox.record(room, snapshot), /accepted Fox session/);
    await usage.start(ownerId, { nft, mode: 'boss', matchId: 'round' });
    ownerId = 'bob.testnet';
    blockHeight += 1;
    await usage.view(nft);
    assert.throws(() => outbox.record({ ...room, roster: [{ ...room.roster[0], nearWallet: ownerId }] }, snapshot), /accepted Fox session/);
    assert.equal(outbox.record(room, snapshot)[0].accountId, 'alice.testnet');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM near_results').get().count, 1);
  } finally {
    db.close();
  }
});

test('trusted match records exact XP once even after recreating the writer', () => {
  const db = new DatabaseSync(':memory:');
  const ingested = [];
  const passport = { ingest: result => ingested.push(result) };
  try {
    createResultOutbox(db, { passport, now: () => 1 }).record(room, snapshot);
    createResultOutbox(db, { passport, now: () => 2 }).record(room, snapshot);
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].xp, 1230);
    assert.equal(ingested[0].nft.tokenId, '045');
    assert.throws(() => createResultOutbox(db).record({ ...room, nearAuthoritative: false }, snapshot));
    const conflict = structuredClone(snapshot);
    conflict.core.result.boss.win = false;
    assert.throws(() => createResultOutbox(db).record(room, conflict), /Conflicting/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM near_results').get().count, 1);
  } finally {
    db.close();
  }
});

test('the NEAR room host cannot publish a result reserved for its simulation runner', async () => {
  const db = new DatabaseSync(':memory:');
  const nft = { collectionId: 'fox.xuancanh1.testnet', tokenId: '045' };
  const usage = createFoxUsage({ database: db, readIdentity: async () => ({
    ...nft, contract: nft.collectionId, ownerId: 'alice.testnet', blockHeight: 1,
  }) });
  const closed = [];
  const rewardCalls = [];
  let fixedStatus;
  const nearFixedRewards = {
    ready(actor, details) { rewardCalls.push(['ready', actor, details.mode]); fixedStatus = 'reserved'; return { id: 'fixed-http' }; },
    async tick() {},
    get() { return { status: fixedStatus, guaranteed: fixedStatus === 'reserved' }; },
    start(id) { rewardCalls.push(['start', id]); fixedStatus = 'started'; },
    async complete(id, result) { rewardCalls.push(['complete', id, result.resultHash]); fixedStatus = 'completed'; },
  };
  const runner = {
    status: () => ({ active: 0, maxConcurrent: 2, queued: 0, maxQueued: 4 }),
    launch: async (_room, _view, { onState }) => onState({ state: 'starting' }),
    close: code => closed.push(code),
  };
  const server = createHuntRelay({
    nearAuth: { account: () => 'alice.testnet' }, runner,
    nearResults: createResultOutbox(db, { usage }), nearUsage: usage, nearFixedRewards,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (action, data, token) => {
    const response = await fetch(base + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(data),
    });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    const host = await call('create', { identity: 'guest', nearSession: 'fixture', tokenId: nft.tokenId });
    const code = host.room.code;
    await call('settings', { code, mode: 'boss' }, host.token);
    const started = await call('start', { code }, host.token);
    assert.equal(started.status, 200);
    assert.equal((await usage.view(nft)).lease, null);
    assert.equal(started.room.config.difficulty, 'normal');
    assert.ok(started.room.roster.every(player => !('nearWallet' in player)));
    const room = server.rooms.get(code);
    const worker = room.simulator.token;
    await call('ready', { code }, host.token);
    await call('ready', { code }, worker);
    assert.equal((await usage.view(nft)).lease.matchId, room.roundId);
    const result = structuredClone(snapshot);
    result.core.roundId = room.roundId;
    result.core.result.roundId = room.roundId;
    assert.match((await call('sync', { code, snapshot: result }, host.token)).error, /authority/);
    assert.equal((await call('sync', { code, snapshot: result }, worker)).status, 200);
    assert.equal((await call('sync', { code, snapshot: result }, worker)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM near_results').get().count, 1);
    assert.deepEqual(rewardCalls.slice(0, 2), [['ready', 'alice.testnet', 'boss'], ['start', 'fixed-http']]);
    assert.equal(rewardCalls.filter(row => row[0] === 'complete').length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
