import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountId } from '../../src/economy/schema.js';
import { rankingMetricsHash } from './ranking-rubric.mjs';

const hashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function preparePoolBossReceipt({ database, matchId, player, poolId, signerId }) {
  accountId(player);
  accountId(poolId);
  accountId(signerId);
  if (typeof matchId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(matchId)) throw new Error('Invalid Boss match ID');
  const row = database.prepare(`SELECT r.payload,r.result_hash,m.payload AS metric,m.metrics_hash
    FROM near_results r JOIN near_result_metrics m USING(match_id,account_id)
    WHERE r.match_id=? AND r.account_id=?`).get(matchId, player);
  if (!row) throw new Error('Authoritative Boss evidence is unavailable');
  const { resultHash, finishedAt, ...record } = JSON.parse(row.payload);
  const metric = JSON.parse(row.metric);
  const digest = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  const metricDigest = rankingMetricsHash(metric);
  if (record.matchId !== matchId || record.accountId !== player || record.mode !== 'boss' ||
      record.won !== true || record.left !== false || resultHash !== digest || row.result_hash !== digest ||
      !Number.isSafeInteger(finishedAt) || finishedAt < 1 || metric.matchId !== matchId ||
      metric.accountId !== player || metric.mode !== 'boss' || metric.finishedAt !== finishedAt ||
      metric.source !== 'authoritative-simulation' || metric.resultHash !== resultHash ||
      metric.metricsHash !== metricDigest || row.metrics_hash !== metricDigest) {
    throw new Error('Authoritative Boss clear does not match the stored evidence');
  }
  const args = { account_id: player, match_id: matchId, finished_at_ms: finishedAt };
  return { network: 'near-testnet', resultHash, signerId, receiverId: poolId,
    actions: [{ type: 'FunctionCall', params: { methodName: 'record_boss_clear', args,
      gas: '50000000000000', deposit: '0' } }] };
}

export async function verifyPoolBossReceipt({ rpc, request, transactionHash, expectedCodeHash }) {
  if (!hashPattern.test(transactionHash) || !hashPattern.test(expectedCodeHash) ||
      request.network !== 'near-testnet') throw new Error('Invalid Testnet proof request');
  if ((await rpc('status', [])).chain_id !== 'testnet') throw new Error('Wrong receipt network');
  const { signerId, receiverId } = request;
  const expected = request.actions[0].params;
  const transaction = await rpc('tx', { tx_hash: transactionHash, sender_account_id: signerId, wait_until: 'FINAL' });
  const tx = transaction?.transaction;
  const call = tx?.actions?.[0]?.FunctionCall;
  const receiptId = transaction?.transaction_outcome?.outcome?.status?.SuccessReceiptId;
  const outcome = transaction?.receipts_outcome?.find(row => row.id === receiptId);
  if (transaction?.final_execution_status !== 'FINAL' || typeof transaction.status?.SuccessValue !== 'string' ||
      tx?.hash !== transactionHash || tx.signer_id !== signerId || tx.receiver_id !== receiverId ||
      tx.actions?.length !== 1 || call?.method_name !== 'record_boss_clear' || call.deposit !== '0' ||
      typeof call.args !== 'string' || !hashPattern.test(receiptId ?? '') ||
      outcome?.outcome?.executor_id !== receiverId || typeof outcome.outcome.status?.SuccessValue !== 'string' ||
      !isDeepStrictEqual(JSON.parse(Buffer.from(call.args, 'base64').toString()), expected.args)) {
    return null;
  }
  const { header } = await rpc('block', { finality: 'final' });
  if (!hashPattern.test(header?.hash ?? '') || !Number.isSafeInteger(header.height)) return null;
  const code = await rpc('query', { request_type: 'view_account', account_id: receiverId, block_id: header.hash });
  if (code?.block_hash !== header.hash || code.block_height !== header.height || code.code_hash !== expectedCodeHash) return null;
  const view = await rpc('query', { request_type: 'call_function', account_id: receiverId,
    method_name: 'get_boss_clear', block_id: header.hash,
    args_base64: Buffer.from(JSON.stringify({
      account_id: expected.args.account_id, match_id: expected.args.match_id,
    })).toString('base64') });
  if (view?.block_hash !== header.hash || view.block_height !== header.height || !Array.isArray(view.result) ||
      JSON.parse(Buffer.from(view.result).toString()) !== expected.args.finished_at_ms) return null;
  return { transactionHash, receiptId, blockHash: header.hash, blockHeight: header.height, resultHash: request.resultHash };
}
