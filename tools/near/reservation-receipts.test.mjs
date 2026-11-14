import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservationReceiptVerifier, fixedReservationCall } from '../../server/near/reservation-receipts.mjs';

const economyId = 'economy.testnet';
const signerId = 'signer.testnet';
const transactionHash = 'A'.repeat(44);
const receiptId = 'B'.repeat(44);
const reservation = { id: 'reservation-1', campaignId: 'season-1', accountId: 'alice.testnet',
  matchId: 'match-1', taskId: 'task-1', mode: 'boss', amountAtomic: '5000000000000000000000000',
  createdAt: 1000, startBy: 601000, completeBy: 3601000, dayIndex: 0, windowIndex: 0,
  startedAt: 2000, finishedAt: 3000, resultHash: 'f'.repeat(64) };

function fixture(action, alter = () => {}) {
  const expected = fixedReservationCall('reserve', reservation).args.reservation;
  const { method, args } = fixedReservationCall(action, reservation);
  const response = {
    status: { chain_id: 'testnet' },
    tx: { final_execution_status: 'FINAL', status: { SuccessValue: '' },
      transaction: { hash: transactionHash, signer_id: signerId, receiver_id: economyId,
        actions: [{ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit: '0' } }] },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: receiptId } } },
      receipts_outcome: [{ id: receiptId, outcome: { executor_id: economyId, status: { SuccessValue: '' } } }],
    },
    record: { ...expected, status: { reserve: 'reserved', release: 'released', settle: 'settled' }[action],
      startedAtMs: reservation.startedAt, finishedAtMs: reservation.finishedAt, resultHash: reservation.resultHash },
  };
  alter(response);
  return createReservationReceiptVerifier({ economyId, signerId, async rpc(method, params) {
    if (method === 'query') {
      assert.equal(params.finality, 'final');
      assert.equal(params.method_name, 'get_fixed_reservation');
      return { result: [...Buffer.from(JSON.stringify(response.record))] };
    }
    if (method === 'tx') assert.equal(params.wait_until, 'FINAL');
    return response[method];
  } })({ action, reservation, evidence: { transactionHash } });
}

test('reserve and release require their own finalized matching receipt and contract record', async () => {
  assert.deepEqual(await fixture('reserve'), { status: 'reserved', receiptId });
  assert.deepEqual(await fixture('release'), { status: 'released', receiptId });
});

test('settlement proves the exact completion recorded by the contract', async () => {
  assert.deepEqual(await fixture('settle'), { status: 'settled', receiptId });
  assert.equal(await fixture('settle', value => { value.record.resultHash = 'a'.repeat(64); }), null);
  assert.equal(await fixture('settle', value => { value.record.finishedAtMs++; }), null);
});

test('wrong network, in-flight or failed receipt, unrelated signer and mismatched state remain inconclusive', async () => {
  for (const alter of [
    value => { value.status.chain_id = 'mainnet'; },
    value => { value.tx.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    value => { value.tx.receipts_outcome[0].outcome.status = { Failure: {} }; },
    value => { value.tx.transaction.signer_id = 'wrong.testnet'; },
    value => { value.tx.transaction.actions[0].FunctionCall.method_name = 'unrelated'; },
    value => { value.record.amountAtomic = '1'; },
    value => { value.record.status = 'released'; },
  ]) assert.equal(await fixture('reserve', alter), null);
});
