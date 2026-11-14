import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { preparePoolBossReceipt, verifyPoolBossReceipt } from '../../server/near/pool-boss-receipt.mjs';

const player = 'fox.testnet', poolId = 'pool.testnet', signerId = 'signer.testnet', matchId = 'round-id';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(t, overrides = {}) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`CREATE TABLE near_results(match_id, account_id, result_hash, payload);
    CREATE TABLE near_result_metrics(match_id, account_id, metrics_hash, payload)`);
  const record = { matchId, accountId: player, mode: 'boss', won: true, left: false, ...overrides };
  const resultHash = sha(record), finishedAt = 1000;
  const metric = { matchId, accountId: player, mode: 'boss', source: 'authoritative-simulation',
    rulesVersion: 'fixture', resultHash, signals: {} };
  const metricsHash = sha(metric);
  database.prepare('INSERT INTO near_results VALUES (?,?,?,?)')
    .run(matchId, player, resultHash, JSON.stringify({ ...record, resultHash, finishedAt }));
  database.prepare('INSERT INTO near_result_metrics VALUES (?,?,?,?)')
    .run(matchId, player, metricsHash, JSON.stringify({ ...metric, metricsHash, finishedAt }));
  return { database, matchId, player, poolId, signerId };
}

test('only an authoritative Boss clear can prepare a pool receipt', t => {
  const valid = fixture(t);
  const request = preparePoolBossReceipt(valid);
  assert.equal(request.signerId, signerId);
  assert.equal(request.receiverId, poolId);
  assert.deepEqual(request.actions[0].params.args, { account_id: player, match_id: matchId, finished_at_ms: 1000 });
  for (const overrides of [{ won: false }, { left: true }, { mode: 'hunt' }]) {
    assert.throws(() => preparePoolBossReceipt(fixture(t, overrides)), /does not match/);
  }
  valid.database.exec("UPDATE near_result_metrics SET metrics_hash='bad'");
  assert.throws(() => preparePoolBossReceipt(valid), /does not match/);
});

test('pool receipt requires exact finalized transaction, receipt and contract record', async t => {
  const request = preparePoolBossReceipt(fixture(t));
  const transactionHash = 'T'.repeat(44), receiptId = 'R'.repeat(44), blockHash = 'B'.repeat(44);
  const expectedCodeHash = 'C'.repeat(44);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
  let final = 'FINAL', viewTime = 1000, recipient = poolId, codeHash = expectedCodeHash;
  const rpc = async (method, params) => {
    if (method === 'status') return { chain_id: 'testnet' };
    if (method === 'tx') return { final_execution_status: final, status: { SuccessValue: '' },
      transaction: { hash: transactionHash, signer_id: signerId, receiver_id: recipient, actions: [{
        FunctionCall: { method_name: 'record_boss_clear', deposit: '0', args: encode(request.actions[0].params.args) },
      }] },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: receiptId } } },
      receipts_outcome: [{ id: receiptId, outcome: { executor_id: poolId, status: { SuccessValue: '' } } }],
    };
    if (method === 'block') return { header: { hash: blockHash, height: 100 } };
    assert.equal(params.block_id, blockHash);
    if (params.request_type === 'view_account') return { block_hash: blockHash, block_height: 100, code_hash: codeHash };
    return { block_hash: blockHash, block_height: 100, result: [...Buffer.from(JSON.stringify(viewTime))] };
  };
  const run = () => verifyPoolBossReceipt({ rpc, request, transactionHash, expectedCodeHash });
  assert.equal((await run()).receiptId, receiptId);
  final = 'EXECUTED_OPTIMISTIC';
  assert.equal(await run(), null);
  final = 'FINAL'; recipient = 'wrong.testnet';
  assert.equal(await run(), null);
  recipient = poolId; viewTime = 1001;
  assert.equal(await run(), null);
  viewTime = 1000; codeHash = 'D'.repeat(44);
  assert.equal(await run(), null);
});
