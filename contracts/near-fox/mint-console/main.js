import { Buffer } from 'buffer';
import { PublicKey } from '@near-js/crypto';
import { actionCreators as action } from '@near-js/transactions';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import wasmUrl from '../target/near_fox.opt.wasm?url';
import plan from '../../../nft-art/testnet-88/mint-plan.json';

// NEAR transaction creation and the Intear adapter both use Node's Buffer API.
globalThis.Buffer ??= Buffer;

const owner = 'xuancanh1.testnet';
const contract = 'fox.' + owner;
const rpc = 'https://rpc.testnet.near.org';
const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const deploy = document.querySelector('#deploy');
const mint = document.querySelector('#mint');
const mintAll = document.querySelector('#mint-all');
const refresh = document.querySelector('#refresh');
const storagePrice = 10n ** 19n;
const batchSize = 6;
const mintDeposit = 2n * 10n ** 22n;

class IntearContractCode extends Uint8Array {
  // Intear's JSON transport expects a byte array for DeployContract.
  toJSON() {
    return Array.from(this);
  }
}
let wallet;
let connected;
let state;
let deployActions;

if (plan.network !== 'testnet' || plan.receiver_id !== owner || plan.tokens.length !== 88 ||
    plan.tokens.some((token, index) => token.receiver_id !== owner ||
      token.token_id !== String(index + 1).padStart(3, '0') ||
      token.token_metadata.media !== 'https://near-fox-testnet-media.vercel.app/images/' + token.token_id + '.png')) {
  throw new Error('Invalid collection manifest.');
}

async function query(params) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'near-fox', method: 'query', params: { ...params, finality: 'final' } }),
    signal: AbortSignal.timeout(15000),
  });
  const { result, error } = await response.json();
  if (error) throw Object.assign(new Error(error.data || error.message), { kind: error.cause?.name });
  if (!result) throw new Error('No result from NEAR Testnet.');
  return result;
}

async function view(method, args) {
  const { result } = await query({
    request_type: 'call_function', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result)));
}

async function inspect() {
  const account = await query({ request_type: 'view_account', account_id: contract }).catch(error => {
    if (error.kind === 'UNKNOWN_ACCOUNT') return null;
    throw error;
  });
  if (!account) return { missing: plan.tokens, exists: false };
  const [metadata, tokens] = await Promise.all([
    view('nft_metadata', {}),
    view('nft_tokens', { from_index: '0', limit: 89 }),
  ]);
  if (metadata.name !== 'NEAR Fox' || metadata.symbol !== 'NFOX' || !Array.isArray(tokens)) {
    throw new Error('The contract address already exists with different code or data.');
  }
  const byId = new Map(tokens.map(token => [token.token_id, token]));
  for (const token of tokens) {
    const expected = plan.tokens.find(item => item.token_id === token.token_id);
    if (!expected || token.owner_id !== owner || token.metadata?.media_hash !== expected.token_metadata.media_hash ||
        token.metadata?.media !== expected.token_metadata.media) {
      throw new Error('On-chain token differs from the collection manifest: ' + token.token_id);
    }
  }
  return { missing: plan.tokens.filter(token => !byId.has(token.token_id)), exists: true };
}

async function run(operation, message) {
  for (const button of [connect, deploy, mint, mintAll, refresh]) button.disabled = true;
  let failure;
  try {
    if (operation) {
      status.textContent = 'Review and confirm the request in Intear Wallet.';
      await operation();
    }
  } catch (error) {
    failure = error.message === 'Popup was blocked'
      ? 'Allow pop-ups for this page, then click the review button again.'
      : error.message;
  }
  state = null;
  deployActions = null;
  try {
    state = await inspect();
    if (connected && !state.exists) deployActions = await prepareDeployment();
    status.textContent = [failure || message, connected ? 'Wallet: ' + owner : 'Connect the specified testnet wallet.',
      state.exists ? 'Finalized on-chain: ' + (88 - state.missing.length) + '/88' : 'Contract has not been deployed.'
    ].filter(Boolean).join('\n');
  } catch (error) {
    status.textContent = [failure, error.message].filter(Boolean).join('\n');
  } finally {
    connect.disabled = Boolean(connected);
    refresh.disabled = false;
    deploy.disabled = !deployActions;
    mint.disabled = !connected || !state?.exists || !state.missing.length;
    mintAll.disabled = mint.disabled || state.missing.length <= batchSize;
  }
}

async function send(actions) {
  const result = await wallet.signAndSendTransaction({ signerId: owner, receiverId: contract, actions });
  if (!result?.transaction?.hash || !result.status || !Object.hasOwn(result.status, 'SuccessValue')) {
    throw new Error('No successful transaction receipt. Refresh before trying again.');
  }
}

function mintActions(tokens) {
  return tokens.map(token => action.functionCall('nft_mint', token, 18n * 10n ** 12n, mintDeposit));
}

connect.onclick = () => run(async () => {
  const selector = await setupWalletSelector({ network: 'testnet', modules: [setupIntearWallet()] });
  wallet = await selector.wallet('intear-wallet');
  const accounts = await wallet.signIn({});
  connected = accounts.find(account => account.accountId === owner);
  if (!connected) {
    await wallet.signOut();
    throw new Error('Select ' + owner + ' in Intear Wallet.');
  }
});

async function prepareDeployment() {
  const [wasm, keys] = await Promise.all([
    fetch(wasmUrl).then(response => {
      if (!response.ok) throw new Error('Compiled contract is missing.');
      return response.arrayBuffer();
    }),
    query({ request_type: 'view_access_key_list', account_id: owner }),
  ]);
  const fullKeys = keys.keys.filter(key => key.access_key.permission === 'FullAccess');
  const key = fullKeys.find(item => item.public_key === connected.publicKey) ||
    (fullKeys.length === 1 ? fullKeys[0] : undefined);
  if (!key) throw new Error('Could not identify the wallet full-access public key for the subaccount.');
  const funding = (BigInt(wasm.byteLength) + 4000n) * storagePrice;
  return [
    action.createAccount(),
    action.transfer(funding),
    action.addKey(PublicKey.fromString(key.public_key), action.fullAccessKey()),
    action.deployContract(new IntearContractCode(wasm)),
    action.functionCall('new', { owner_id: owner }, 25n * 10n ** 12n, 0n),
  ];
}

// Start the wallet request in the click handler while the browser permits pop-ups.
deploy.onclick = () => run(() => send(deployActions), 'Contract deployment confirmed.');
mint.onclick = () => run(() => send(mintActions(state.missing.slice(0, batchSize))), 'Mint batch confirmed.');
mintAll.onclick = () => run(async () => {
  const tokens = state.missing;
  const transactions = [];
  for (let offset = 0; offset < tokens.length; offset += batchSize) {
    transactions.push({
      signerId: owner,
      receiverId: contract,
      actions: mintActions(tokens.slice(offset, offset + batchSize)),
    });
  }
  const receipts = await wallet.signAndSendTransactions({ transactions });
  if (receipts?.length !== transactions.length || receipts.some(receipt =>
    !receipt?.transaction?.hash || !receipt.status || !Object.hasOwn(receipt.status, 'SuccessValue'))) {
    throw new Error('Some batches did not return successful receipts. Check the finalized count before retrying.');
  }
}, 'Wallet returned successful receipts for every requested batch.');

refresh.onclick = () => run();
void run();
