import assert from 'node:assert/strict';
import test from 'node:test';
import { communityEvents } from '../../src/game/foxo-community-calendar.js';
import { describeGuildCampaign } from '../../server/near/guild-missions.mjs';
import { createGuildCommunity } from '../../server/near/community-events.mjs';
import { guildDeployment } from '../../assets/near-fox/guild-deployment.js';
import { DatabaseSync } from 'node:sqlite';

test('a scheduled lobby closes exactly at the UTC deadline and rolls forward one week', () => {
  const start = Date.UTC(2026, 10, 18, 12);
  const end = Date.UTC(2026, 10, 18, 14);
  const hunt = when => communityEvents(when).find(event => event.mode === 'hunt');
  assert.equal(hunt(start - 1).open, false);
  assert.equal(hunt(start).open, true);
  assert.equal(hunt(end - 1).endsAt, end);
  assert.equal(hunt(end).open, false);
  assert.equal(hunt(end).startsAt, Date.UTC(2026, 10, 25, 12));
});

test('mission budget status preserves atomic precision and closes at the deadline', () => {
  const prize = '10000000000000000000000001';
  const campaign = { remaining: prize, maxAward: prize, closesAtMs: 100, closed: false };
  assert.equal(describeGuildCampaign(null, 99).state, 'unfunded');
  assert.deepEqual(describeGuildCampaign(campaign, 99), {
    state: 'funded', remainingAtomic: prize, perMissionAtomic: prize, expiresAt: 100,
  });
  assert.equal(describeGuildCampaign(campaign, 100).state, 'closed');
  assert.equal(describeGuildCampaign({ ...campaign, remaining: '10000000000000000000000000' }, 99).state, 'exhausted');
});

test('RSVPs are private and idempotent, and lounge edits check current guild leadership', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    let now = Date.UTC(2026, 10, 18, 12);
    let leader = 'leader.testnet';
    const rpc = async (_, args) => args.request_type === 'view_account'
      ? { block_hash:'block', code_hash:guildDeployment.codeHash }
      : { block_hash:'block', result:[...Buffer.from(JSON.stringify({ active:true, leader, governors:[] }))] };
    const service = createGuildCommunity({ database, rpc, now:()=>now });
    const eventId = communityEvents(now).find(event=>event.mode==='hunt').id;
    const input = { eventId, attending:true };
    assert.equal((await service('rsvp',null,input)).status,401);
    await service('rsvp',leader,input);
    await service('rsvp',leader,input);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM near_community_rsvps').get().n,1);
    assert.equal((await service('events',leader,{})).data.events.find(event=>event.id===eventId).attending,true);
    assert.equal((await service('events','guest.testnet',{})).data.events.some(event=>event.attending),false);
    now += 2 * 3_600_000;
    assert.equal((await service('rsvp',leader,input)).status,400);
    const layout = { guildId:'beacon-guard', layout:'compact' };
    assert.equal((await service('save-layout',leader,layout)).status,200);
    leader = 'new-leader.testnet';
    assert.equal((await service('save-layout','leader.testnet',{...layout,layout:'banner'})).status,403);
    assert.equal((await service('layout',null,layout)).data.layout,'compact');
  } finally {
    database.close();
  }
});
