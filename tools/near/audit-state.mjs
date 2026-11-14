import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NEAR_TESTNET } from '../../src/ui/near-testnet-assets.js';

const { nft, token, claims } = NEAR_TESTNET;
const operator = 'xuancanh1.testnet';
const rpcUrl = 'https://rpc.testnet.near.org';
const indexerUrl = 'https://api-testnet.nearblocks.io/v3';
const tokenIds = Array.from({ length: 44 }, (_, index) => String(index + 45).padStart(3, '0'));
const allowedViews = new Map([
  [nft, new Set(['nft_metadata', 'nft_total_supply', 'nft_token'])],
  [token, new Set(['ft_metadata', 'ft_total_supply', 'ft_balance_of', 'storage_balance_of', 'storage_balance_bounds'])],
  [claims, new Set(['nft_available', 'nft_claim_status', 'faucet_available', 'faucet_funded', 'faucet_next_claim_ms', 'faucet_claim_pending'])],
]);
const rpcErrorCodes = new Set(['UNKNOWN_ACCOUNT', 'UNKNOWN_BLOCK', 'UNKNOWN_TRANSACTION', 'NO_SYNCED_BLOCKS', 'CONTRACT_EXECUTION_ERROR']);
const atomic = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const unknown = error => ({ status: 'UNKNOWN', value: null, error });
const known = value => ({ status: 'READ', value });

class AuditError extends Error {}

async function read(action) {
  try {
    return known(await action());
  } catch (error) {
    return unknown(error instanceof AuditError ? error.message : 'RPC_READ_FAILED');
  }
}

function expect(condition, code) {
  if (!condition) throw new AuditError(code);
}

async function publicRpc(method, params) {
  expect(['status', 'block', 'query', 'tx'].includes(method), 'READ_ONLY');
  const response = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'near-audit', method, params }),
    signal: AbortSignal.timeout(15000),
  });
  expect(response.ok, `HTTP_${response.status}`);
  const { result, error } = await response.json();
  expect(result !== undefined && !error, rpcErrorCodes.has(error?.cause?.name) ? error.cause.name : 'RPC_READ_FAILED');
  return result;
}

export function compareCode(chainHash, localHash) {
  return {
    status: !chainHash || !localHash ? 'UNKNOWN' : chainHash === localHash ? 'MATCH' : 'MISMATCH',
    chainHash: chainHash ?? null,
    localHash: localHash ?? null,
  };
}

function balanceCheck(left, right) {
  if (!atomic(left) || !atomic(right)) return { status: 'UNKNOWN', differenceAtomic: null };
  const difference = BigInt(left) - BigInt(right);
  return { status: difference === 0n ? 'MATCH' : 'MISMATCH', differenceAtomic: String(difference) };
}

async function collect(names, action) {
  return Object.fromEntries(await Promise.all(Object.entries(names).map(async ([name, args]) => [name, await action(...args)])));
}

