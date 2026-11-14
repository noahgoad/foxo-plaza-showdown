export const QUARTERMASTER_DEFAULTS = Object.freeze({ enabled: false, policyVersion: 'pilot-1',
  budgetAtomic: '0', maxQuantity: 10, maxTtlMs: 300000, providerTimeoutMs: 5000 });
const MAX_ATOMIC = (1n << 128n) - 1n;
const fields = ['sku', 'quantity', 'priceAtomic', 'reason', 'expiresAtMs', 'policyVersion'];
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value);
const sources = new Set(['Player', 'Guild', 'Sponsored']);

function requirePolicy(condition, message) {
  if (!condition) throw new Error(message);
}

export function quartermasterAtomic(value) {
  requirePolicy(typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value), 'Invalid atomic amount');
  const amount = BigInt(value);
  requirePolicy(amount <= MAX_ATOMIC, 'Atomic amount overflow');
  return amount;
}

export function quartermasterContext(context, config, now) {
  requirePolicy(config.enabled === true && id(config.policyVersion) && Number.isSafeInteger(now) &&
    Number.isSafeInteger(config.maxQuantity) && config.maxQuantity > 0 && config.maxQuantity <= 100 &&
    Number.isSafeInteger(config.maxTtlMs) && config.maxTtlMs > 0 && config.maxTtlMs <= 86400000,
  'Invalid or disabled Quartermaster policy');
  requirePolicy(context?.finalized === true && id(context.blockHash) && Number.isSafeInteger(context.blockHeight) &&
    context.blockHeight >= 0 && sources.has(context.source) && id(context.fundingId) && Array.isArray(context.skus),
  'Finalized registered context required');
  const budget = quartermasterAtomic(config.budgetAtomic);
  const available = quartermasterAtomic(context.availableBudgetAtomic);
  const seen = new Set();
  const skus = context.skus.map(row => {
    requirePolicy(id(row.sku) && !seen.has(row.sku) && row.registered === true && row.previewed === true &&
      Number.isSafeInteger(row.stock) && row.stock >= 0 && Number.isSafeInteger(row.target) && row.target >= 0,
    'Invalid registered SKU stock');
    seen.add(row.sku);
    const minimum = quartermasterAtomic(row.minPriceAtomic);
    const maximum = quartermasterAtomic(row.maxPriceAtomic);
    const price = quartermasterAtomic(row.priceAtomic);
    requirePolicy(minimum > 0n && minimum <= price && price <= maximum, 'Invalid SKU price band');
    return { sku: row.sku, stock: row.stock, target: row.target, minPriceAtomic: String(minimum),
      maxPriceAtomic: String(maximum), priceAtomic: String(price), registered: true, previewed: true };
  });
  return { finalized: true, blockHash: context.blockHash, blockHeight: context.blockHeight,
    source: context.source, fundingId: context.fundingId,
    availableBudgetAtomic: String(budget < available ? budget : available), skus };
}

export function validateQuartermasterProposal(proposal, context, config, now) {
  const input = quartermasterContext(context, config, now);
  requirePolicy(proposal && Object.keys(proposal).length === fields.length &&
    Object.keys(proposal).every(key => fields.includes(key)), 'Unexpected provider fields');
  const row = input.skus.find(row => row.sku === proposal.sku);
  requirePolicy(row && Number.isSafeInteger(proposal.quantity) && proposal.quantity > 0 &&
    proposal.quantity <= config.maxQuantity && proposal.quantity <= Math.max(0, row.target - row.stock),
  'Invalid SKU or quantity');
  const price = quartermasterAtomic(proposal.priceAtomic);
  requirePolicy(price >= BigInt(row.minPriceAtomic) && price <= BigInt(row.maxPriceAtomic), 'Price outside policy band');
  const total = price * BigInt(proposal.quantity);
  requirePolicy(total <= BigInt(input.availableBudgetAtomic), 'Insufficient funded budget');
  requirePolicy(proposal.policyVersion === config.policyVersion && typeof proposal.reason === 'string' &&
    proposal.reason.length > 0 && proposal.reason.length <= 240 && !/[\x00-\x1f]/.test(proposal.reason) &&
    Number.isSafeInteger(proposal.expiresAtMs) && proposal.expiresAtMs > now &&
    proposal.expiresAtMs <= now + config.maxTtlMs, 'Invalid proposal provenance or expiry');
  return { proposal: Object.fromEntries(fields.map(key => [key, proposal[key]])), totalAtomic: String(total), context: input };
}

export function deterministicQuartermasterProposal(context, config, now) {
  const input = quartermasterContext(context, config, now);
  for (const row of [...input.skus].sort((a, b) => a.sku.localeCompare(b.sku))) {
    const quantity = Math.min(config.maxQuantity, Math.max(0, row.target - row.stock),
      Number(BigInt(input.availableBudgetAtomic) / BigInt(row.priceAtomic) > BigInt(config.maxQuantity)
        ? BigInt(config.maxQuantity) : BigInt(input.availableBudgetAtomic) / BigInt(row.priceAtomic)));
    if (quantity > 0) return { sku: row.sku, quantity, priceAtomic: row.priceAtomic,
      reason: 'Stock below registered target', expiresAtMs: now + config.maxTtlMs, policyVersion: config.policyVersion };
  }
  return null;
}
