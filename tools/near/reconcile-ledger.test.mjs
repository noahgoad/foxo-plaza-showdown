import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileLedger } from './reconcile-ledger.mjs';

const economy = 'economy.testnet';
const token = 'foxo.testnet';
const block = { hash: 'final-block-hash', height: 123, timestamp_nanosec: '1234567890' };
const reward = {
  rewardAvailable: '10000000000000000000000000', campaignAvailable: '11',
  rewardReserved: '12', rewardInFlight: '0', rewardPaid: '1000', craftingFees: '13',
};
const orders = { escrow: '14', payable: '15', inFlight: '0' };
const total = 10000000000000000000000065n;

function fixture(overrides = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'status') return { chain_id: overrides.chain ?? 'testnet' };
    if (method === 'block') {
      assert.deepEqual(params, { finality: 'final' });
      return { header: block };
    }
    assert.equal(method, 'query');
    assert.equal(params.block_id, block.hash);
    assert.equal(params.request_type, 'call_function');
    const args = JSON.parse(Buffer.from(params.args_base64, 'base64'));
    assert.equal(params.account_id, params.method_name === 'ft_balance_of' ? token : economy);
    assert.deepEqual(args, params.method_name === 'ft_balance_of' ? { account_id: economy } : {});
    if (params.method_name === overrides.failView) throw new Error('RPC failure');
    const value = {
      get_config: { foxoContractId: overrides.configToken ?? token, network: 'near-testnet' },
      get_ledger: { ...reward, ...overrides.reward },
      get_order_ledger: { ...orders, ...overrides.orders },
      ft_balance_of: overrides.balance ?? String(total),
    }[params.method_name];
    assert.notEqual(value, undefined);
    return {
      result: [...Buffer.from(JSON.stringify(value))],
      block_hash: params.method_name === overrides.staleView ? 'other-block' : block.hash,
      block_height: block.height,
    };
  };
  return { rpc, calls };
}

function run(overrides) {
  return reconcileLedger({ economy, token, rpc: fixture(overrides).rpc });
}

test('reconciles exact atomic amounts at one finalized block, excluding already paid rewards', async () => {
  const { rpc, calls } = fixture();
  const result = await reconcileLedger({ economy, token, rpc });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.expectedAtomic, String(total));
  assert.equal(result.differenceAtomic, '0');
  assert.equal(result.block.hash, block.hash);
  assert.equal(calls.length, 6);
});

test('fixed rewards held before a match count as an obligation', async () => {
  const result = await run({ reward: { fixedReserved: '5' }, balance: String(total + 5n) });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.buckets.fixedReserved, '5');
  assert.equal((await run({ reward: { fixedReserved: '5' } })).uncoveredDeficitAtomic, '5');
});

test('market fees from the order ledger count toward custody', async () => {
  const result = await run({ orders: { marketFees: '4' }, balance: String(total + 4n) });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.buckets.marketFees, '4');
});

test('distinguishes payout pending within the in-flight bound from an uncovered deficit', async () => {
  const pending = await run({ reward: { rewardInFlight: '30' }, orders: { inFlight: '10' }, balance: String(total + 15n) });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.inFlightAtomic, '40');
  assert.equal(pending.differenceAtomic, '-25');
  assert.equal((await run({ orders: { inFlight: '10' } })).status, 'PENDING');
  assert.equal((await run({ orders: { inFlight: '10' }, balance: String(total + 10n) })).status, 'PENDING');
  const deficit = await run({ orders: { inFlight: '10' }, balance: String(total - 1n) });
  assert.equal(deficit.status, 'DEFICIT');
  assert.equal(deficit.uncoveredDeficitAtomic, '1');
});

test('reports excess funds without treating them as revenue', async () => {
  const result = await run({ balance: String(total + 5n) });
  assert.equal(result.status, 'SURPLUS');
  assert.equal(result.differenceAtomic, '5');
  assert.equal(result.buckets.craftingFees, '13');
});

test('fails closed on wrong chain, config, stale block, unavailable data, and invalid atomic values', async () => {
  const cases = [
    [{ chain: 'mainnet' }, 'WRONG_NETWORK'],
    [{ configToken: 'other.testnet' }, 'TOKEN_MISMATCH'],
    [{ staleView: 'ft_balance_of' }, 'BLOCK_MISMATCH'],
    [{ failView: 'get_order_ledger' }, 'RPC_READ_FAILED'],
    [{ reward: { rewardReserved: '-1' } }, 'INVALID_ATOMIC_AMOUNT'],
    [{ orders: { payable: 1 } }, 'INVALID_ATOMIC_AMOUNT'],
    [{ balance: '340282366920938463463374607431768211456' }, 'INVALID_ATOMIC_AMOUNT'],
  ];
  for (const [overrides, reason] of cases) {
    const result = await run(overrides);
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, reason);
    assert.equal(result.differenceAtomic, null);
  }
});
