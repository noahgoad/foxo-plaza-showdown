import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createEconomyIndexer } from '../../server/near/indexer.mjs';

const account = 'economy.testnet';
const options = { network: 'near-testnet', contractId: account, startHeight: 10 };
const data = { accountId: 'player.testnet', amountAtomic: '10000000000000000000000000' };
const log = (event = 'reward_funded', ...entries) => 'EVENT_JSON:' + JSON.stringify({
  standard: 'fox_economy', version: '1.0.0', event, data: entries.length ? entries : [data],
});
const receipt = (receiptId, logs, overrides) => ({ receiptId, executorId: account, success: true, logs, ...overrides });
const block = (height, hash, previousHash, receipts = []) => ({ height, hash, previousHash, finality: 'final', receipts });
const first = block(10, 'a', 'start', [receipt('r1', [log()])]);
const second = block(12, 'b', 'a', [receipt('r2', [log('reward_paid', { ...data, operationId: 'claim-1', attempt: '2' })])]);
const events = db => db.prepare('SELECT * FROM near_economy_index_events ORDER BY block_height, log_index, event_index').all();

test('zero remainder refund is valid but zero claim attempt is rejected',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const indexer=createEconomyIndexer(db,options);
  indexer.ingestBlock(block(10,'zero','start',[receipt('refund',[log('order_refund_credited',{...data,amountAtomic:'0',orderId:'finished-order'})])]));
  assert.equal(events(db)[0].amount_atomic,'0');
  assert.throws(()=>indexer.ingestBlock(block(11,'bad','zero',[receipt('bad-attempt',[log('reward_paid',{...data,operationId:'op',attempt:'0'})])])),/attempt/);
  assert.equal(indexer.cursor().hash,'zero');
});

test('resumes a persisted cursor and skips an exact replay without recording twice', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-economy-indexer-'));
  let reopened;
  t.after(() => {
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'index.sqlite');
  const db = new DatabaseSync(path);
  try {
    const indexer = createEconomyIndexer(db, { ...options, getFinalizedBlock: async cursor => {
      assert.equal(cursor, null);
      return first;
    } });
    assert.equal((await indexer.ingestNext()).status, 'APPLIED');
  } finally {
    db.close();
  }
  reopened = new DatabaseSync(path);
  const indexer = createEconomyIndexer(reopened, { ...options, getFinalizedBlock: async cursor => {
    assert.deepEqual(cursor, { height: 10, hash: 'a' });
    return second;
  } });
  assert.equal(indexer.ingestBlock(first).status, 'REPLAY');
  assert.equal((await indexer.ingestNext()).status, 'APPLIED');
  assert.deepEqual(indexer.cursor(), { height: 12, hash: 'b' });
  assert.equal(events(reopened).length, 2);
});

test('keeps receipt, log and event positions distinct and excludes failed or unrelated receipts', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const indexer = createEconomyIndexer(db, options);
  indexer.ingestBlock(block(10, 'a', 'start', [
    receipt('r1', ['ordinary log', log('reward_funded', data, { ...data, amountAtomic: '3' })]),
    receipt('r2', [log()], { success: false }),
    receipt('r3', [log()], { executorId: 'another.testnet' }),
  ]));
  assert.deepEqual(events(db).map(row => [row.receipt_id, row.log_index, row.event_index, row.amount_atomic]), [
    ['r1', 1, 0, data.amountAtomic], ['r1', 1, 1, '3'],
  ]);
});

test('preserves different economic sources and rejects the same receipt event in a later block', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const indexer = createEconomyIndexer(db, options);
  const journalBlock = block(10, 'a', 'start', [
    receipt('r1', [log(), log('craft_fee_collected', { ...data, operationId: 'craft-1', itemId: 'item-1' })]),
    receipt('r2', [log('order_payout_started', { ...data, payoutId: '0' })]),
  ]);
  indexer.ingestBlock(journalBlock);
  assert.equal(indexer.ingestBlock({ ...journalBlock, receipts: [...journalBlock.receipts].reverse() }).status, 'REPLAY');
  const rows = events(db);
  assert.deepEqual(rows.map(row => row.event).sort(), ['craft_fee_collected', 'order_payout_started', 'reward_funded']);
  assert.equal(JSON.parse(rows.find(row => row.event === 'order_payout_started').data).payoutId, '0');
  assert.throws(() => indexer.ingestBlock(block(12, 'b', 'a', [receipt('r1', [log()])])), /UNIQUE constraint/);
  assert.deepEqual(indexer.cursor(), { height: 10, hash: 'a' });
});

