import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createFixedReservationQueue } from '../../server/near/reservations.mjs';

const campaignId = 'test-season';
const seasonStartMs = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const validHash = 'a'.repeat(64);
const pilot = JSON.parse(readFileSync(new URL('../../config/economy.testnet.json', import.meta.url)));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fox-reservations-'));
  const path = join(dir, 'queue.sqlite');
  const connections = new Set();
  let time = seasonStartMs;
  t.after(() => {
    for (const connection of connections) connection.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function open(overrides) {
    const database = new DatabaseSync(path);
    connections.add(database);
    const queue = createFixedReservationQueue({ database, config: pilot, campaignId, seasonStartMs, now: () => time,
      verifyChainReservation: async ({ action, reservation, evidence }) => {
        if (evidence?.id !== reservation.id || evidence?.action !== action || evidence?.final !== true) return null;
        return { status: evidence.status, receiptId: evidence.receiptId };
      }, ...overrides });
    return { queue, close() { database.close(); connections.delete(database); } };
  }
  function ready(queue, actor, matchId, mode = 'hunt') {
    return queue.enqueueReady(actor, { requestId: 'r-' + matchId, matchId, taskId: mode + '-task', mode, readyUntil: time + 2 * MINUTE });
  }
  return { open, ready, clock(offset) { time = seasonStartMs + offset; } };
}

function evidence(row, action, status, extra) {
  return { id: row.id, action, status, final: true, receiptId: 'receipt-' + row.id, ...extra };
}

async function finish(queue, row, finishedAt) {
  queue.beginChainReserve(row.id);
  await queue.reconcileChainReserve(row.id, evidence(row, 'reserve', 'reserved'));
  queue.start(row.id);
  return queue.complete(row.id, { finishedAt, resultHash: validHash });
}

test('100 ready requests competing for the last slot produce a single durable allocation', async t => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  for (let i = 0; i < 19; i++) f.ready(first.queue, `prior${i}.testnet`, `prior${i}`);
  assert.equal(first.queue.allocateReady().length, 19);
  const contenders = Array.from({ length: 100 }, (_, i) => i % 2 ? first.queue : second.queue);
  await Promise.all(contenders.map((queue, i) => Promise.resolve().then(() => f.ready(queue, `next${i}.testnet`, `next${i}`))));
  const granted = (await Promise.all(contenders.map(queue => Promise.resolve().then(() => queue.allocateReady())))).flat();
  assert.equal(granted.length, 1);
  assert.equal(granted[0].accountId, 'next0.testnet');
  assert.equal(granted[0].guaranteed, false);
  assert.equal(f.ready(second.queue, 'next0.testnet', 'next0').id, granted[0].id);
  first.close();
  second.close();
  const reopened = f.open().queue;
  assert.equal(reopened.pendingChain().length, 20);
  assert.deepEqual(reopened.allocateReady(), []);
});

test('ready queue uses authenticated actor and prioritizes first award before FIFO repeat awards', async t => {
  const f = fixture(t);
  const { queue } = f.open();
  const spoof = queue.enqueueReady('real.testnet', { accountId: 'fake.testnet', requestId: 'spoof', matchId: 'm1', taskId: 'boss-clear', mode: 'boss', readyUntil: seasonStartMs + MINUTE });
  assert.equal(spoof.accountId, 'real.testnet');
  await finish(queue, queue.allocateReady()[0], seasonStartMs);
  for (let i = 0; i < 18; i++) f.ready(queue, `prior${i}.testnet`, `prior${i}`);
  assert.equal(queue.allocateReady().length, 18);
  f.ready(queue, 'real.testnet', 'm2');
  f.ready(queue, 'fresh.testnet', 'm3');
  f.ready(queue, 'newer.testnet', 'm4');
  assert.equal(queue.allocateReady()[0].accountId, 'fresh.testnet');
});

test('unknown chain receipts preserve capacity until final evidence verifies the reservation', async t => {
  const f = fixture(t);
  const { queue } = f.open();
  const row = f.ready(queue, 'alice.testnet', 'm1');
  queue.allocateReady();
  assert.throws(() => queue.start(row.id), /confirmed/i);
  queue.beginChainReserve(row.id);
  assert.equal(await queue.reconcileChainReserve(row.id, evidence(row, 'reserve', 'reserved', { final: false })), null);
  assert.equal(queue.get(row.id).guaranteed, false);
  f.clock(11 * MINUTE);
  assert.deepEqual(queue.expireUnstarted(), []);
  assert.equal(queue.pendingChain()[0].status, 'submitting');
  await queue.reconcileChainReserve(row.id, evidence(row, 'reserve', 'reserved'));
  assert.equal(queue.get(row.id).status, 'release_pending');
  assert.equal(queue.get(row.id).guaranteed, false);
  assert.equal(await queue.reconcileChainRelease(row.id, evidence(row, 'release', 'released', { final: false })), null);
  await queue.reconcileChainRelease(row.id, evidence(row, 'release', 'released'));
  assert.equal(queue.get(row.id).status, 'expired');
});

