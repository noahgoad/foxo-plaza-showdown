import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';
import { pilotRecipe } from '../../assets/near-fox/economy-catalogue.js';

export const NEAR_TESTNET = Object.freeze({
  network: 'near-testnet',
  nft: 'fox.xuancanh1.testnet',
  token: 'foxo.xuancanh1.testnet',
  claims: 'claim.xuancanh1.testnet',
});
export const FOXO_ICON = new URL('../../assets/near-fox/foxo-token-icon.png', import.meta.url).href;
export const FOXO_EXPLORER = 'https://testnet.nearblocks.io/token/' + NEAR_TESTNET.token;

export function nearRelayUrl() {
  return new URLSearchParams(location.search).get('huntRelay') ||
    (location.protocol === 'https:' ? location.origin + '/relay' : location.protocol + '//' + location.hostname + ':8818');
}

export async function readNearWorkshopProgress(state, relay = nearRelayUrl()) {
  const response = await fetch(relay + '/near/workshop/progress', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nearSession: state.nearSession, tokenId: state.nft?.tokenId }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error('Boss win history is unavailable.');
  const { progress } = await response.json();
  return { ...progress, storageScope: state.address };
}

const readRpcEndpoints = ['https://near-testnet.drpc.org', 'https://rpc.testnet.fastnear.com'];

async function queryNear(id, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'query', params });
  for (const endpoint of readRpcEndpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload?.result || payload?.error?.data || payload?.error?.cause) return payload;
    } catch { /* Try the other Testnet RPC for transport or decoding failures. */ }
  }
  throw new Error('NEAR Testnet RPC is unavailable. Try refreshing your wallet.');
}

export async function viewNearContract(accountId, method, args = {}, { blockId } = {}) {
  const encoded = new TextEncoder().encode(JSON.stringify(args));
  const { result, error } = await queryNear(method, {
    request_type: 'call_function', account_id: accountId, method_name: method,
    args_base64: btoa(String.fromCharCode(...encoded)), ...(blockId ? { block_id: blockId } : { finality: 'final' }),
  });
  if (error || !Array.isArray(result?.result)) throw new Error('Could not read ' + method + ' on NEAR Testnet.');
  return { value: JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))),
    blockHeight: result.block_height, blockHash: result.block_hash };
}

export async function readNearAccountCode(accountId, { blockId } = {}) {
  const { result, error } = await queryNear('code', {
    request_type: 'view_account', account_id: accountId, ...(blockId ? { block_id: blockId } : { finality: 'final' }),
  });
  if (error || typeof result?.code_hash !== 'string' || typeof result.block_hash !== 'string') {
    throw new Error('Contract code could not be verified.');
  }
  return { codeHash: result.code_hash, blockHash: result.block_hash };
}

export async function readEquippedFoxCosmetic(account, { contractId = economyDeployment.accountId, view = viewNearContract } = {}) {
  if (!contractId || !account) return null;
  const { value: id, blockHash } = await view(contractId, 'get_equipped', { account_id: account });
  if (typeof id !== 'string' || !blockHash) return null;
  const { value: item, blockHash: itemBlock } = await view(contractId, 'get_item', { item_id: id }, { blockId: blockHash });
  if (itemBlock !== blockHash || item?.itemId !== id || item.ownerId !== account) return null;
  const recipe = item.sku === pilotRecipe.sku ? pilotRecipe :
    (await import('../../assets/near-fox/catalogue.v2.json',{with:{type:'json'}})).default.items
      .find(row => row.transferability === 'tradable' && row.sku === item.sku);
  if (!recipe || item.recipeId !== recipe.recipeId || item.recipeVersion !== (recipe.version ?? recipe.recipeVersion)) return null;
  return item.sku;
}

export async function readEquippedWeaponFinish(account, options) {
  const sku=await readEquippedFoxCosmetic(account,options);
  return sku==='outfit-recolor-tide-v2'?null:sku;
}

async function view(accountId, method, args) {
  return (await viewNearContract(accountId, method, args)).value;
}

export function formatFoxo(value) {
  if (!/^\d+$/.test(value)) throw new Error('Invalid FOXO balance.');
  const digits = value.padStart(25, '0');
  const whole = BigInt(digits.slice(0, -24)).toLocaleString('en-US');
  const fraction = digits.slice(-24).replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : whole;
}

export function nearFoxProfile(token, address = token?.owner_id) {
  const id = token?.token_id;
  const metadata = token?.metadata;
  if (typeof id !== 'string' || typeof address !== 'string' || token.owner_id !== address) {
    throw new Error('The NFT does not belong to the requested wallet.');
  }
  let attributes = [];
  try {
    const extra = JSON.parse(metadata?.extra);
    if (Array.isArray(extra?.attributes)) {
      attributes = extra.attributes.filter(trait =>
        typeof trait?.trait_type === 'string' && typeof trait.value === 'string');
    }
  } catch { /* Optional NEP-177 extra metadata. */ }
  const media = metadata?.media;
  const image = typeof media === 'string' && media.startsWith('https://') ? media : null;
  return { tokenId: id, contract: NEAR_TESTNET.nft, collectionId: NEAR_TESTNET.nft,
    edition: 'genesis', ownerId: address, name: metadata?.title || 'NEAR Fox #' + id, image, attributes };
}

export async function readNearFox(address, tokenId) {
  return nearFoxProfile(await view(NEAR_TESTNET.nft, 'nft_token', { token_id: tokenId }), address);
}

export async function readNearFoxPages(address, readPage = view) {
  const profiles = new Map();
  let offset = 0n;
  const limit = 25;
  while (true) {
    const rows = await readPage(NEAR_TESTNET.nft, 'nft_tokens_for_owner',
      { account_id: address, from_index: offset.toString(), limit });
    if (!Array.isArray(rows) || rows.length > limit) throw new Error('Invalid NEAR Fox ownership page.');
    const sizeBefore = profiles.size;
    for (const token of rows) {
      const profile = nearFoxProfile(token, address);
      profiles.set(profile.tokenId, profile);
    }
    if (rows.length < limit) return [...profiles.values()];
    if (profiles.size === sizeBefore) throw new Error('NEAR Fox ownership pagination did not advance.');
    offset += BigInt(rows.length);
  }
}

export async function readNearAssets(address) {
  const [profiles, balance] = await Promise.all([
    readNearFoxPages(address), view(NEAR_TESTNET.token, 'ft_balance_of', { account_id: address }),
  ]);
  return { profiles, tokenBalance: formatFoxo(balance) };
}

export async function readNearClaims(address) {
  const account = { account_id: address };
  const [available, nftStatus, faucetBalance, nextClaim, pending, storage] = await Promise.all([
    view(NEAR_TESTNET.claims, 'nft_available'),
    view(NEAR_TESTNET.claims, 'nft_claim_status', account),
    view(NEAR_TESTNET.claims, 'faucet_available'),
    view(NEAR_TESTNET.claims, 'faucet_next_claim_ms', account),
    view(NEAR_TESTNET.claims, 'faucet_claim_pending', account),
    view(NEAR_TESTNET.token, 'storage_balance_of', account),
  ]);
  const storageBounds = storage ? null : await view(NEAR_TESTNET.token, 'storage_balance_bounds');
  return { available, nftStatus, faucetFunded: BigInt(faucetBalance) >= 10n * 10n ** 24n,
    nextClaim, pending, storageDeposit: storageBounds?.min };
}

