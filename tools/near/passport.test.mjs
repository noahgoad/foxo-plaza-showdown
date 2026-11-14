import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const nft = {collectionId:'fox.xuancanh1.testnet', tokenId:'045'};
const alice = 'alice.testnet';
const bob = 'bob.testnet';
const result = {
  matchId:'match-1', accountId:alice, nft, mode:'boss', won:true, xp:120,
  resultHash:'ab'.repeat(32), rulesVersion:'season-1', finishedAt:1_000,
};

test('Passport history travels with the exact token, while rank stays with the player', async () => {
  const {createFoxPassport} = await import('../../server/near/passport.mjs');
  const database = new DatabaseSync(':memory:');
  let owner = alice;
  const passport = createFoxPassport({database, readIdentity: async () => ({ownerId:owner})});
  passport.ingest(result);
  assert.equal((await passport.view(nft)).career.finalized.xp, 0);
  assert.equal((await passport.view(nft)).career.pending.xp, 120);
  passport.finalize(result.matchId, alice, result.resultHash);
  owner = bob;
  const view = await passport.view(nft);
  assert.equal(view.identity.ownerId, bob);
  assert.equal(view.identity.tokenId, '045');
  assert.equal(view.career.finalized.xp, 120);
  assert.equal(view.career.history[0].accountId, alice);
  assert.equal(passport.rank(alice).xp, 120);
  assert.equal(passport.rank(bob).xp, 0);
  assert.equal((await passport.view({...nft,tokenId:'45'})).career.finalized.xp, 0);
});

test('retries cannot duplicate or mutate a result and distinct results aggregate', async () => {
  const {createFoxPassport} = await import('../../server/near/passport.mjs');
  const database = new DatabaseSync(':memory:');
  const passport = createFoxPassport({database, readIdentity:async () => ({ownerId:alice})});
  const writer = createFoxPassport({database, readIdentity:async () => ({ownerId:alice})});
  await Promise.all([passport, writer, passport].map((store, index) => Promise.resolve().then(() => {
    const item = {...result, matchId:'match-' + index};
    assert.equal(store.ingest(item), true);
    assert.equal(store.ingest(item), false);
    assert.throws(() => store.ingest({...item, xp:999}), /conflict/i);
    assert.throws(() => store.finalize(item.matchId, alice, 'bb'.repeat(32)), /match/i);
    store.finalize(item.matchId, alice, item.resultHash);
  })));
  const view = await passport.view(nft, {limit:2});
  assert.deepEqual(view.career.finalized, {matches:3,xp:360,wins:3,bossWins:3});
  assert.equal(view.career.history.length, 2);
  assert.equal(view.career.nextOffset, 2);
});
