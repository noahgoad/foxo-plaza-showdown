import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCareerOutbox } from '../../server/near/career-outbox.mjs';
import { buildCareerRecord } from '../../server/near/career-record.mjs';
import { buildCareerAppendTransaction, buildPassportInitTransaction } from '../../server/near/career-deployment.mjs';

const domain = { network: 'near-testnet', contractId: 'passport.testnet', collectionId: 'fox.testnet' };
const result = { accountId: 'alice.testnet', matchId: 'match-1', nft: { collectionId: 'fox.testnet', tokenId: '045' },
  mode: 'boss', won: true, xp: 100, finishedAt: 100, resultHash: 'a'.repeat(64), rulesVersion: 'pilot-1' };
const provenance = { source: 'authoritative', sourceId: 'result-1' };
const receipt = record => ({ status: 'FINALIZED', transactionId: 'tx-1', receiptId: 'receipt-1',
  blockHash: 'block-1', blockHeight: 5, record });

test('practice and unverified results cannot enter the chain outbox', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const outbox = createCareerOutbox({ database: db, ...domain });
  assert.equal(outbox.enqueue({ ...result, rulesVersion: 'near-practice-1' }).status, 'PRACTICE');
  assert.throws(() => outbox.enqueue(result), /provenance/);
  assert.equal(outbox.list().length, 0);
});

test('career records bind provenance and exact original actor, with idempotency collision checks', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const outbox = createCareerOutbox({ database: db, ...domain, verifyResult: () => provenance });
  const first = outbox.enqueue(result);
  assert.equal(first.status, 'PREPARED');
  assert.equal(first.record.actorId, result.accountId);
  assert.deepEqual(outbox.enqueue(result), first);
  assert.throws(() => outbox.enqueue({ ...result, xp: 101 }), /conflict/i);
  const legacy = buildCareerRecord(result, domain, { source: 'legacy_migration', sourceId: 'migration-1:entry-1',
    provenanceHash: 'b'.repeat(64) });
  assert.equal(legacy.source, 'legacy_migration');
  assert.equal(legacy.provenanceHash, 'b'.repeat(64));
});

test('restart after unknown submission reconciles receipts before sending again', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let sends = 0; let confirmed = false;
  const chain = { submit: async () => { sends++; return { status: 'SUBMITTED', transactionId: 'tx-1' }; },
    reconcile: async ({ record }) => confirmed ? receipt(record) : { status: 'UNKNOWN' } };
  const options = { database: db, ...domain, verifyResult: () => provenance, chain };
  const first = createCareerOutbox(options);
  const { operationId } = first.enqueue(result);
  assert.equal((await first.process(operationId)).status, 'SUBMITTED');
  const restarted = createCareerOutbox(options);
  assert.equal((await restarted.process(operationId)).status, 'SUBMITTED');
  assert.equal(sends, 1);
  confirmed = true;
  assert.equal((await restarted.process(operationId)).status, 'FINALIZED');
  assert.equal((await restarted.process(operationId)).status, 'FINALIZED');
  assert.equal(sends, 1);
});

test('mismatched receipt or chain record cannot finalize an outbox entry', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const outbox = createCareerOutbox({ database: db, ...domain, verifyResult: () => provenance,
    chain: { submit: async () => ({ status: 'SUBMITTED', transactionId: 'tx-1' }),
      reconcile: async ({ record }) => receipt({ ...record, xp: 999 }) } });
  const { operationId } = outbox.enqueue(result);
  await outbox.process(operationId);
  await assert.rejects(outbox.process(operationId), /proof/i);
  assert.equal(outbox.get(operationId).status, 'SUBMITTED');
});

test('deployment and append builders require explicit storage allowance and bind the receiver', () => {
  const record = buildCareerRecord(result, domain, provenance);
  assert.throws(() => buildCareerAppendTransaction(record, { ...domain, signerId: 'signer.testnet' }), /deposit/i);
  const tx = buildCareerAppendTransaction(record, { ...domain, signerId: 'signer.testnet', storageDepositAtomic: '1000' });
  assert.equal(tx.receiverId, domain.contractId);
  assert.equal(tx.actions[0].params.methodName, 'append_career');
  assert.equal(tx.actions[0].params.deposit, '1000');
  assert.equal(buildPassportInitTransaction({ ...domain, ownerId: 'operator.testnet', signerId: 'signer.testnet' })
    .actions[0].params.args.career_signer_id, 'signer.testnet');
});

test('crash before signing recovers only when durable transport proves no signed transaction exists',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  let crashed=true,sends=0;
  const chain={recover:()=>({status:'SAFE_TO_PREPARE'}),submit:async()=>{
    if(crashed){crashed=false;throw new Error('prepare interrupted');}
    sends++;return {status:'SUBMITTED',transactionId:'tx-1'};
  },reconcile:async()=>({status:'UNKNOWN'})};
  const options={database:db,...domain,verifyResult:()=>provenance,chain};
  const first=createCareerOutbox(options),entry=first.enqueue(result);
  await assert.rejects(first.process(entry.operationId),/interrupted/);
  assert.equal(first.get(entry.operationId).status,'SUBMITTED');
  assert.equal((await createCareerOutbox(options).process(entry.operationId)).transactionId,'tx-1');
  assert.equal(sends,1);
});
