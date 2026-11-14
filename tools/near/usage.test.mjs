import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const nft = {collectionId:'fox.xuancanh1.testnet', tokenId:'045'};
const alice = 'alice.testnet';
const bob = 'bob.testnet';
const carol = 'carol.testnet';

async function fixture() {
  const {createFoxUsage} = await import('../../server/near/usage.mjs');
  const database = new DatabaseSync(':memory:');
  let time = 10_000;
  let ownerId = alice;
  let blockHeight = 10;
  const make = () => createFoxUsage({database, now:() => time, readIdentity:async () => ({ownerId, blockHeight})});
  return {usage:make(), other:make(), restart:make, database, transfer(owner) { ownerId=owner; blockHeight++; }, advance(ms) { time+=ms; }};
}

test('chain ownership epoch revokes a grant even when ownership returns between reads',async()=>{
  const {createFoxUsage}=await import('../../server/near/usage.mjs');
  const database=new DatabaseSync(':memory:');
  let epoch='0',blockHeight=10;
  try {
    const usage=createFoxUsage({database,now:()=>10000,requireOwnershipEpoch:true,
      readIdentity:async()=>({ownerId:alice,blockHeight,ownershipEpoch:epoch})});
    await usage.grant(alice,{nft,borrowerId:bob,modes:['boss'],expiresAt:20000});
    epoch='2';blockHeight++;
    await assert.rejects(usage.start(bob,{nft,mode:'boss',matchId:'after-roundtrip'}),/No active Fox loan/);
    await usage.grant(alice,{nft,borrowerId:bob,modes:['boss'],expiresAt:20000});
    assert.equal((await usage.start(bob,{nft,mode:'boss',matchId:'fresh-grant'})).actorId,bob);
  } finally {database.close();}
});

