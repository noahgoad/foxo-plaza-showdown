import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservationDispatch } from '../../server/near/reservation-dispatch.mjs';

test('ambiguous broadcast survives restart and retries the same signed transaction', async () => {
  const database = new DatabaseSync(':memory:');
  const row = { id: 'fixed-1', status: 'pending', campaignId: 'season', accountId: 'alice.testnet',
    matchId: 'match', taskId: 'task', mode: 'boss', amountAtomic: '5000000000000000000000000',
    createdAt: 1, startBy: 600001, completeBy: 3600001, dayIndex: 0, windowIndex: 0 };
  const sent = [];
  let prepared = 0;
  let finalized = false;
  const transaction = { transactionHash: 'A'.repeat(44), signedTransaction: 'YWJj' };
  const queue = {
    get: () => ({ ...row }),
    beginChainReserve() { row.status = 'submitting'; return row; },
    async reconcileChainReserve(_id, evidence) {
      assert.equal(evidence.transactionHash, transaction.transactionHash);
      if (!finalized) return null;
      row.status = 'reserved';
      return { ...row };
    },
  };
  const make = () => createReservationDispatch({ database, queue,
    async prepare(call) {
      assert.equal(call.method, 'reserve_fixed_reward');
      prepared++;
      return transaction;
    },
    async broadcast(value) {
      assert.equal(database.prepare('SELECT transaction_hash FROM near_reservation_transactions').get().transaction_hash, value.transactionHash);
      sent.push({ ...value });
      if (sent.length === 1) throw new Error('RPC timeout');
      finalized = true;
    },
  });
  try {
    const first = make();
    assert.deepEqual(await Promise.all([first.run(row.id, 'reserve'), first.run(row.id, 'reserve')]), [null, null]);
    assert.equal(row.status, 'submitting');
    assert.equal((await make().run(row.id, 'reserve')).status, 'reserved');
    assert.equal(await make().run(row.id, 'reserve'), null);
    assert.equal(prepared, 1);
    assert.deepEqual(sent, [transaction, transaction]);
  } finally {
    database.close();
  }
});

test('only proven expired attempts are replaced, durably, and retain old evidence', async () => {
  const database = new DatabaseSync(':memory:');
  const row = { id: 'fixed-expired', status: 'completed', startedAt: 2, finishedAt: 3, resultHash: 'a'.repeat(64) };
  let expired = false;
  let prepared = 0;
  let confirmed = false;
  const sent = [];
  const open = () => createReservationDispatch({ database, queue: { get: () => row },
    async prepare() { prepared++; return { transactionHash: (prepared === 1 ? 'A' : 'B').repeat(44), signedTransaction: 'YWJj' }; },
    async canReplace() { return expired; },
    async broadcast(tx) {
      assert.equal(database.prepare('SELECT transaction_hash FROM near_reservation_transactions').get().transaction_hash, tx.transactionHash);
      sent.push(tx.transactionHash);
    },
    async verify({ evidence }) { return confirmed && evidence.transactionHash === 'B'.repeat(44) ? { status: 'settled', receiptId: 'C'.repeat(44) } : null; },
  });
  try {
    assert.equal(await open().run(row.id, 'settle'), null);
    assert.equal(await open().run(row.id, 'settle'), null);
    assert.equal(prepared, 1);
    expired = true;
    assert.equal(await open().run(row.id, 'settle'), null);
    assert.equal(prepared, 2);
    assert.deepEqual(sent, ['A'.repeat(44), 'A'.repeat(44), 'B'.repeat(44)]);
    assert.equal(database.prepare('SELECT count(*) AS n FROM near_reservation_transaction_attempts').get().n, 2);
    confirmed = true;
    assert.equal((await open().run(row.id, 'settle')).status, 'settled');
    assert.equal(prepared, 2);
  } finally { database.close(); }
});

test('recovery dispatches completed results and persists their finalized settlement receipt', async () => {
  const database = new DatabaseSync(':memory:');
  const row = { id: 'fixed-2', status: 'completed', startedAt: 2, finishedAt: 3, resultHash: 'a'.repeat(64) };
  const transactionHash = 'B'.repeat(44);
  let sent = 0;
  const open = () => createReservationDispatch({ database, queue: { get: () => row, pendingChain: () => [row] },
    async prepare(call) {
      assert.deepEqual(call, { method: 'settle_fixed_reward', args: { reservation_id: row.id,
        started_at_ms: 2, finished_at_ms: 3, result_hash: row.resultHash } });
      return { transactionHash, signedTransaction: 'YWJj' };
    },
    async broadcast() { sent++; },
    async verify({ reservation, evidence }) {
      assert.equal(reservation.resultHash, row.resultHash);
      assert.equal(evidence.transactionHash, transactionHash);
      return { status: 'settled', receiptId: 'receipt-2' };
    },
  });
  try {
    await open().recover({ onError: error => { throw error; } });
    await open().recover({ onError: error => { throw error; } });
    assert.deepEqual(await open().run(row.id, 'settle'), { status: 'settled', transactionHash, receiptId: 'receipt-2' });
    assert.equal(sent, 1);
  } finally {
    database.close();
  }
});