test('stops on missing ancestry, reorg or altered replay', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const indexer = createEconomyIndexer(db, { ...options, getFinalizedBlock: async () => null });
  assert.throws(() => indexer.ingestBlock(second), /start height/i);
  indexer.ingestBlock(first);
  assert.equal((await indexer.ingestNext()).status, 'UNAVAILABLE');
  assert.throws(() => indexer.ingestBlock(block(12, 'b', 'unseen')), /previous hash/i);
  assert.throws(() => indexer.ingestBlock(block(10, 'reorg', 'start')), /conflicting/i);
  assert.throws(() => indexer.ingestBlock(block(10, 'a', 'start')), /conflicting/i);
  assert.deepEqual(indexer.cursor(), { height: 10, hash: 'a' });
  assert.equal(events(db).length, 1);
});

test('rolls back both the cursor and prior event inserts when a write fails', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const indexer = createEconomyIndexer(db, options);
  indexer.ingestBlock(first);
  db.exec(`CREATE TRIGGER fail_index_write BEFORE INSERT ON near_economy_index_events
    WHEN NEW.receipt_id = 'fail' BEGIN SELECT RAISE(ABORT, 'write failed'); END;`);
  const interrupted = block(12, 'b', 'a', [receipt('ok', [log()]), receipt('fail', [log()])]);
  assert.throws(() => indexer.ingestBlock(interrupted), /write failed/);
  assert.deepEqual(indexer.cursor(), { height: 10, hash: 'a' });
  assert.equal(events(db).length, 1);
  db.exec('DROP TRIGGER fail_index_write');
  assert.equal(indexer.ingestBlock(interrupted).status, 'APPLIED');
  assert.equal(events(db).length, 3);
});

test('rejects malformed target events, duplicate receipt identities and unfinalized blocks', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const indexer = createEconomyIndexer(db, options);
  assert.throws(() => indexer.ingestBlock({ ...first, finality: 'optimistic' }), /finalized/i);
  assert.throws(() => indexer.ingestBlock(block(10, 'a', 'start', [receipt('r1', ['EVENT_JSON:{'])])), /malformed/i);
  assert.throws(() => indexer.ingestBlock(block(10, 'a', 'start', [receipt('r1', [log('reward_funded', { ...data, amountAtomic: 1 })])])), /atomic/i);
  assert.throws(() => indexer.ingestBlock(block(10, 'a', 'start', [receipt('r1', [log('reward_paid')])])), /operation/i);
  assert.throws(() => indexer.ingestBlock(block(10, 'a', 'start', [receipt('r1', [log()]), receipt('r1', [log()])])), /duplicate receipt/i);
  assert.equal(indexer.cursor(), null);
  assert.equal(events(db).length, 0);
});
test('cosmetic and ranking event variants preserve the finalized cursor',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const indexer=createEconomyIndexer(db,options);
  indexer.ingestBlock(block(10,'mixed','start',[receipt('r',[
    log('cosmetic_sale_opened',{accountId:'player.testnet',grossAtomic:'10'}),
    log('cosmetic_sale_cancelled',{accountId:'player.testnet'}),
    log('cosmetic_sale_filled',{accountId:'player.testnet',grossAtomic:'10',feeAtomic:'1'}),
    log('ranking_draft_proposed',{campaignId:'pilot'}),
    log('ranking_draft_published',{campaignId:'pilot',awardedAtomic:'100'}),
  ])]));
  assert.deepEqual(events(db).map(row=>row.amount_atomic),['0','0','10','0','100']);
});
