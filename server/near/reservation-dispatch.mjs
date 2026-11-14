import { fixedReservationCall } from './reservation-receipts.mjs';

/** Transport must prepare a signed transaction without broadcasting it. */
export function createReservationDispatch({ database, queue, prepare, broadcast, verify, canReplace }) {
  database.exec(`CREATE TABLE IF NOT EXISTS near_reservation_transactions (
    reservation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    transaction_hash TEXT NOT NULL UNIQUE,
    signed_transaction TEXT NOT NULL,
    PRIMARY KEY (reservation_id, action)
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS near_fixed_settlement_receipts (
    reservation_id TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL, receipt_id TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS near_reservation_transaction_attempts (
    reservation_id TEXT NOT NULL, action TEXT NOT NULL, transaction_hash TEXT PRIMARY KEY,
    signed_transaction TEXT NOT NULL
  )`);
  database.exec(`INSERT OR IGNORE INTO near_reservation_transaction_attempts
    SELECT reservation_id, action, transaction_hash, signed_transaction FROM near_reservation_transactions`);
  const remember = database.prepare('INSERT OR IGNORE INTO near_reservation_transaction_attempts VALUES (?, ?, ?, ?)');
  const replace = database.prepare(`UPDATE near_reservation_transactions SET transaction_hash = ?, signed_transaction = ?
    WHERE reservation_id = ? AND action = ? AND transaction_hash = ?`);
  const settlement = database.prepare('SELECT transaction_hash AS transactionHash, receipt_id AS receiptId FROM near_fixed_settlement_receipts WHERE reservation_id = ?');
  const confirmSettlement = database.prepare('INSERT OR IGNORE INTO near_fixed_settlement_receipts VALUES (?, ?, ?)');
  const get = database.prepare(`SELECT transaction_hash AS transactionHash, signed_transaction AS signedTransaction
    FROM near_reservation_transactions WHERE reservation_id = ? AND action = ?`);
  const insert = database.prepare(`INSERT INTO near_reservation_transactions VALUES (?, ?, ?, ?)
    ON CONFLICT(reservation_id, action) DO NOTHING`);
  const running = new Map();
  async function prepareValid(call) {
    const signed = await prepare(call);
    if (typeof signed?.transactionHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signed.transactionHash) ||
        typeof signed.signedTransaction !== 'string' || !/^[A-Za-z0-9+/]{1,8192}={0,2}$/.test(signed.signedTransaction)) {
      throw new Error('Invalid prepared reservation transaction');
    }
    return signed;
  }

  async function dispatch(id, action) {
    const initial = queue.get(id);
    const eligible = { reserve: ['pending', 'submitting'], release: ['release_pending'], settle: ['completed'] }[action];
    if (!initial || !eligible.includes(initial.status)) return null;
    if (action === 'settle') {
      const existing = settlement.get(id);
      if (existing) return { status: 'settled', ...existing };
      if (typeof verify !== 'function') throw new Error('Settlement verifier is required');
    }
    let transaction = get.get(id, action);
    const recovering = Boolean(transaction);
    if (!transaction) {
      // A legacy submitting row may have been broadcast by a different worker.
      if (initial.status === 'submitting') return null;
      const signed = await prepareValid(fixedReservationCall(action, initial));
      insert.run(id, action, signed.transactionHash, signed.signedTransaction);
      transaction = get.get(id, action);
      remember.run(id, action, transaction.transactionHash, transaction.signedTransaction);
    }
    const current = queue.get(id);
    if (!current || !eligible.includes(current.status)) return null;
    const reconcile = action === 'settle' ? async (_, evidence) => {
      const result = await verify({ action, reservation: current, evidence });
      if (result?.status !== 'settled' || typeof result.receiptId !== 'string') return null;
      confirmSettlement.run(id, evidence.transactionHash, result.receiptId);
      return { status: 'settled', ...settlement.get(id) };
    } : action === 'reserve' ? queue.reconcileChainReserve : queue.reconcileChainRelease;
    if (current.status === 'pending' && !queue.beginChainReserve(id)) return null;
    let evidence = { transactionHash: transaction.transactionHash };
    if (recovering) {
      const known = await reconcile(id, evidence);
      if (known) return known;
      const call = fixedReservationCall(action, current);
      if (typeof canReplace === 'function' && await canReplace(transaction, call) === true) {
        const signed = await prepareValid(call);
        // A competing worker can win the replacement; always broadcast the
        // persisted winner. Keep every attempt for recovery/audit after restart.
        database.exec('BEGIN IMMEDIATE');
        try {
          replace.run(signed.transactionHash, signed.signedTransaction, id, action, transaction.transactionHash);
          transaction = get.get(id, action);
          remember.run(id, action, transaction.transactionHash, transaction.signedTransaction);
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        evidence = { transactionHash: transaction.transactionHash };
      }
    }
    // Reuse the exact signed bytes and hash after a timeout or restart.
    try {
      await broadcast(transaction);
    } catch {
      // RPC submission errors alone cannot determine the transaction outcome.
    }
    return reconcile(id, evidence);
  }

  return {
    run(id, action) {
      if (!['reserve', 'release', 'settle'].includes(action)) throw new TypeError('Unknown reservation dispatch action');
      const key = `${action}:${id}`;
      if (running.has(key)) return running.get(key);
      const task = dispatch(id, action).finally(() => running.delete(key));
      running.set(key, task);
      return task;
    },
    async recover({ onError = console.error } = {}) {
      for (const row of queue.pendingChain()) {
        if (row.status === 'completed' && settlement.get(row.id)) continue;
        const action = row.status === 'completed' ? 'settle' : row.status === 'release_pending' ? 'release' : 'reserve';
        try {
          await this.run(row.id, action);
        } catch (error) {
          onError(error, { id: row.id, action });
        }
      }
    },
  };
}
