import { KeyPair, InMemorySigner, keyStores, transactions, utils } from 'near-api-js';
import { accountId } from '../../src/economy/schema.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const methods = new Set(['reserve_fixed_reward', 'release_fixed_reward', 'settle_fixed_reward']);
const rankingMethods = new Set(['propose_ranking_draft', 'finalize_ranking_allocation']);

export async function createFixedTransactionTransport({ database, signerId, economyId, secretKey, rpc,
  enableRanking = false, enableGuildMissions = false, careerDepositAtomic = null, materialOnly = false, poolOnly = false }) {
  accountId(signerId);
  accountId(economyId);
  if (typeof rpc !== 'function') throw new TypeError('RPC transport is required');
  if(typeof secretKey!=='string'||!secretKey.startsWith('ed25519:'))throw new Error('Settlement requires an Ed25519 signer key');
  const keyPair = KeyPair.fromString(secretKey);
  const publicKey = keyPair.getPublicKey();
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey('testnet', signerId, keyPair);
  const signer = new InMemorySigner(store);
  database.exec(`CREATE TABLE IF NOT EXISTS near_signer_nonces (
    signer_id TEXT NOT NULL, public_key TEXT NOT NULL, nonce TEXT NOT NULL,
    PRIMARY KEY(signer_id, public_key)
  )`);
  const prior = database.prepare('SELECT nonce FROM near_signer_nonces WHERE signer_id = ? AND public_key = ?');
  const save = database.prepare(`INSERT INTO near_signer_nonces VALUES (?, ?, ?)
    ON CONFLICT(signer_id, public_key) DO UPDATE SET nonce=excluded.nonce`);
  if (careerDepositAtomic !== null && !/^[1-9][0-9]{0,24}$/.test(careerDepositAtomic)) {
    throw new Error('Explicit bounded career storage deposit required');
  }
  const careerOnly = careerDepositAtomic !== null;
  const allowed = method => poolOnly ? method === 'record_boss_clear' : careerOnly ? method === 'append_career' : materialOnly ? ['grant_materials', 'record_profession_matches'].includes(method) :
    methods.has(method) || enableRanking && rankingMethods.has(method) ||
    enableGuildMissions && method === 'settle_guild_mission';
  const depositFor = method => method === 'append_career' ? BigInt(careerDepositAtomic) : 0n;
  return {
    // Expiry proves these bytes cannot be newly included, not that an already
    // included receipt failed. Only identical, contract-idempotent calls may retry.
    async canReplace(value, call) {
      try {
        if (!allowed(call.method)) return false;
        const signed = transactions.SignedTransaction.decode(Buffer.from(value.signedTransaction, 'base64'));
        const tx = signed.transaction;
        const hash = utils.serialize.base_encode(createHash('sha256').update(new transactions.Transaction(tx).encode()).digest());
        const fn = tx.actions?.[0]?.functionCall;
        if (hash !== value.transactionHash || tx.signerId !== signerId || tx.receiverId !== economyId ||
            !['ed25519Key', 'secp256k1Key'].some(kind => tx.publicKey[kind]?.data && publicKey[kind]?.data &&
              Buffer.from(tx.publicKey[kind].data).equals(Buffer.from(publicKey[kind].data))) || tx.actions.length !== 1 ||
            fn?.methodName !== call.method || fn.deposit !== depositFor(call.method) ||
            !isDeepStrictEqual(JSON.parse(Buffer.from(fn.args).toString('utf8')), call.args)) return false;
        const status = await rpc('status', []);
        if (status?.chain_id !== 'testnet') return false;
        const blockHash = utils.serialize.base_encode(Uint8Array.from(tx.blockHash));
        const reference = await rpc('block', { block_id: blockHash });
        const final = await rpc('block', { finality: 'final' });
        if (reference?.header?.hash !== blockHash || !Number.isSafeInteger(reference.header.height) ||
            !Number.isSafeInteger(final?.header?.height) || typeof final.header.hash !== 'string') return false;
        const protocol = await rpc('EXPERIMENTAL_protocol_config', { block_id: final.header.hash });
        const period = protocol?.transaction_validity_period;
        if (!Number.isSafeInteger(period) || period < 1) return false;
        return BigInt(final.header.height) > BigInt(reference.header.height) + BigInt(period);
      } catch {
        return false;
      }
    },
    async prepare({ method, args }) {
      if (!allowed(method)) throw new Error('Method is outside signer scope');
      const status = await rpc('status', []);
      if (status.chain_id !== 'testnet') throw new Error('Wrong signer network');
      const access = await rpc('query', { request_type: 'view_access_key', finality: 'final',
        account_id: signerId, public_key: publicKey.toString() });
      const permission = access.permission?.FunctionCall;
      if (careerOnly && access.permission !== 'FullAccess') throw new Error('Career storage payment requires a dedicated FullAccess signer');
      if (access.permission !== 'FullAccess' && (!permission || permission.receiver_id !== economyId ||
          (permission.method_names.length && !permission.method_names.includes(method)))) throw new Error('Signer key is not authorized');
      if (!Number.isSafeInteger(access.nonce) || typeof access.block_hash !== 'string') throw new Error('Invalid signer access key response');
      let nonce;
      database.exec('BEGIN IMMEDIATE');
      try {
        const local = BigInt(prior.get(signerId, publicKey.toString())?.nonce ?? '0');
        const chain = BigInt(access.nonce);
        nonce = (local > chain ? local : chain) + 1n;
        save.run(signerId, publicKey.toString(), nonce.toString());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      const action = transactions.functionCall(method, args, 100_000_000_000_000n, depositFor(method));
      const transaction = transactions.createTransaction(signerId, publicKey, economyId, nonce,
        [action], utils.serialize.base_decode(access.block_hash));
      const [hash, signed] = await transactions.signTransaction(transaction, signer, signerId, 'testnet');
      return { transactionHash: utils.serialize.base_encode(hash), signedTransaction: Buffer.from(signed.encode()).toString('base64') };
    },
    broadcast: transaction => rpc('send_tx', { signed_tx_base64: transaction.signedTransaction, wait_until: 'FINAL' }),
  };
}
