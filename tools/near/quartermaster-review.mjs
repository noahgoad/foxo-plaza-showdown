import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';
import { NEAR_TESTNET } from '../../src/ui/near-testnet-assets.js';
import { fundOrderDraft, orderPriceAtomic } from '../../src/economy/near-orders.js';
import { accountId } from '../../src/economy/schema.js';
import { createQuartermaster } from '../../server/near/quartermaster.mjs';
import { quartermasterStorageDeposit } from '../../server/near/quartermaster-orders.mjs';

const { values } = parseArgs({ options: Object.fromEntries(
  ['buyer', 'funding', 'sku', 'budget', 'price', 'target'].map(name => [name, { type: 'string' }])) });
const { buyer, funding, sku, budget, price, target } = values;
if (!buyer || !funding || !sku || !budget || !price || !/^(?:[1-9]|10)$/.test(target ?? '')) {
  throw Error('Use --buyer <dedicated-testnet-account> --funding <reviewed-id> --sku <published-sku> --budget <FOXO> --price <FOXO> --target <1–10>.');
}
accountId(buyer);
if (!buyer.endsWith('.testnet') || ['xuancanh1.testnet', NEAR_TESTNET.claims, economyDeployment.accountId].includes(buyer)) {
  throw Error('Use a separate sponsored-order Testnet buyer.');
}
const recipe = economyDeployment.recipes.find(row => row.sku === sku);
if (!recipe) throw Error('Choose a published SKU.');
const budgetAtomic = orderPriceAtomic(budget);
const priceAtomic = orderPriceAtomic(price).toString();
const rpc = async (method, params) => {
  const response = await fetch('https://near-testnet.drpc.org', { method: 'POST',
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 'quartermaster-review', method, params }) });
  if (!response.ok) throw Error('Testnet RPC unavailable.');
  const envelope = await response.json();
  if (envelope.error || envelope.result === undefined) throw Error(envelope.error?.cause?.name ?? 'Testnet RPC failed.');
  return envelope.result;
};
if ((await rpc('status', [])).chain_id !== 'testnet') throw Error('Wrong network.');
const { header } = await rpc('block', { finality: 'final' });
const economy = economyDeployment.accountId;
const view = async (account_id, method_name, args = {}) => {
  const result = await rpc('query', { request_type: 'call_function', account_id, method_name, block_id: header.hash,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  if (result.block_hash !== header.hash || !Array.isArray(result.result)) throw Error('Finalized quote unavailable.');
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
};
const [code, balance, published, items, economyConfig] = await Promise.all([
  rpc('query', { request_type: 'view_account', account_id: economy, block_id: header.hash }),
  view(NEAR_TESTNET.token, 'ft_balance_of', { account_id: buyer }),
  view(economy, 'get_recipe', { recipe_id: recipe.recipeId, recipe_version: recipe.version }),
  view(economy, 'get_owned_items', { account_id: buyer, offset: 0, limit: 50 }),
  view(economy, 'get_config'),
]);
if (code.block_hash !== header.hash || !economyDeployment.acceptedCodeHashes.includes(code.code_hash) ||
    economyConfig.foxoContractId !== NEAR_TESTNET.token || !economyConfig.ordersEnabled ||
    published?.sku !== sku || published.version !== recipe.version || !Array.isArray(items) || items.length >= 50) {
  throw Error('Order deployment or complete stock could not be verified.');
}
const db = new DatabaseSync(':memory:');
try {
  const service = createQuartermaster({ database: db, config: { enabled: true, budgetAtomic: budgetAtomic.toString() } });
  const review = await service.propose({ finalized: true, blockHash: header.hash, blockHeight: header.height,
    source: 'Sponsored', fundingId: funding, availableBudgetAtomic: balance,
    skus: [{ sku, stock: items.filter(item => item.recipeId === recipe.recipeId && item.recipeVersion === recipe.version).length,
      target: Number(target), registered: true, previewed: true, minPriceAtomic: priceAtomic,
      maxPriceAtomic: priceAtomic, priceAtomic }] });
  if (!review.proposal) console.log(JSON.stringify({ ...review, blockHeight: header.height }, null, 2));
  else {
    const { quantity } = review.proposal;
    const operationId = crypto.randomUUID();
    const [charge, credit, registration, payer] = await Promise.all([
      view(economy, 'get_order_storage_charge', { quantity }),
      view(economy, 'get_order_storage_credit', { account_id: buyer }),
      view(economy, 'get_order_storage_registration_charge', { account_id: buyer }),
      rpc('query', { request_type: 'view_account', account_id: buyer, block_id: header.hash }),
    ]);
    const deposit = quartermasterStorageDeposit({ charge, credit, registration });
    const storageTransaction = deposit === '0' ? null : { signerId: buyer, receiverId: economy,
      method: 'deposit_order_storage', args: {}, gas: '20000000000000', deposit };
    if (payer.block_hash !== header.hash || BigInt(payer.amount) <= BigInt(deposit)) {
      throw Error('The dedicated buyer cannot cover the storage deposit and gas.');
    }
    console.log(JSON.stringify({ status: 'UNSIGNED_REVIEW', blockHeight: header.height, fundingId: funding,
      review, storage: { charge, credit, registration, storageTransaction }, order: fundOrderDraft({ token: NEAR_TESTNET.token, economy, buyer,
        operationId, recipe, quantity, price, expiresAtMs: review.proposal.expiresAtMs }) }, null, 2));
  }
} finally {
  db.close();
}
