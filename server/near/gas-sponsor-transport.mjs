import { createHash } from 'node:crypto';
import { KeyPair, InMemorySigner, keyStores, transactions, utils } from 'near-api-js';
import { accountId } from '../../src/economy/schema.js';

/** Sign the outer transaction using a dedicated funded Testnet account. */
export async function createGasSponsorTransport({ database, signerId, secretKey, rpc }) {
  accountId(signerId);
  if (!signerId.endsWith('.testnet') || !secretKey?.startsWith('ed25519:')) {
    throw Error('A dedicated Testnet Ed25519 sponsor key is required');
  }
  const key = KeyPair.fromString(secretKey);
  const publicKey = key.getPublicKey();
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey('testnet', signerId, key);
  const signer = new InMemorySigner(store);
  database.exec(`CREATE TABLE IF NOT EXISTS near_signer_nonces (
    signer_id TEXT NOT NULL, public_key TEXT NOT NULL, nonce TEXT NOT NULL,
    PRIMARY KEY(signer_id, public_key)
  )`);
  const previous = database.prepare('SELECT nonce FROM near_signer_nonces WHERE signer_id=? AND public_key=?');
  const save = database.prepare(`INSERT INTO near_signer_nonces VALUES(?,?,?)
    ON CONFLICT(signer_id,public_key) DO UPDATE SET nonce=excluded.nonce`);
  return {
    async verifyFunding(budgetAtomic) {
      if ((await rpc('status', [])).chain_id !== 'testnet') throw Error('Sponsor network mismatch');
      const account = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: signerId });
      const keyView = await rpc('query', { request_type: 'view_access_key', block_id: account.block_hash,
        account_id: signerId, public_key: publicKey.toString() });
      const protocol = await rpc('EXPERIMENTAL_protocol_config', { block_id: account.block_hash });
      const storageRate = protocol?.runtime_config?.storage_amount_per_byte;
      if (keyView?.block_hash !== account.block_hash || keyView.permission !== 'FullAccess' ||
          typeof account.amount !== 'string' || !Number.isSafeInteger(account.storage_usage) ||
          typeof storageRate !== 'string' || BigInt(account.amount) - BigInt(account.storage_usage) * BigInt(storageRate) < BigInt(budgetAtomic)) {
        throw Error('Sponsor account or approved budget is not funded on Testnet');
      }
    },
    async prepare(verified) {
      if (verified?.network !== 'near-testnet' || verified.signatureValid !== true || verified.nonceValid !== true ||
          verified.delegateAction?.signedDelegate?.delegateAction?.senderId !== verified.accountId ||
          signerId === verified.accountId) throw Error('Sponsor requires a verified delegated player action');
      if ((await rpc('status', [])).chain_id !== 'testnet') throw Error('Sponsor network mismatch');
      const access = await rpc('query', { request_type: 'view_access_key', finality: 'final',
        account_id: signerId, public_key: publicKey.toString() });
      if (access?.permission !== 'FullAccess' || !Number.isSafeInteger(access.nonce) || access.nonce < 0) {
        throw Error('Sponsor signing key is unavailable');
      }
      const blockHash = utils.serialize.base_decode(access.block_hash);
      if (blockHash.length !== 32) throw Error('Sponsor block hash is invalid');
      let nonce;
      database.exec('BEGIN IMMEDIATE');
      try {
        const local = BigInt(previous.get(signerId, publicKey.toString())?.nonce ?? '0');
        const chain = BigInt(access.nonce);
        nonce = (chain > local ? chain : local) + 1n;
        save.run(signerId, publicKey.toString(), nonce.toString());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      const outer = transactions.createTransaction(signerId, publicKey, verified.accountId, nonce,
        [verified.delegateAction], blockHash);
      const [hash, signed] = await transactions.signTransaction(outer, signer, signerId, 'testnet');
      return { transactionHash: utils.serialize.base_encode(hash), signedTransaction: Buffer.from(signed.encode()).toString('base64') };
    },
    async finalized(prepared, account) {
      const signed = transactions.SignedTransaction.decode(Buffer.from(prepared.signedTransaction, 'base64'));
      const outer = signed.transaction;
      const hash = utils.serialize.base_encode(createHash('sha256').update(new transactions.Transaction(outer).encode()).digest());
      const target = outer.actions?.[0]?.signedDelegate?.delegateAction?.receiverId;
      if (outer.signerId !== signerId || outer.receiverId !== account || outer.actions.length !== 1 || !target ||
          hash !== prepared.transactionHash) throw Error('Stored sponsor transaction does not match the request');
      const result = await rpc('tx', { tx_hash: hash, sender_account_id: signerId, wait_until: 'FINAL' });
      if (result?.final_execution_status !== 'FINAL' || result.transaction?.hash !== hash ||
          result.transaction.signer_id !== signerId || result.transaction.receiver_id !== account) return null;
      if (result.status?.Failure) return { status: 'FAILED', receiptId: result.transaction_outcome?.id ?? hash };
      if (typeof result.status?.SuccessValue !== 'string') return null;
      const outerId = result.transaction_outcome?.outcome?.status?.SuccessReceiptId;
      const delegatedReceipt = result.receipts_outcome?.find(receipt => receipt.id === outerId &&
        receipt.outcome?.executor_id === account);
      const targetReceipt = result.receipts_outcome?.find(receipt =>
        delegatedReceipt?.outcome?.receipt_ids?.includes(receipt.id) && receipt.outcome?.executor_id === target);
      if (!targetReceipt) return null;
      if (targetReceipt.outcome.status?.Failure) return { status: 'FAILED', receiptId: targetReceipt.id };
      return typeof targetReceipt.outcome.status?.SuccessValue === 'string'
        ? { status: 'FINALIZED', receiptId: targetReceipt.id } : null;
    },
    async broadcast(prepared) {
      const tx = transactions.SignedTransaction.decode(Buffer.from(prepared.signedTransaction, 'base64'));
      const expires = tx.transaction.actions[0]?.signedDelegate?.delegateAction?.maxBlockHeight;
      const { header } = await rpc('block', { finality: 'final' });
      if (expires == null) throw Error('Missing sponsor delegate expiry');
      if (BigInt(header.height) >= expires) return 'EXPIRED';
      return rpc('send_tx', { signed_tx_base64: prepared.signedTransaction, wait_until: 'FINAL' });
    },
    async canRelease(prepared) {
      const { transaction } = transactions.SignedTransaction.decode(Buffer.from(prepared.signedTransaction, 'base64'));
      const reference = utils.serialize.base_encode(Uint8Array.from(transaction.blockHash));
      const [start, final] = await Promise.all([
        rpc('block', { block_id: reference }), rpc('block', { finality: 'final' }),
      ]);
      const protocol = await rpc('EXPERIMENTAL_protocol_config', { block_id: final.header.hash });
      if (!Number.isSafeInteger(protocol.transaction_validity_period) || protocol.transaction_validity_period <= 0 ||
          final.header.height <= start.header.height + protocol.transaction_validity_period) return false;
      // If the sponsor nonce was never reached, these bytes were never included.
      // An advanced nonce alone cannot distinguish a superseded transaction from an included one.
      const key = await rpc('query', { request_type: 'view_access_key', block_id: final.header.hash,
        account_id: signerId, public_key: publicKey.toString() });
      return key.block_hash === final.header.hash && Number.isSafeInteger(key.nonce) &&
        BigInt(key.nonce) < transaction.nonce;
    },
  };
}
