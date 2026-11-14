import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'near-workspaces';

test('career append preserves provenance, retries, out-of-order results and explicit corrections', async () => {
  const worker = await Worker.init({ network: 'sandbox' });
  try {
    const root = worker.rootAccount;
    const passport = await root.createSubAccount('passport');
    const alice = await root.createSubAccount('alice');
    await passport.deploy('/wasm/near_passport.wasm');
    await root.call(passport, 'new', { owner_id: root.accountId, collection_id: 'fox.testnet',
      network: 'near-testnet', career_signer_id: root.accountId });
    await root.call(passport, 'set_append_enabled', { enabled: true });
    const record = { version: 1, network: 'near-testnet', contractId: passport.accountId,
      collectionId: 'fox.testnet', tokenId: '045', eventId: 'first', source: 'authoritative', sourceId: 'first',
      actorId: alice.accountId, matchId: 'match-1', rulesVersion: 'pilot-1', resultHash: 'a'.repeat(64),
      finishedAtMs: 200, mode: 'boss', won: true, xp: 100,
      provenanceHash: null, correctsEventId: null, correctionReason: null };
    const options = { attachedDeposit: '100000000000000000000000', gas: '100000000000000' };
    const append = value => root.call(passport, 'append_career', { record: value }, options);
    await assert.rejects(alice.call(passport, 'append_career', { record }, options));
    await assert.rejects(root.call(passport, 'append_career', { record }));
    assert.equal(await passport.view('get_record', { event_id: 'first' }), null);
    assert.equal(await append(record), true);
    assert.equal(await append(record), false);
    await assert.rejects(append({ ...record, xp: 101 }));
    await assert.rejects(append({ ...record, eventId: 'renamed' }));
    await assert.rejects(append({ ...record, eventId: 'duplicate-match', sourceId: 'other' }));
    const late = { ...record, eventId: 'late', sourceId: 'late', matchId: 'match-earlier', finishedAtMs: 100,
      mode: 'hunt', won: false, xp: 10 };
    assert.equal(await append(late), true);
    const legacy = { ...record, eventId: 'migration', sourceId: 'snapshot-1:entry-1', source: 'legacy_migration',
      matchId: 'legacy-1', provenanceHash: 'b'.repeat(64), xp: 50 };
    assert.equal(await append(legacy), true);
    assert.equal(await append(legacy), false);
    const correction = { ...record, eventId: 'correction', sourceId: 'review-1', source: 'correction',
      provenanceHash: 'c'.repeat(64), correctsEventId: 'first', correctionReason: 'Verified corrected score', xp: 20, won: false };
    assert.equal(await append(correction), true);
    await assert.rejects(append({ ...correction, eventId: 'double-correction', sourceId: 'review-2' }));
    assert.equal((await passport.view('get_record', { event_id: 'first' })).xp, 100);
    assert.equal(await passport.view('get_correction', { event_id: 'first' }), 'correction');
    const query = { collection_id: 'fox.testnet', token_id: '045' };
    assert.deepEqual(await passport.view('get_career', query), { revision: 4, matches: 3, wins: 1, bossWins: 1, xp: 80 });
    const history = await passport.view('get_history', { ...query, offset: 0, limit: 50 });
    assert.deepEqual(history.map(value => value.eventId), ['first', 'late', 'migration', 'correction']);
    assert.equal(history[2].source, 'legacy_migration');
    await root.call(passport, 'set_append_enabled', { enabled: false });
    assert.equal(await append(record), false);
    await assert.rejects(append({ ...late, eventId: 'new', sourceId: 'new', matchId: 'new' }));
    assert.equal((await passport.view('get_history', { ...query, offset: 2, limit: 1 }))[0].eventId, 'migration');
  } finally {
    await worker.tearDown();
  }
});