export async function auditState({ rpc = publicRpc, accounts = [operator, claims], localHashes = {}, history = null } = {}) {
  const chain = await read(async () => {
    const status = await rpc('status', []);
    expect(status?.chain_id === 'testnet', 'WRONG_NETWORK');
    return status.chain_id;
  });
  const block = chain.status !== 'READ' ? unknown(chain.error) : await read(async () => {
    const { header } = await rpc('block', { finality: 'final' });
    expect(typeof header?.hash === 'string' && Number.isSafeInteger(header.height), 'INVALID_BLOCK');
    return { hash: header.hash, height: header.height, timestampNanosec: header.timestamp_nanosec ?? null };
  });
  const query = async params => {
    if (block.status !== 'READ') return unknown(block.error);
    return read(async () => {
      const result = await rpc('query', { ...params, block_id: block.value.hash });
      expect(result?.block_hash === block.value.hash, 'BLOCK_MISMATCH');
      return result;
    });
  };
  const view = async (account_id, method_name, args = {}) => {
    expect(allowedViews.get(account_id)?.has(method_name), 'READ_ONLY');
    const response = await query({ request_type: 'call_function', account_id, method_name,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    if (response.status !== 'READ') return response;
    return read(async () => {
      expect(Array.isArray(response.value.result), 'INVALID_VIEW_RESULT');
      return JSON.parse(Buffer.from(response.value.result).toString('utf8'));
    });
  };
  const [contractCode, reads, accountReads] = await Promise.all([
    collect({ nft: [nft], token: [token], claims: [claims] }, async account_id => {
      const response = await query({ request_type: 'view_account', account_id });
      return { accountId: account_id, readStatus: response.status, error: response.error ?? null,
        ...compareCode(response.value?.code_hash, localHashes[account_id]) };
    }),
    collect({ nftSupply: [nft, 'nft_total_supply'], nftMetadata: [nft, 'nft_metadata'],
      tokenSupply: [token, 'ft_total_supply'], tokenMetadata: [token, 'ft_metadata'],
      tokenStorageBounds: [token, 'storage_balance_bounds'], nftAvailable: [claims, 'nft_available'],
      faucetAvailable: [claims, 'faucet_available'], faucetFunded: [claims, 'faucet_funded'],
      vaultTokenBalance: [token, 'ft_balance_of', { account_id: claims }] }, view),
    collect(Object.fromEntries(accounts.map(account => [account, [account]])), account_id => collect({
      tokenBalance: [token, 'ft_balance_of', { account_id }], storage: [token, 'storage_balance_of', { account_id }],
      nftClaimStatus: [claims, 'nft_claim_status', { account_id }],
      nextFaucetClaimMs: [claims, 'faucet_next_claim_ms', { account_id }],
      faucetClaimPending: [claims, 'faucet_claim_pending', { account_id }],
    }, view)),
  ]);
  // Limit concurrent inventory queries to avoid a burst against the public RPC.
  const tokens = [];
  for (let index = 0; index < tokenIds.length; index += 6) {
    tokens.push(...await Promise.all(tokenIds.slice(index, index + 6).map(async tokenId => {
      const response = await view(nft, 'nft_token', { token_id: tokenId });
      if (response.status !== 'READ') return { tokenId, ...response };
      if (response.value === null) return { tokenId, status: 'ABSENT', ownerId: null };
      if (response.value?.token_id !== tokenId || typeof response.value?.owner_id !== 'string') {
        return { tokenId, ...unknown('INVALID_TOKEN_IDENTITY') };
      }
      return { tokenId, status: 'READ', ownerId: response.value.owner_id };
    })));
  }
  const unknownTokens = tokens.some(entry => entry.status === 'UNKNOWN');
  const vaultOwned = unknownTokens ? null : tokens.filter(entry => entry.ownerId === claims).length;
  const reportedAvailable = Number.isSafeInteger(reads.nftAvailable.value) ? reads.nftAvailable.value : null;
  const inventory = { tokens, reconciliation: {
    status: vaultOwned === null || reportedAvailable === null ? 'UNKNOWN' : vaultOwned === reportedAvailable ? 'MATCH' : 'MISMATCH',
    vaultOwned, reportedAvailable,
  } };
  const faucetHistory = history && block.status === 'READ'
    ? await read(() => verifyFaucetHistory(rpc, history, block.value.height)) : unknown('HISTORY_UNAVAILABLE');
  const faucetReconciliation = {
    contractVsTokenBalance: balanceCheck(reads.faucetAvailable.value, reads.vaultTokenBalance.value),
    fundedVsReceipts: balanceCheck(reads.faucetFunded.value, faucetHistory.value?.fundedAtomic),
    availableVsReceipts: balanceCheck(reads.faucetAvailable.value, faucetHistory.value?.netAtomic),
  };
  if (typeof reads.tokenMetadata.value?.icon === 'string' && reads.tokenMetadata.value.icon.startsWith('data:')) {
    reads.tokenMetadata.value = { ...reads.tokenMetadata.value, icon: '[embedded icon omitted]' };
  }
  return { schemaVersion: 1, network: NEAR_TESTNET.network, chain, block, contractCode, reads, accountReads,
    inventory, faucetHistory, faucetReconciliation };
}

async function indexedFaucetHistory() {
  const transfers = [];
  let next;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${indexerUrl}/accounts/${claims}/ft-txns`);
    if (next) url.searchParams.set('next', next);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    expect(response.ok, `INDEXER_HTTP_${response.status}`);
    const body = await response.json();
    expect(Array.isArray(body.data), 'INVALID_INDEXER_RESULT');
    transfers.push(...body.data);
    next = body.meta?.next_page;
    if (!next) return transfers;
  }
  throw new AuditError('INDEXER_PAGE_LIMIT');
}

function receiptTransfers(logs) {
  return logs.flatMap(log => {
    if (!log.startsWith('EVENT_JSON:')) return [];
    const event = JSON.parse(log.slice(11));
    return event.standard === 'nep141' && event.event === 'ft_transfer' ? event.data : [];
  });
}

async function verifyFaucetHistory(rpc, history, blockHeight) {
  const transfers = (await history()).filter(row => row.contract_account_id === token && Number(row.block?.block_height) <= blockHeight);
  const receipts = [];
  let funded = 0n;
  let net = 0n;
  const seen = new Set();
  const cached = new Map();
  for (const row of transfers) {
    expect(typeof row.delta_amount === 'string' && /^-?[1-9][0-9]*$/.test(row.delta_amount), 'INVALID_INDEXER_AMOUNT');
    const amount = BigInt(row.delta_amount);
    const sender = amount > 0n ? operator : row.involved_account_id;
    const txHash = row.transaction_hash;
    const key = `${txHash}:${row.receipt_id}:${row.event_index}`;
    expect(!seen.has(key), 'DUPLICATE_INDEXER_EVENT');
    seen.add(key);
    if (!cached.has(txHash)) cached.set(txHash, await rpc('tx', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' }));
    const tx = cached.get(txHash);
    const receipt = tx?.receipts_outcome?.find(item => item.id === row.receipt_id && item.outcome?.executor_id === token);
    expect(tx?.transaction?.hash === txHash && tx.final_execution_status === 'FINAL' && typeof tx.status?.SuccessValue === 'string'
      && receipt && !receipt.outcome.status?.Failure, 'UNVERIFIED_RECEIPT');
    const [from, to] = amount > 0n ? [row.involved_account_id, claims] : [claims, row.involved_account_id];
    expect(receiptTransfers(receipt.outcome.logs).some(event => event.old_owner_id === from && event.new_owner_id === to
      && event.amount === String(amount > 0n ? amount : -amount)), 'RECEIPT_EVENT_MISMATCH');
    if (amount > 0n) {
      const accepted = JSON.parse(Buffer.from(tx.status.SuccessValue, 'base64'));
      const fundedAction = tx.transaction.actions?.some(action => {
        const call = action.FunctionCall;
        if (call?.method_name !== 'ft_transfer_call') return false;
        const args = JSON.parse(Buffer.from(call.args, 'base64'));
        return args.receiver_id === claims && args.msg === 'faucet' && args.amount === row.delta_amount;
      });
      expect(tx.transaction.signer_id === operator && tx.transaction.receiver_id === token && fundedAction
        && accepted === row.delta_amount, 'FUNDING_ACTION_MISMATCH');
      funded += amount;
    }
    net += amount;
    receipts.push({ txHash, receiptId: receipt.id, blockHash: receipt.block_hash, deltaAtomic: row.delta_amount });
  }
  return { indexer: indexerUrl, fundedAtomic: String(funded), netAtomic: String(net), receipts };
}

function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let result = '';
  while (value) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = '1' + result;
  }
  return result;
}

async function wasmHash(path, required) {
  try {
    const bytes = await readFile(path);
    if (!WebAssembly.validate(bytes)) throw Error('Invalid local Wasm');
    return base58(createHash('sha256').update(bytes).digest());
  } catch (error) {
    if (!required && error.code === 'ENOENT') return null;
    throw error;
  }
}

function gitState() {
  const run = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: new URL('../../', import.meta.url) }).trim();
  try {
    return { root: run('rev-parse', '--show-toplevel'), status: run('status', '--porcelain=v1').split('\n').filter(Boolean) };
  } catch {
    return { root: null, status: null, reason: 'GIT_WORKTREE_UNAVAILABLE' };
  }
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, account: { type: 'string', multiple: true },
    'nft-wasm': { type: 'string' }, 'claims-wasm': { type: 'string' }, 'foxo-wasm': { type: 'string' } } });
  const paths = {
    [nft]: [values['nft-wasm'] ?? new URL('../../contracts/near-fox/target/near_fox.opt.wasm', import.meta.url), !!values['nft-wasm']],
    [claims]: [values['claims-wasm'] ?? new URL('../../contracts/near-claims/target/near_claims.opt.wasm', import.meta.url), !!values['claims-wasm']],
  };
  if (values['foxo-wasm']) paths[token] = [values['foxo-wasm'], true];
  const localHashes = await collect(paths, wasmHash);
  const accounts = [...new Set([operator, claims, ...values.account ?? []])];
  if (!accounts.every(account => /^[a-z0-9][a-z0-9_.-]{1,63}$/.test(account))) throw Error('Invalid public account ID');
  const result = await auditState({ accounts, localHashes, history: indexedFaucetHistory });
  const report = { capturedAt: new Date().toISOString(), rpc: rpcUrl, git: gitState(), ...result };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (!values.output) return process.stdout.write(json);
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, json);
  console.log(`Audit evidence saved at ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
