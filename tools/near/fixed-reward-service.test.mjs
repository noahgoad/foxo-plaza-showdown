import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createFixedRewardService } from '../../server/near/fixed-reward-service.mjs';

test('ready, chain reserve, completion and restart expose one beneficiary claim', async () => {
  const database = new DatabaseSync(':memory:');
  const config = JSON.parse(readFileSync(new URL('../../config/economy.testnet.json', import.meta.url)));
  const seasonStartMs = Date.UTC(2026, 10, 12);
  let time = seasonStartMs + 1000;
  let sequence = 0;
  let record;
  const transactions = new Map();
  const economyId = 'economy.testnet', signerId = 'signer.testnet';
  const options = { database, config, campaignId: 'season', seasonStartMs, economyId, signerId, now: () => time,
    async prepare(call) {
      const transactionHash = String.fromCharCode(65 + sequence++).repeat(44);
      transactions.set(transactionHash, { call, sent: false });
      return { transactionHash, signedTransaction: Buffer.from(transactionHash).toString('base64') };
    },
    async broadcast({ transactionHash }) {
      const tx = transactions.get(transactionHash);
      tx.sent = true;
      if (tx.call.method === 'reserve_fixed_reward') record = { ...tx.call.args.reservation, status: 'reserved' };
      else if (tx.call.method === 'settle_fixed_reward') record = { ...record, status: 'settled',
        startedAtMs: tx.call.args.started_at_ms, finishedAtMs: tx.call.args.finished_at_ms, resultHash: tx.call.args.result_hash };
      else record.status = 'released';
    },
    async rpc(method, params) {
      if (method === 'status') return { chain_id: 'testnet' };
      if (method === 'query') return { result: [...Buffer.from(JSON.stringify(record))] };
      const tx = transactions.get(params.tx_hash);
      if (!tx?.sent) throw new Error('Not broadcast yet');
      const receiptId = 'Z'.repeat(44);
      return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
        transaction: { hash: params.tx_hash, signer_id: signerId, receiver_id: economyId,
          actions: [{ FunctionCall: { method_name: tx.call.method, args: Buffer.from(JSON.stringify(tx.call.args)).toString('base64'), deposit: '0' } }] },
        transaction_outcome: { outcome: { status: { SuccessReceiptId: receiptId } } },
        receipts_outcome: [{ id: receiptId, outcome: { executor_id: economyId, status: { SuccessValue: '' } } }],
      };
    },
  };
  try {
    let service = createFixedRewardService(options);
    const { id } = service.ready('alice.testnet', { requestId: 'request', matchId: 'match', taskId: 'complete-boss',
      mode: 'boss', readyUntil: time + 60_000 });
    await service.tick({ onError: error => { throw error; } });
    assert.equal(service.get(id).guaranteed, true);
    service.start(id);
    time += 10_000;
    assert.equal((await service.complete(id, { finishedAt: time, resultHash: 'a'.repeat(64) })).status, 'settled');
    service = createFixedRewardService(options);
    await service.tick();
    assert.equal(sequence, 2);
    assert.equal(service.claims('alice.testnet').entries.length, 1);
    assert.equal(service.claims('bob.testnet').entries.length, 0);
  } finally { database.close(); }
});
