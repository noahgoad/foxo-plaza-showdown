import { createHash } from 'node:crypto';
import { transactions, utils } from 'near-api-js';
import { accountId, atomic } from '../../src/economy/schema.js';

const MAX_U64 = (1n << 64n) - 1n;
const MAX_ARGS_BYTES = 2048;
const MIN_PURCHASE_PRICE = 1_000_000_000n;

function integer(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return integer(String(value));
  const number = atomic(value);
  if (number > MAX_U64) throw Error('NEP-366 integer exceeds u64');
  return number;
}

function canonicalArgs(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(MAX_ARGS_BYTES / 3)) {
    throw Error('NEP-366 arguments exceed size limit');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_ARGS_BYTES || bytes.toString('base64') !== value) {
    throw Error('Invalid NEP-366 arguments encoding');
  }
  return bytes;
}

function maximumDelegateCost(protocol, header, remainingBlocks, gas, functionBytes) {
  const ceiling = atomic(protocol.max_gas_price);
  const [numerator, denominator] = protocol.gas_price_adjustment_rate ?? [];
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
      numerator < 0 || denominator <= 0 || numerator > denominator || ceiling === 0n) {
    throw Error('NEP-366 gas price bounds unavailable');
  }
  const divisor = BigInt(denominator);
  const growth = divisor + BigInt(numerator);
  let price = atomic(header.gas_price);
  if (price === 0n || price > ceiling) throw Error('NEP-366 finalized gas price unavailable');
  // A full adjustment each block is a conservative upper bound. The extra
  // block accounts for creating the outer receipt at the expiry boundary.
  for (let block = 0n; block <= remainingBlocks && price < ceiling; block++) {
    price = (price * growth + divisor - 1n) / divisor;
  }
  if (price > ceiling) price = ceiling;
  if (price < MIN_PURCHASE_PRICE) price = MIN_PURCHASE_PRICE;
  const costs = protocol.runtime_config?.transaction_costs;
  const actions = costs?.action_creation_config;
  const fee = value => {
    const same = integer(value?.send_sir);
    const other = integer(value?.send_not_sir);
    return integer(value?.execution) + (same > other ? same : other);
  };
  const envelope = 2n * fee(costs?.action_receipt_creation_config) + fee(actions?.delegate_cost) +
    fee(actions?.function_call_cost) + BigInt(functionBytes) * fee(actions?.function_call_cost_per_byte);
  return atomic(((gas + envelope) * price).toString()).toString();
}

/** Verify the canonical delegate supplied by the player against a finalized Testnet key. */
export function createNep366Verifier({ rpc, maxHeightDelta = 30 }) {
  if (!Number.isSafeInteger(maxHeightDelta) || maxHeightDelta < 1 || maxHeightDelta > 60) {
    throw Error('Invalid NEP-366 height window');
  }
  return async (signed, session) => {
    const sender = accountId(signed.senderId);
    const receiver = accountId(signed.receiverId);
    if (session?.accountId !== sender) throw Error('NEP-366 sender differs from authenticated player');
    const nonce = integer(signed.nonce);
    const expiryHeight = integer(signed.maxBlockHeight);
    const gas = integer(signed.gas);
    if (signed.deposit !== '0') throw Error('A delegated FunctionCall key requires zero deposit');
    if (gas === 0n || !/^[a-z_][a-z0-9_]{0,63}$/.test(signed.methodName)) {
      throw Error('Invalid NEP-366 function call');
    }
    if (typeof signed.publicKey !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signed.publicKey) ||
        typeof signed.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signed.signature)) {
      throw Error('Invalid NEP-366 public key or signature encoding');
    }
    const publicKey = utils.PublicKey.fromString(signed.publicKey);
    const signature = utils.serialize.base_decode(signed.signature);
    const args = canonicalArgs(signed.argsBase64);
    const delegateAction = {
      senderId: sender, receiverId: receiver, nonce, maxBlockHeight: expiryHeight, publicKey,
      actions: [transactions.functionCall(signed.methodName, args, gas, 0n)],
    };
    const hash = createHash('sha256').update(transactions.encodeDelegateAction(delegateAction)).digest();
    if (signature.length !== 64 || !publicKey.verify(hash, signature)) throw Error('Invalid NEP-366 signature');
    if ((await rpc('status', [])).chain_id !== 'testnet') throw Error('NEP-366 network mismatch');
    const { header } = await rpc('block', { finality: 'final' });
    if (!header?.hash) throw Error('Finalized NEP-366 block unavailable');
    const height = integer(header.height);
    if (expiryHeight <= height || expiryHeight > height + BigInt(maxHeightDelta)) {
      throw Error('NEP-366 height outside sponsor window');
    }
    const [key, protocol] = await Promise.all([
      rpc('query', { request_type: 'view_access_key', account_id: sender, public_key: signed.publicKey, block_id: header.hash }),
      rpc('EXPERIMENTAL_protocol_config', { block_id: header.hash }),
    ]);
    const permission = key?.permission?.FunctionCall;
    if (key?.block_hash !== header.hash || permission?.receiver_id !== receiver ||
        !Array.isArray(permission.method_names) || !permission.method_names.includes(signed.methodName)) {
      throw Error('NEP-366 permission must explicitly authorize the reviewed method');
    }
    if (nonce !== integer(key.nonce) + 1n) throw Error('Invalid NEP-366 nonce');
    if (protocol?.chain_id !== 'testnet') throw Error('NEP-366 protocol network mismatch');
    const blockGasLimit = integer(protocol.gas_limit);
    if (gas > blockGasLimit) throw Error('NEP-366 gas limit unavailable');
    const maximumCost = maximumDelegateCost(protocol, header, expiryHeight - height, gas,
      signed.methodName.length + args.length);
    return {
      accountId: sender, receiverId: receiver, publicKey: signed.publicKey, nonce: nonce.toString(),
      network: 'near-testnet', permission: 'FunctionCall', signatureValid: true, nonceValid: true,
      maximumCostAtomic: maximumCost, issuedAtMs: session.issuedAtMs, expiresAtMs: session.expiresAtMs,
      actions: [{ type: 'FunctionCall', method: signed.methodName, gas: gas.toString(), deposit: '0' }],
      delegateAction: new transactions.Action({ signedDelegate: {
        delegateAction, signature: new transactions.Signature({ keyType: utils.key_pair.KeyType.ED25519, data: signature }),
      } }),
    };
  };
}
