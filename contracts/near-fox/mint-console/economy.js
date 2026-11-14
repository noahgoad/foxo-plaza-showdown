import { actionCreators as action } from '@near-js/transactions';
import { PublicKey } from '@near-js/crypto';
import { openNearWallet } from './game-wallet-entry.js';
import { onchainPilotRecipe } from '../../../assets/near-fox/economy-catalogue.js';
import wasmUrl from '../../near-economy/target/wasm32-unknown-unknown/release/near_economy.wasm?url';

const operator = 'xuancanh1.testnet';
const contract = 'economy.' + operator;
const token = 'foxo.' + operator;
const gas = 10n ** 12n;
const recipe = onchainPilotRecipe();
const elements = Object.fromEntries(['connect', 'deploy', 'publish', 'refresh', 'status']
  .map(id => [id, document.getElementById(id)]));
let wallet, connected, deployment, canPublish, busy;

async function query(params) {
  const response = await fetch('https://near-testnet.drpc.org', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'fox-economy', method: 'query',
      params: { ...params, finality: 'final' } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('NEAR Testnet RPC returned HTTP ' + response.status);
  const { result, error } = await response.json();
  if (!result) throw Object.assign(new Error('NEAR read failed.'), { kind: error?.cause?.name });
  return result;
}

async function view(method, args = {}) {
  const { result } = await query({ request_type: 'call_function', account_id: contract,
    method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result)));
}

function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let output = '';
  while (value > 0n) {
    output = alphabet[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte) break;
    output = '1' + output;
  }
  return output;
}

class ContractCode extends Uint8Array {
  toJSON() { return Array.from(this); }
}

const binary = fetch(wasmUrl).then(async response => {
  if (!response.ok) throw new Error('Economy Wasm is unavailable.');
  const bytes = await response.arrayBuffer();
  if (!WebAssembly.validate(bytes)) throw new Error('Economy Wasm is invalid.');
  return { bytes, hash: base58(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) };
});

async function inspect() {
  deployment = null;
  canPublish = false;
  const [{ bytes, hash }, chain] = await Promise.all([binary,
    query({ request_type: 'view_account', account_id: contract }).catch(error => {
      if (error.kind === 'UNKNOWN_ACCOUNT') return null;
      throw error;
    })]);
  if (!chain) {
    const funding = (BigInt(bytes.byteLength) + 40_000n) * 10n ** 19n;
    if (connected) {
      const [keys, balance] = await Promise.all([
        query({ request_type: 'view_access_key_list', account_id: operator }),
        query({ request_type: 'view_account', account_id: operator }),
      ]);
      const full = keys.keys.filter(key => key.access_key.permission === 'FullAccess');
      const key = full.find(item => item.public_key === connected.publicKey) || (full.length === 1 && full[0]);
      if (!key) throw new Error('The connected operator full-access public key could not be identified.');
      if (BigInt(balance.amount) <= funding) throw new Error('The operator balance is below the deployment transfer.');
      deployment = [
        action.createAccount(), action.transfer(funding),
        action.addKey(PublicKey.fromString(key.public_key), action.fullAccessKey()),
        action.deployContract(new ContractCode(bytes)),
        action.functionCall('new', { owner_id: operator, foxo_contract_id: token,
          network: 'near-testnet', settlement_signer_id: operator }, 30n * gas, 0n),
      ];
    }
    return 'Account not created.\nStorage funding transfer: ' +
      (Number(funding / 10n ** 18n) / 1e6).toFixed(6) + ' testnet NEAR.\nWasm hash: ' + hash;
  }
  if (chain.code_hash !== hash) throw new Error('Account exists with a different code hash. Deployment controls are disabled.');
  const config = await view('get_config');
  if (config.ownerId !== operator || config.network !== 'near-testnet' || config.foxoContractId !== token) {
    throw new Error('Deployed contract configuration does not match this console.');
  }
  const published = await view('get_recipe', { recipe_id: recipe.recipeId, recipe_version: recipe.version });
  if (published && (published.sku !== recipe.sku || published.version !== recipe.version ||
      published.feeAtomic !== recipe.feeAtomic || Object.keys(recipe.inputs).some(key => recipe.inputs[key] !== published.inputs?.[key]))) {
    throw new Error('The published recipe differs from the game catalogue.');
  }
  canPublish = !!connected && !published;
  return 'Contract verified at finality.\nWasm hash: ' + hash +
    '\nRecipe: ' + (published ? 'Published and verified.' : 'Awaiting publication.') +
    '\nCrafting: ' + (config.craftingEnabled ? 'Enabled' : 'Disabled') +
    '\nBuy orders: ' + (config.ordersEnabled ? 'Enabled' : 'Disabled');
}

async function run(operation) {
  if (busy) return;
  busy = true;
  for (const button of [elements.connect, elements.deploy, elements.publish, elements.refresh]) button.disabled = true;
  let message = '';
  try { if (operation) message = await operation() || ''; }
  catch (error) { message = error.message; }
  try {
    elements.status.textContent = [message, connected ? 'Connected as ' + operator : 'Connect the Testnet operator.', await inspect()].filter(Boolean).join('\n');
  } catch (error) {
    elements.status.textContent = [message, error.message].filter(Boolean).join('\n');
  } finally {
    elements.connect.disabled = !!connected || !wallet;
    elements.deploy.disabled = !deployment;
    elements.publish.disabled = !canPublish;
    elements.refresh.disabled = false;
    busy = false;
  }
}

async function send(actions) {
  elements.status.textContent = 'Review the transaction in Intear.';
  const result = await wallet.signAndSendTransaction({ signerId: operator, receiverId: contract, actions });
  if (!result?.transaction?.hash || typeof result.status?.SuccessValue !== 'string') {
    throw new Error('Transaction outcome unavailable. Refresh chain status.');
  }
  return 'Transaction: ' + result.transaction.hash;
}

elements.connect.onclick = () => run(async () => {
  connected = (await wallet.signIn({})).find(account => account.accountId === operator);
  if (!connected) { await wallet.signOut(); throw new Error('Select ' + operator + '.'); }
});
elements.deploy.onclick = () => run(() => send(deployment));
elements.publish.onclick = () => run(() => send([action.functionCall('add_recipe', { recipe }, 30n * gas, 0n)]));
elements.refresh.onclick = () => run();
run();
openNearWallet().then(value => {
  wallet = value;
  if (!busy && !connected) elements.connect.disabled = false;
}).catch(error => { elements.status.textContent = error.message; });
