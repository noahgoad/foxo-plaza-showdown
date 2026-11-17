import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createHuntReplayService, sampleHuntReplay } from '../../server/near/replay-service.mjs';

test('authoritative Hunt replay requires participant consent, persists and expires without publishing identities', () => {
  const db = new DatabaseSync(':memory:');
  let time = 100;
  const service = createHuntReplayService(db, () => time);
  try {
    const room = { roundId:'match-1', nearAuthoritative:true, config:{mode:'hunt'}, roster:[{nearWallet:'alice.testnet'}] };
    const frame = elapsed => ({core:{elapsed,holderId:'hunt-0'},actors:[{id:'hunt-0',pos:[1,0,2],alive:true}]});
    for (const elapsed of [0,0.05,0.2]) sampleHuntReplay(room, frame(elapsed));
    assert.equal(room.huntReplayFrames.length, 2);
    service.record(room, room.huntReplayFrames);
    assert.equal(service.share('match-1','bob.testnet'),null);
    const key = service.share('match-1','alice.testnet');
    const reopened = createHuntReplayService(db, () => time);
    assert.equal(reopened.share('match-1','alice.testnet'),key);
    assert.equal(reopened.read(key).frames.length,2);
    assert.doesNotMatch(JSON.stringify(reopened.read(key)),/alice/);
    time += 31 * 24 * 60 * 60 * 1000;
    assert.equal(reopened.read(key),null);
  } finally {
    db.close();
  }
});
