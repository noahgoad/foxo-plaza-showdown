import { actionCreators as action } from '@near-js/transactions';
import { PublicKey } from '@near-js/crypto';
import { openNearWallet } from './game-wallet-entry.js';
import wasmUrl from '../../near-claims/target/near_claims.opt.wasm?url';

const owner = 'xuancanh1.testnet';
const contract = 'claim.' + owner;
const nft = 'fox.' + owner;
const foxo = 'foxo.' + owner;
const faucetCap = 5000n * 10n ** 24n;
const gas = 10n ** 12n;
const deposit = 1n;
const elements = Object.fromEntries(['connect', 'deploy', 'stock', 'fund', 'refresh', 'status']
  .map(id => [id, document.getElementById(id)]));
let wallet, connected, deployment, inventory, funding;

async function query(params) {
  const response = await fetch('https://rpc.testnet.near.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'claims', method: 'query', params: { ...params, finality: 'final' } }),
    signal: AbortSignal.timeout(15000),
  });
  const { result, error } = await response.json();
  if (!result) throw Object.assign(new Error(error?.data || 'NEAR Testnet unavailable'), { kind: error?.cause?.name });
  return result;
}

async function view(account_id, method_name, args = {}) {
  const { result } = await query({ request_type: 'call_function', account_id, method_name, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result)));
}

class ContractCode extends Uint8Array {
  toJSON() { return Array.from(this); }
}

async function prepareDeployment() {
  const [wasm, keys] = await Promise.all([
    fetch(wasmUrl).then(response => {
      if (!response.ok) throw new Error('Claim contract Wasm is unavailable.');
      return response.arrayBuffer();
    }),
    query({ request_type: 'view_access_key_list', account_id: owner }),
  ]);
  if (!WebAssembly.validate(wasm)) throw new Error('Invalid claim contract Wasm.');
  const fullKeys = keys.keys.filter(key => key.access_key.permission === 'FullAccess');
  const key = fullKeys.find(item => item.public_key === connected.publicKey) || (fullKeys.length === 1 && fullKeys[0]);
  if (!key) throw new Error('Could not identify the operator public key.');
  const storageFunding = (BigInt(wasm.byteLength) + 40_000n) * 10n ** 19n;
  return [
    action.createAccount(), action.transfer(storageFunding),
    action.addKey(PublicKey.fromString(key.public_key), action.fullAccessKey()),
    action.deployContract(new ContractCode(wasm)),
    action.functionCall('new', {}, 30n * gas, 0n),
  ];
}

async function inspect() {
  deployment = null;
  inventory = [];
  funding = [];
  const account = await query({ request_type: 'view_account', account_id: contract }).catch(error => {
    if (error.kind === 'UNKNOWN_ACCOUNT') return null;
    throw error;
  });
  if (!account) {
    if (connected) deployment = await prepareDeployment();
    return 'Claim contract has not been deployed.';
  }
  const [available, owned, funded, storage] = await Promise.all([
    view(contract, 'nft_available'),
    view(nft, 'nft_tokens_for_owner', { account_id: owner, from_index: '0', limit: 88 }),
    view(contract, 'faucet_funded'),
    view(foxo, 'storage_balance_of', { account_id: contract }),
  ]);
  inventory = owned.map(token => token.token_id).filter(id => /^(0[4][5-9]|0[5-7][0-9]|08[0-8])$/.test(id)).sort();
  const remaining = faucetCap - BigInt(funded);
  if (connected && remaining > 0n) {
    if (!storage) {
      const bounds = await view(foxo, 'storage_balance_bounds');
      funding.push(action.functionCall('storage_deposit', { account_id: contract, registration_only: true }, 15n * gas, BigInt(bounds.min)));
    }
    funding.push(action.functionCall('ft_transfer_call', { receiver_id: contract, amount: String(remaining), msg: 'faucet' }, 60n * gas, deposit));
  }
  return `NFTs in claim inventory: ${available}. Reserved NFTs still in operator wallet: ${inventory.length}.\nFaucet allocation funded: ${BigInt(funded) / 10n ** 24n} / 5000 FOXO.`;
}

async function run(operation) {
  for (const button of [elements.connect, elements.deploy, elements.stock, elements.fund, elements.refresh]) button.disabled = true;
  let message = '';
  try {
    if (operation) {
      elements.status.textContent = 'Review the request in Intear Wallet.';
      await operation();
    }
  } catch (error) { message = error.message; }
  try {
    const chain = await inspect();
    elements.status.textContent = [message, connected ? 'Connected as ' + owner : 'Connect the Testnet operator wallet.', chain].filter(Boolean).join('\n');
  } catch (error) { elements.status.textContent = [message, error.message].filter(Boolean).join('\n'); }
  elements.connect.disabled = !!connected || !wallet;
  elements.deploy.disabled = !deployment;
  elements.stock.disabled = !connected || !inventory.length;
  elements.fund.disabled = !funding.length;
  elements.refresh.disabled = false;
}

function successful(outcome) {
  return outcome?.transaction?.hash && typeof outcome.status?.SuccessValue === 'string';
}

elements.connect.onclick = () => run(async () => {
  connected = (await wallet.signIn({})).find(account => account.accountId === owner);
  if (!connected) { await wallet.signOut(); throw new Error('Select ' + owner + '.'); }
});
elements.deploy.onclick = () => run(async () => {
  const result = await wallet.signAndSendTransaction({ signerId: owner, receiverId: contract, actions: deployment });
  if (!successful(result)) throw new Error('Deployment did not return a successful receipt.');
});
elements.stock.onclick = () => run(async () => {
  const transactions = [];
  for (let i = 0; i < inventory.length; i += 4) {
    const actions = inventory.slice(i, i + 4).map(token_id =>
      action.functionCall('nft_transfer_call', { receiver_id: contract, token_id, msg: 'claim' }, 60n * gas, deposit));
    transactions.push({ signerId: owner, receiverId: nft, actions });
  }
  const results = await wallet.signAndSendTransactions({ transactions });
  if (results?.length !== transactions.length || !results.every(successful)) {
    throw new Error('Some transfers did not return successful receipts. Review the remaining inventory.');
  }
});
elements.fund.onclick = () => run(async () => {
  const result = await wallet.signAndSendTransaction({ signerId: owner, receiverId: foxo, actions: funding });
  if (!successful(result)) throw new Error('Funding did not return a successful receipt.');
});
elements.refresh.onclick = () => run();
openNearWallet().then(value => { wallet = value; return run(); }).catch(error => {
  elements.status.textContent = error.message;
});
