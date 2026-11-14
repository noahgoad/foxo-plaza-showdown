import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const rpcUrl = 'https://rpc.testnet.near.org';
const maxAtomic = (1n << 128n) - 1n;
const rewardFields = ['rewardAvailable', 'campaignAvailable', 'rewardReserved', 'rewardInFlight', 'craftingFees'];
const rpcErrors = new Set(['UNKNOWN_ACCOUNT', 'UNKNOWN_BLOCK', 'NO_SYNCED_BLOCKS', 'CONTRACT_EXECUTION_ERROR']);
const accountId = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

class ReconciliationError extends Error {}

function expect(condition, reason) {
  if (!condition) throw new ReconciliationError(reason);
}

function atomic(value) {
  expect(typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value), 'INVALID_ATOMIC_AMOUNT');
  const amount = BigInt(value);
  expect(amount <= maxAtomic, 'INVALID_ATOMIC_AMOUNT');
  return amount;
}

async function publicRpc(method, params) {
  expect(['status', 'block', 'query'].includes(method), 'READ_ONLY');
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'near-reconcile-ledger', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(response.ok, `HTTP_${response.status}`);
  const { result, error } = await response.json();
  expect(result !== undefined && !error, rpcErrors.has(error?.cause?.name) ? error.cause.name : 'RPC_READ_FAILED');
  return result;
}

function validAccount(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 && accountId.test(value);
}

function compare(balance, expected, inFlight) {
  const difference = balance - expected;
  const uncovered = -difference - inFlight;
  if (uncovered > 0n) return { status: 'DEFICIT', uncoveredDeficitAtomic: String(uncovered) };
  // A successful outgoing FT receipt can change the balance before the callback clears the ledger.
  if (difference > 0n) return { status: 'SURPLUS', uncoveredDeficitAtomic: '0' };
  if (inFlight > 0n) return { status: 'PENDING', uncoveredDeficitAtomic: '0' };
  return { status: 'MATCH', uncoveredDeficitAtomic: '0' };
}

export async function reconcileLedger({ economy, token, rpc = publicRpc, block }) {
  const report = { schemaVersion: 1, network: 'near-testnet', economy, token, block: null };
  try {
    expect(validAccount(economy) && validAccount(token) && economy !== token, 'INVALID_ACCOUNT');
    const status = await rpc('status', []);
    expect(status?.chain_id === 'testnet', 'WRONG_NETWORK');
    const { header } = await rpc('block', block ? { block_id: block.height } : { finality: 'final' });
    expect(typeof header?.hash === 'string' && header.hash.length > 0 &&
      Number.isSafeInteger(header.height) && header.height >= 0, 'INVALID_BLOCK');
    if (block) {
      const { header: head } = await rpc('block', { finality: 'final' });
      expect(header.hash === block.hash && header.height === block.height &&
        Number.isSafeInteger(head?.height) && head.height >= header.height, 'BLOCK_MISMATCH');
    }
    report.block = { hash: header.hash, height: header.height, timestampNanosec: header.timestamp_nanosec ?? null };

    const view = async (account_id, method_name, args = {}) => {
      const query = await rpc('query', {
        request_type: 'call_function', account_id, method_name, block_id: header.hash,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      });
      expect(query?.block_hash === header.hash && query.block_height === header.height, 'BLOCK_MISMATCH');
      expect(Array.isArray(query.result), 'INVALID_VIEW_RESULT');
      try {
        return JSON.parse(Buffer.from(query.result).toString('utf8'));
      } catch {
        throw new ReconciliationError('INVALID_VIEW_RESULT');
      }
    };

    const config = await view(economy, 'get_config');
    expect(config?.network === report.network, 'WRONG_NETWORK');
    expect(config.foxoContractId === token, 'TOKEN_MISMATCH');
    const [reward, orders, balanceView] = await Promise.all([
      view(economy, 'get_ledger'),
      view(economy, 'get_order_ledger'),
      view(token, 'ft_balance_of', { account_id: economy }),
    ]);
    const buckets = {
      ...Object.fromEntries(rewardFields.map(name => [name, atomic(reward?.[name])])),
      fixedReserved: atomic(reward?.fixedReserved === undefined ? '0' : reward.fixedReserved),
      marketFees: atomic(orders?.marketFees ?? reward?.marketFees ?? '0'),
      orderEscrow: atomic(orders?.escrow),
      orderPayable: atomic(orders?.payable),
      orderInFlight: atomic(orders?.inFlight),
    };
    const paid = atomic(reward?.rewardPaid);
    const balance = atomic(balanceView);
    const expected = Object.values(buckets).reduce((sum, amount) => sum + amount, 0n);
    const inFlight = buckets.rewardInFlight + buckets.orderInFlight;
    return {
      ...report,
      ...compare(balance, expected, inFlight),
      buckets: Object.fromEntries(Object.entries(buckets).map(([name, amount]) => [name, String(amount)])),
      historicalRewardPaidAtomic: String(paid),
      balanceAtomic: String(balance),
      expectedAtomic: String(expected),
      inFlightAtomic: String(inFlight),
      differenceAtomic: String(balance - expected),
    };
  } catch (error) {
    return {
      ...report, status: 'UNKNOWN',
      reason: error instanceof ReconciliationError ? error.message : 'RPC_READ_FAILED',
      differenceAtomic: null,
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    economy: { type: 'string' },
    token: { type: 'string' },
  } });
  const report = await reconcileLedger({ economy: values.economy, token: values.token });
  console.log(JSON.stringify({ rpc: rpcUrl, ...report }, null, 2));
  process.exitCode = { MATCH: 0, DEFICIT: 1, SURPLUS: 1, UNKNOWN: 2, PENDING: 3 }[report.status];
}
