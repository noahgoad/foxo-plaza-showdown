import { createGasSponsor } from './gas-sponsor.mjs';
import { createGasSponsorTransport } from './gas-sponsor-transport.mjs';
import { createNep366Verifier } from './nep366-verifier.mjs';
import { createHash } from 'node:crypto';

export async function createGasSponsorDispatch({ database, rpc, signerId, secretKey, ...policy }) {
  const verifyDelegate = createNep366Verifier({ rpc });
  const sponsor = createGasSponsor({ ...policy, database, verifyDelegate });
  if (!sponsor.status().enabled || sponsor.status().budgetAtomic === '0') return null;
  const transport = await createGasSponsorTransport({ database, rpc, signerId, secretKey });
  const budget = sponsor.status();
  const remaining = BigInt(budget.budgetAtomic) - BigInt(budget.reservedAtomic);
  await transport.verifyFunding(remaining > 0n ? remaining.toString() : '0');
  database.exec(`CREATE TABLE IF NOT EXISTS near_gas_signed_transactions (
    reservation_id TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL UNIQUE, signed_transaction TEXT NOT NULL
  )`);
  const insert = database.prepare('INSERT INTO near_gas_signed_transactions VALUES(?,?,?)');
  const byId = database.prepare(`SELECT account_id AS accountId,status,receipt_id AS receiptId,
    transaction_hash AS transactionHash,signed_transaction AS signedTransaction
    FROM near_gas_reservations r JOIN near_gas_signed_transactions s ON s.reservation_id=r.id
    WHERE r.id=? AND r.account_id=?`);
  const confirm = database.prepare('UPDATE near_gas_reservations SET status=?,receipt_id=? WHERE id=?');
  const pendingRows = database.prepare(`SELECT r.id,r.account_id AS accountId
    FROM near_gas_reservations r JOIN near_gas_signed_transactions s ON s.reservation_id=r.id
    WHERE r.status='RESERVED' ORDER BY r.rowid`);
  const running = new Map();
  let nextRecoveryAt = 0;
  let recoveryOffset = 0;
  async function reconcile(id, accountId) {
    const row = byId.get(id, accountId);
    if (!row) return null;
    const { transactionHash, signedTransaction } = row;
    if (row.status !== 'RESERVED') return { id, status: row.status, transactionHash, receiptId: row.receiptId };
    const transaction = { transactionHash, signedTransaction };
    async function finalized() {
      try { return await transport.finalized(transaction, accountId); }
      catch { return null; }
    }
    let receipt = await finalized();
    if (!receipt) {
      try {
        const submission = await transport.broadcast(transaction);
        if (submission === 'EXPIRED' && await transport.canRelease(transaction)) {
          confirm.run('REJECTED', null, id);
          return { id, status: 'REJECTED', transactionHash };
        }
      }
      catch { /* Unknown inclusion retains the originally signed bytes. */ }
      receipt = await finalized();
    }
    if (!receipt) return { id, status: 'PENDING', transactionHash };
    confirm.run(receipt.status, receipt.receiptId, id);
    return { id, transactionHash, ...receipt };
  }
  function status(id, accountId) {
    const key = JSON.stringify([id, accountId]);
    if (running.has(key)) return running.get(key);
    const pending = reconcile(id, accountId).finally(() => running.delete(key));
    running.set(key, pending);
    return pending;
  }
  return {
    budget: sponsor.status,
    canRegister: sponsor.canRegister,
    status,
    async tick({ onError = console.error } = {}) {
      if (Date.now() < nextRecoveryAt) return;
      nextRecoveryAt = Date.now() + 30_000;
      const rows = pendingRows.all();
      if (!rows.length) return;
      const row = rows[recoveryOffset++ % rows.length];
      try { await status(row.id, row.accountId); }
      catch (error) { onError(error); }
    },
    async submit(signedDelegate, session) {
      const { accountId } = session;
      if (signedDelegate?.senderId === accountId && typeof signedDelegate.publicKey === 'string' &&
          typeof signedDelegate.nonce === 'string') {
        const id = createHash('sha256').update(accountId+'\0'+signedDelegate.publicKey+'\0'+signedDelegate.nonce).digest('hex');
        if (byId.get(id, accountId)) return status(id, accountId);
      }
      const { id } = await sponsor.reserve(signedDelegate, { session, prepare: transport.prepare,
        persist: (id, transaction) => insert.run(id, transaction.transactionHash, transaction.signedTransaction) });
      return status(id, session.accountId);
    },
  };
}