test('two granted borrowers cannot lock the same Fox for concurrent matches', async () => {
  const {usage, other} = await fixture();
  for (const borrowerId of [bob, carol]) {
    await usage.grant(alice, {nft, borrowerId, modes:['boss'], expiresAt:20_000});
  }
  const outcomes = await Promise.allSettled([
    usage.start(bob, {nft, mode:'boss', matchId:'match-1'}),
    other.start(carol, {nft, mode:'boss', matchId:'match-2'}),
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(item => item.status === 'rejected').reason.message, /active/i);
  assert.equal((await usage.view(nft)).lease.rewardAccountId, outcomes.find(item => item.status === 'fulfilled').value.actorId);
});

test('expiry and revocation stop new matches and a transfer preserves the running beneficiary', async () => {
  const {usage, transfer, advance} = await fixture();
  await usage.grant(alice, {nft, borrowerId:bob, modes:['boss'], expiresAt:20_000});
  await assert.rejects(usage.start(bob, {nft, mode:'control', matchId:'wrong-mode'}), /grant/i);
  const lease = await usage.start(bob, {nft, mode:'boss', matchId:'match-1'});
  await usage.revoke(alice, {nft, borrowerId:bob});
  transfer(carol);
  await assert.rejects(usage.start(bob, {nft, mode:'boss', matchId:'match-2'}), /grant/i);
  assert.deepEqual((await usage.view(nft)).lease, lease);
  await assert.rejects(usage.grant(bob, {nft, borrowerId:carol, modes:['boss'], expiresAt:20_000}), /owner/i);
  assert.equal(usage.finish(nft, 'match-1'), true);
  await usage.grant(carol, {nft, borrowerId:bob, modes:['boss'], expiresAt:20_000});
  advance(11_000);
  await assert.rejects(usage.start(bob, {nft, mode:'boss', matchId:'match-3'}), /grant/i);
});

test('an observed transfer invalidates grants even when the Fox later returns to its prior owner', async () => {
  const {usage, transfer} = await fixture();
  await usage.grant(alice, {nft, borrowerId:bob, modes:['boss'], expiresAt:20_000});
  transfer(carol);
  await usage.view(nft);
  transfer(alice);
  assert.deepEqual(await usage.list(bob), []);
  await assert.rejects(usage.start(bob, {nft, mode:'boss', matchId:'match-1'}), /grant/i);
});

test('each mode releases its lease at the maximum duration plus exactly 120 seconds', async () => {
  for (const [mode, duration] of Object.entries({hunt:300_000, boss:240_000, control:240_000, trials:180_000})) {
    const {usage, advance, restart} = await fixture();
    const lease = await usage.start(alice, {nft, mode, matchId:'old'});
    assert.equal(lease.startedAt, 10_000);
    assert.equal(lease.expiresAt, 10_000 + duration + 120_000);
    advance(duration + 119_999);
    await assert.rejects(restart().start(alice, {nft, mode, matchId:'new'}), /active/i);
    advance(1);
    assert.equal((await restart().view(nft)).lease, null);
    await restart().start(alice, {nft, mode, matchId:'new'});
  }
});

test('a revoked transferred session retains a detached loadout and original actor receipt after expiry', async () => {
  const {usage, transfer, advance, restart} = await fixture();
  await usage.grant(alice, {nft, borrowerId:bob, modes:['boss'], expiresAt:20_000});
  const loadout = {weapon:'shooter', skill:{id:'ward'}, equipment:['finish-1']};
  const lease = await usage.start(bob, {nft, mode:'boss', matchId:'accepted', loadout, rulesVersion:'fox-2.1'});
  assert.equal(lease.grantEpoch, 1);
  loadout.skill.id = 'changed';
  await usage.revoke(alice, {nft, borrowerId:bob});
  transfer(carol);
  const retry = await restart().start(bob, {nft, mode:'boss', matchId:'accepted', loadout:{weapon:'forged'}});
  assert.deepEqual(retry.loadout, {weapon:'shooter', skill:{id:'ward'}, equipment:['finish-1']});
  await assert.rejects(usage.start(carol, {nft, mode:'boss', matchId:'second'}), /active/i);
  advance(360_000);
  await restart().start(carol, {nft, mode:'boss', matchId:'second'});
  const receipt = restart().sessionReceipt(nft, 'accepted', {actorId:bob, mode:'boss', finishedAt:100_000});
  assert.equal(receipt.rewardAccountId, bob);
  assert.equal(receipt.ownerId, alice);
  assert.equal(receipt.rulesVersion, 'fox-2.1');
  receipt.loadout.skill.id = 'mutated-view';
  assert.equal(restart().sessionReceipt(nft, 'accepted', {actorId:bob, mode:'boss', finishedAt:100_000}).loadout.skill.id, 'ward');
  assert.throws(() => usage.sessionReceipt(nft, 'accepted', {actorId:carol, mode:'boss', finishedAt:100_000}), /session/i);
  assert.throws(() => usage.sessionReceipt(nft, 'accepted', {actorId:bob, mode:'control', finishedAt:100_000}), /session/i);
  assert.throws(() => usage.sessionReceipt(nft, 'accepted', {actorId:bob, mode:'boss', finishedAt:370_001}), /session/i);
  await assert.rejects(usage.start(bob, {nft, mode:'boss', matchId:'accepted'}), /session/i);
});

test('regrant increments its epoch without changing an accepted session and finish preserves its receipt', async () => {
  const {usage} = await fixture();
  await usage.grant(alice, {nft, borrowerId:bob, modes:['boss'], expiresAt:20_000});
  await usage.start(bob, {nft, mode:'boss', matchId:'first'});
  await usage.revoke(alice, {nft, borrowerId:bob});
  await usage.grant(alice, {nft, borrowerId:bob, modes:['boss'], expiresAt:30_000});
  assert.equal(usage.finishMatch('first'), 1);
  assert.equal(usage.sessionReceipt(nft, 'first', {actorId:bob, mode:'boss', finishedAt:10_000}).grantEpoch, 1);
  assert.equal((await usage.start(bob, {nft, mode:'boss', matchId:'second'})).grantEpoch, 2);
  await assert.rejects(usage.start(bob, {nft, mode:'boss', matchId:'first'}), /session/i);
});
