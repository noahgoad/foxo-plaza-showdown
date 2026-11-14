import { accountId, atomic } from '../../src/economy/schema.js';

const base58Hash = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const testnetRpc = 'https://rpc.testnet.near.org';

async function readRpc(method, params) {
  const response = await fetch(testnetRpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'fox-reservation', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('NEAR RPC read failed');
  const envelope = await response.json();
  if (envelope.error || envelope.result === undefined) throw new Error('NEAR RPC result unavailable');
  return envelope.result;
}

function reservationArgs(row) {
  const times = [row.createdAt, row.startBy, row.completeBy];
  if (!times.every(value => Number.isSafeInteger(value) && value >= 0) ||
      !(times[0] < times[1] && times[1] <= times[2])) throw new Error('Invalid reservation timestamps');
  return {
    id: row.id, campaignId: row.campaignId, accountId: accountId(row.accountId),
    matchId: row.matchId, taskId: row.taskId, mode: row.mode,
    amountAtomic: atomic(row.amountAtomic).toString(), createdAtMs: row.createdAt,
    startByMs: row.startBy, completeByMs: row.completeBy,
    dayIndex: row.dayIndex, windowIndex: row.windowIndex,
  };
}

function matchesRecord(record, expected) {
  return record != null && Object.entries(expected).every(([field, value]) => record[field] === value);
}

export function fixedReservationCall(action, row) {
  if (action === 'reserve') return { method: 'reserve_fixed_reward', args: { reservation: reservationArgs(row) } };
  if (action === 'release') return { method: 'release_fixed_reward', args: { reservation_id: row.id } };
  if (action === 'settle') {
    if (!Number.isSafeInteger(row.startedAt) || !Number.isSafeInteger(row.finishedAt) ||
        row.finishedAt < row.startedAt || !/^[a-f0-9]{64}$/.test(row.resultHash ?? '')) {
      throw new Error('Invalid fixed completion');
    }
    return { method: 'settle_fixed_reward', args: { reservation_id: row.id,
      started_at_ms: row.startedAt, finished_at_ms: row.finishedAt, result_hash: row.resultHash } };
  }
  throw new TypeError('Unknown reservation action');
}

// The queue retains capacity whenever a read is inconclusive. A failed transaction
// alone cannot prove that another outstanding submission cannot reserve the same ID.
export function createReservationReceiptVerifier({ economyId, signerId, rpc = readRpc }) {
  accountId(economyId);
  accountId(signerId);
  return async ({ action, reservation, evidence }) => {
    if (typeof evidence?.transactionHash !== 'string' || !base58Hash.test(evidence.transactionHash)) return null;
    const expected = reservationArgs(reservation);
    const call = fixedReservationCall(action, reservation);
    const expectedStatus = { reserve: 'reserved', release: 'released', settle: 'settled' }[action];
    if (action === 'settle') Object.assign(expected, { startedAtMs: reservation.startedAt,
      finishedAtMs: reservation.finishedAt, resultHash: reservation.resultHash });
    try {
      const network = await rpc('status', []);
      if (network?.chain_id !== 'testnet') return null;
      const result = await rpc('tx', {
        tx_hash: evidence.transactionHash, sender_account_id: signerId, wait_until: 'FINAL',
      });
      const tx = result?.transaction;
      if (result?.final_execution_status !== 'FINAL' || typeof result.status?.SuccessValue !== 'string' ||
          tx?.hash !== evidence.transactionHash || tx.signer_id !== signerId || tx.receiver_id !== economyId ||
          tx.actions?.length !== 1) return null;
      const fn = tx.actions[0]?.FunctionCall;
      if (fn?.method_name !== call.method || fn.deposit !== '0' || typeof fn.args !== 'string' || fn.args.length > 4096) return null;
      const args = JSON.parse(Buffer.from(fn.args, 'base64').toString('utf8'));
      if (action === 'reserve' ? !matchesRecord(args?.reservation, expected) : !matchesRecord(args, call.args)) return null;
      const receiptId = result.transaction_outcome?.outcome?.status?.SuccessReceiptId;
      if (typeof receiptId !== 'string' || !base58Hash.test(receiptId)) return null;
      const receipt = result.receipts_outcome?.find(row => row.id === receiptId);
      if (receipt?.outcome?.executor_id !== economyId || typeof receipt.outcome.status?.SuccessValue !== 'string') return null;
      const view = await rpc('query', {
        request_type: 'call_function', finality: 'final', account_id: economyId, method_name: 'get_fixed_reservation',
        args_base64: Buffer.from(JSON.stringify({ reservation_id: reservation.id })).toString('base64'),
      });
      if (!Array.isArray(view?.result)) return null;
      const record = JSON.parse(Buffer.from(view.result).toString('utf8'));
      return record?.status === expectedStatus && matchesRecord(record, expected)
        ? { status: expectedStatus, receiptId } : null;
    } catch {
      return null;
    }
  };
}
