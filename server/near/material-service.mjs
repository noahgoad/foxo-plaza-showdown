import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { transactions, utils } from 'near-api-js';
import { materialAward } from '../../src/economy/material-rules.js';
import { rankingMetricsHash } from './ranking-rubric.mjs';

const hashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const zero = () => ({ alloy: 0, core: 0, catalyst: 0 });

export function createMaterialService({ database, economyId, signerId, rpc, prepare, broadcast, canReplace,
  verifyDeployment }) {
  database.exec(`CREATE TABLE IF NOT EXISTS near_material_settlements (
    match_id TEXT NOT NULL, account_id TEXT NOT NULL, result_hash TEXT NOT NULL,
    call_json TEXT NOT NULL, transaction_hash TEXT NOT NULL, signed_transaction TEXT NOT NULL,
    receipt_id TEXT, PRIMARY KEY(match_id,account_id)
  )`);
  const select = database.prepare('SELECT * FROM near_material_settlements WHERE match_id=? AND account_id=?');
  const insert = database.prepare('INSERT INTO near_material_settlements VALUES(?,?,?,?,?,?,NULL)');
  const confirm = database.prepare('UPDATE near_material_settlements SET receipt_id=? WHERE match_id=? AND account_id=?');
  const replace = database.prepare(`UPDATE near_material_settlements SET transaction_hash=?,signed_transaction=?
    WHERE match_id=? AND account_id=? AND transaction_hash=? AND receipt_id IS NULL`);
  const view = async (method, args, blockId) => {
    const query = await rpc('query', { request_type: 'call_function', account_id: economyId,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      ...(blockId ? {block_id:blockId} : {finality:'final'}) });
    if (!Array.isArray(query.result)) throw new Error('Material inventory view is unavailable');
    return JSON.parse(Buffer.from(query.result).toString());
  };
  function validateSigned(signed, call) {
    if (!hashPattern.test(signed?.transactionHash ?? '') || typeof signed.signedTransaction !== 'string' ||
        signed.signedTransaction.length > 32768) throw new Error('Invalid material transaction');
    const tx = transactions.SignedTransaction.decode(Buffer.from(signed.signedTransaction, 'base64')).transaction;
    const action = tx.actions?.[0]?.functionCall;
    const digest = utils.serialize.base_encode(createHash('sha256').update(new transactions.Transaction(tx).encode()).digest());
    if (digest !== signed.transactionHash || tx.signerId !== signerId || tx.receiverId !== economyId ||
        tx.actions.length !== 1 || action?.methodName !== call.method || action.deposit !== 0n ||
        !isDeepStrictEqual(JSON.parse(Buffer.from(action.args).toString()), call.args)) throw new Error('Material signed call mismatch');
    return signed;
  }
  async function proof(row) {
    const call = JSON.parse(row.call_json);
    const signed = { transactionHash: row.transaction_hash, signedTransaction: row.signed_transaction };
    validateSigned(signed, call);
    try {
      const final = await rpc('tx', { tx_hash: row.transaction_hash, sender_account_id: signerId, wait_until: 'FINAL' });
      const tx = final?.transaction, action = tx?.actions?.[0]?.FunctionCall;
      const id = final?.transaction_outcome?.outcome?.status?.SuccessReceiptId;
      const receipt = final?.receipts_outcome?.find(item => item.id === id);
      if (final?.final_execution_status !== 'FINAL' || typeof final.status?.SuccessValue !== 'string' ||
          tx?.hash !== row.transaction_hash || tx.signer_id !== signerId || tx.receiver_id !== economyId ||
          tx.actions?.length !== 1 || action?.method_name !== call.method || action.deposit !== '0' ||
          !isDeepStrictEqual(JSON.parse(Buffer.from(action.args,'base64').toString()),call.args) ||
          !hashPattern.test(id ?? '') || receipt?.outcome?.executor_id !== economyId ||
          typeof receipt.outcome.status?.SuccessValue !== 'string') return null;
      const returned = JSON.parse(Buffer.from(receipt.outcome.status.SuccessValue,'base64').toString());
      return typeof returned === 'boolean' ? id : null;
    } catch { return null; }
  }
  const candidates = database.prepare(`SELECT r.*, m.payload AS metric,m.metrics_hash
    FROM near_results r JOIN near_result_metrics m USING(match_id,account_id)
    WHERE json_extract(r.payload,'$.rulesVersion') IN ('near-authoritative-boss-1','near-authoritative-trials-1')
    AND json_extract(r.payload,'$.left')=0 ORDER BY json_extract(r.payload,'$.finishedAt'),r.match_id,r.account_id`);
  let working = false;
  async function process(row) {
    const { resultHash, finishedAt, ...result } = JSON.parse(row.payload);
    const metric = JSON.parse(row.metric);
    const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    if (digest !== resultHash || row.result_hash !== digest || metric.resultHash !== digest ||
        metric.matchId !== result.matchId || metric.accountId !== result.accountId || metric.mode !== result.mode ||
        metric.source !== 'authoritative-simulation' || metric.finishedAt !== finishedAt ||
        metric.metricsHash !== row.metrics_hash || rankingMetricsHash(metric) !== row.metrics_hash) {
      throw new Error('Material result evidence mismatch');
    }
    const {signals} = metric;
    if (!Number.isSafeInteger(signals.durationMs) || signals.durationMs < 1 ||
        !Number.isSafeInteger(signals.activeMs) || signals.activeMs > signals.durationMs ||
        signals.activeMs * 5 < signals.durationMs || !['normal','hard'].includes(signals.difficulty)) return;
    let saved = select.get(result.matchId,result.accountId);
    if (saved?.receipt_id) return;
    if (saved && saved.result_hash !== resultHash) throw new Error('Conflicting material result');
    if (saved) {
      const receiptId = await proof(saved);
      if (receiptId) { confirm.run(receiptId,result.matchId,result.accountId); return; }
    }
    await verifyDeployment();
    const executionBlock = await rpc('block', { finality: 'final' });
    const executionDay = Number(BigInt(executionBlock.header.timestamp_nanosec)/86400000000000n);
    if (executionDay !== Math.floor(finishedAt/86400000)) return;
    if (!saved) {
      const { header } = await rpc('block', { finality: 'final' });
      const day = Math.floor(Number(BigInt(header.timestamp_nanosec)/1000000n) / 86400000);
      // Quotas belong to the day of play. Late evidence remains visible for operator review.
      if (day !== Math.floor(finishedAt/86400000)) return;
      const inventory = await view('get_inventory',{account_id:result.accountId},header.hash);
      const earned = inventory.grantDay === day ? inventory.grantedToday : zero();
      const materials = materialAward({ mode:result.mode,won:result.won,left:result.left,eligible:true,
        bronze:result.mode==='trials' && result.won },earned);
      if (!Object.values(materials).some(Boolean)) return;
      const call = { method:'grant_materials', args:{ account_id:result.accountId,match_id:result.matchId,materials } };
      const signed = validateSigned(await prepare(call),call);
      insert.run(result.matchId,result.accountId,resultHash,JSON.stringify(call),signed.transactionHash,signed.signedTransaction);
      saved=select.get(result.matchId,result.accountId);
    } else if (canReplace) {
      const call = JSON.parse(saved.call_json);
      const previous = {transactionHash:saved.transaction_hash,signedTransaction:saved.signed_transaction};
      if (await canReplace(previous,call)) {
        const { header } = await rpc('block', { finality: 'final' });
        const executionDay = Number(BigInt(header.timestamp_nanosec)/86400000000000n);
        if (executionDay !== Math.floor(finishedAt/86400000)) return;
        const signed = validateSigned(await prepare(call),call);
        replace.run(signed.transactionHash,signed.signedTransaction,result.matchId,result.accountId,saved.transaction_hash);
        saved=select.get(result.matchId,result.accountId);
      }
    }
    try { await broadcast({transactionHash:saved.transaction_hash,signedTransaction:saved.signed_transaction}); } catch {}
    const receiptId = await proof(saved);
    if (receiptId) confirm.run(receiptId,result.matchId,result.accountId);
  }
  return {
    async tick({onError=console.error}={}) {
      if(working)return;
      working=true;
      try {
        const pendingAccounts=new Set();
        for(const row of candidates.all()) {
          if(pendingAccounts.has(row.account_id))continue;
          try { await process(row); } catch(error) { onError(error); }
          // An unknown grant blocks later grants for its account until its quota is reconciled.
          const pending=select.get(row.match_id,row.account_id);
          if(pending && !pending.receipt_id)pendingAccounts.add(row.account_id);
        }
      } finally {working=false;}
    },
  };
}
