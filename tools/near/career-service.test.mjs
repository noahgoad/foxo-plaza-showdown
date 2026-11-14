import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createCareerService } from '../../server/near/career-service.mjs';
import { bootstrapCareer } from '../../server/near/career-bootstrap.mjs';

test('career relay recovers a saved result and finalizes only after the chain record is confirmed', async t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE near_results(match_id,account_id,result_hash,payload)');
  const record = { matchId: 'match-1', accountId: 'borrower.testnet',
    nft: { collectionId: 'fox.testnet', tokenId: '045' }, mode: 'boss', won: true, left: false, xp: 100,
    rulesVersion: 'near-authoritative-boss-1' };
  const resultHash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  const result = { ...record, resultHash, finishedAt: 1000 };
  database.prepare('INSERT INTO near_results VALUES(?,?,?,?)').run(record.matchId,record.accountId,resultHash,JSON.stringify(result));
  let submitted = 0, confirmed = false, credited = 0;
  const chain = {
    async submit() { submitted++; return { transactionId: 'tx-1' }; },
    async reconcile({ record }) { return confirmed ? { status: 'FINALIZED', record, transactionId: 'tx-1',
      receiptId: 'receipt-1', blockHash: 'block-1', blockHeight: 2 } : { status: 'UNKNOWN' }; },
  };
  const settings = { database, chain, contractId: 'passport.testnet', collectionId: 'fox.testnet',
    usage: { sessionReceipt(nft, match, receipt) {
      assert.equal(nft.tokenId,'045'); assert.equal(match,'match-1');
      assert.deepEqual(receipt,{actorId:'borrower.testnet',mode:'boss',finishedAt:1000});
    } },
    passport: { finalize(match, actor, hash) {
      assert.equal(actor,'borrower.testnet'); assert.equal(hash,resultHash); credited++;
    } },
  };
  const errors = [];
  await createCareerService(settings).tick({ onError: error => errors.push(error.message) });
  assert.equal(submitted,1); assert.equal(credited,0);
  confirmed = true;
  await createCareerService(settings).tick({ onError: error => errors.push(error.message) });
  assert.equal(credited,1); assert.equal(submitted,1);
  assert.deepEqual(errors,[]);
  database.exec("UPDATE near_results SET result_hash='tampered'");
  await createCareerService(settings).tick({ onError: error => errors.push(error.message) });
  assert.match(errors[0],/digest mismatch/);
});

test('career bootstrap stays disabled until feature and signer configuration are explicit', async () => {
  assert.equal(await bootstrapCareer({ config: { features: { passport: false } } }),null);
  await assert.rejects(bootstrapCareer({ config: { features: { passport: true } }, environment: {} }), /incomplete/);
});