test('completion uses issue day and remains valid after midnight and a delayed transport retry', async t => {
  const f = fixture(t);
  const { queue } = f.open();
  f.clock(DAY - 5 * MINUTE);
  for (const [i, mode] of ['hunt', 'boss', 'control'].entries()) {
    f.ready(queue, 'alice.testnet', 'm' + i, mode);
    const [row] = queue.allocateReady();
    if (i < 2) await finish(queue, row, seasonStartMs + DAY - 5 * MINUTE);
    else {
      queue.beginChainReserve(row.id);
      await queue.reconcileChainReserve(row.id, evidence(row, 'reserve', 'reserved'));
      assert.equal(queue.get(row.id).guaranteed, true);
      queue.start(row.id);
      const waiting = f.ready(queue, 'alice.testnet', 'm3', 'trials');
      assert.deepEqual(queue.allocateReady(), []);
      f.clock(DAY + 61 * MINUTE);
      assert.deepEqual(queue.expireUnstarted().map(entry => entry.id), [waiting.id]);
      assert.equal(queue.get(row.id).status, 'started');
      assert.throws(() => queue.complete(row.id, { finishedAt: row.completeBy, resultHash: validHash }));
      const proof = { finishedAt: seasonStartMs + DAY + MINUTE, resultHash: validHash };
      const completed = queue.complete(row.id, proof);
      assert.equal(completed.budgetDay, '2026-01-01');
      assert.deepEqual(queue.complete(row.id, proof), completed);
      assert.throws(() => queue.complete(row.id, { ...proof, resultHash: 'b'.repeat(64) }));
      assert.throws(() => queue.cancel('alice.testnet', row.id));
    }
  }
  f.ready(queue, 'alice.testnet', 'm4');
  assert.equal(queue.allocateReady()[0].budgetDay, '2026-01-02');
});

test('cancel cooldown and start deadline release local slots but preserve verified chain liabilities', async t => {
  const f = fixture(t);
  const { queue } = f.open();
  const row = f.ready(queue, 'alice.testnet', 'm1');
  queue.allocateReady();
  assert.throws(() => queue.cancel('bob.testnet', row.id));
  assert.equal(queue.cancel('alice.testnet', row.id).status, 'cancelled');
  assert.throws(() => f.ready(queue, 'alice.testnet', 'm2'), /cooldown/);
  f.clock(MINUTE);
  const next = f.ready(queue, 'alice.testnet', 'm2');
  queue.allocateReady();
  f.clock(11 * MINUTE);
  assert.deepEqual(queue.expireUnstarted().map(row => row.id), [next.id]);
  const third = f.ready(queue, 'alice.testnet', 'm3');
  queue.allocateReady();
  queue.beginChainReserve(third.id);
  await queue.reconcileChainReserve(third.id, evidence(third, 'reserve', 'reserved'));
  assert.equal(queue.cancel('alice.testnet', third.id).status, 'release_pending');
  f.clock(12 * MINUTE);
  f.ready(queue, 'alice.testnet', 'm4');
  assert.deepEqual(queue.allocateReady(), []);
  await queue.reconcileChainRelease(third.id, evidence(third, 'release', 'released'));
  assert.equal(queue.allocateReady().length, 1);
});

test('three completed awards exhaust the account quota across all four modes', async t => {
  const f = fixture(t);
  const { queue } = f.open();
  for (const mode of ['hunt', 'boss', 'control']) {
    f.ready(queue, 'alice.testnet', mode, mode);
    await finish(queue, queue.allocateReady()[0], seasonStartMs);
  }
  f.ready(queue, 'alice.testnet', 'trials', 'trials');
  f.ready(queue, 'bob.testnet', 'trials', 'trials');
  assert.deepEqual(queue.allocateReady().map(row => row.accountId), ['bob.testnet']);
});

test('cancelling an unknown chain submission holds capacity until finalized reconciliation', async t => {
  const f = fixture(t);
  const { queue } = f.open();
  const row = f.ready(queue, 'alice.testnet', 'm1');
  queue.allocateReady();
  assert.ok(queue.beginChainReserve(row.id));
  assert.equal(queue.beginChainReserve(row.id), null);
  assert.equal(queue.cancel('alice.testnet', row.id).status, 'submitting');
  f.clock(MINUTE);
  f.ready(queue, 'alice.testnet', 'm2');
  assert.deepEqual(queue.allocateReady(), []);
  await queue.reconcileChainReserve(row.id, evidence(row, 'reserve', 'reserved'));
  assert.equal(queue.get(row.id).status, 'release_pending');
  await queue.reconcileChainRelease(row.id, evidence(row, 'release', 'released'));
  assert.equal(queue.get(row.id).status, 'cancelled');
  assert.equal(queue.allocateReady().length, 1);
});

test('a started reservation needs authoritative match closure before release', async t => {
  const f = fixture(t);
  const { queue } = f.open();
  const row = f.ready(queue, 'alice.testnet', 'm1');
  queue.allocateReady();
  queue.beginChainReserve(row.id);
  await queue.reconcileChainReserve(row.id, evidence(row, 'reserve', 'reserved'));
  queue.start(row.id);
  assert.throws(() => queue.closeIncomplete(row.id, { matchId: 'wrong', reason: 'abandoned' }));
  assert.throws(() => queue.closeIncomplete(row.id, { matchId: row.matchId, reason: 'deadline' }));
  f.clock(61 * MINUTE);
  assert.deepEqual(queue.expireUnstarted(), []);
  assert.equal(queue.closeIncomplete(row.id, { matchId: row.matchId, reason: 'deadline' }).status, 'release_pending');
  await queue.reconcileChainRelease(row.id, evidence(row, 'release', 'released'));
  assert.equal(queue.get(row.id).status, 'expired');
});
