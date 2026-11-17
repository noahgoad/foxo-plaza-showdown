import { accountId, atomic, FOXO_SCALE, MAX_ATOMIC } from './schema.js';

export const MATERIAL_ORDER_PRODUCTS = Object.freeze(['alloy', 'core', 'catalyst'].map(recipeId =>
  Object.freeze({ recipeId, version: 0, label: recipeId[0].toUpperCase() + recipeId.slice(1) })));

export function orderFillQuote(unitPrice, feeBps) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new Error('Invalid marketplace fee');
  const gross = atomic(unitPrice);
  const fee = gross * BigInt(feeBps) / 10000n;
  return { grossAtomic: gross.toString(), feeAtomic: fee.toString(), netAtomic: (gross - fee).toString() };
}

export function orderPriceAtomic(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,38})(?:\.\d{1,24})?$/.test(value)) {
    throw new Error('Enter a FOXO price with up to 24 decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * FOXO_SCALE + BigInt(fraction.padEnd(24, '0'));
  if (amount === 0n || amount > MAX_ATOMIC) throw new Error('Price is outside the supported range.');
  return amount;
}

export function fundOrderDraft({ token, economy, buyer, operationId, recipe, quantity, price, expiresAtMs }) {
  accountId(buyer);
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(operationId)) throw new Error('Invalid order operation.');
  if (!/^[a-zA-Z0-9_./:-]{1,48}$/.test(recipe?.recipeId || '') ||
      !Number.isSafeInteger(recipe.version) || recipe.version < 0 || recipe.version > 0xffffffff ||
      (recipe.version === 0 && !MATERIAL_ORDER_PRODUCTS.some(product => product.recipeId === recipe.recipeId))) {
    throw new Error('Choose a published recipe.');
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('Enter a quantity from 1 to 100.');
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) throw new Error('Invalid order deadline.');
  const unitPrice = orderPriceAtomic(price).toString();
  const amount = (atomic(unitPrice) * BigInt(quantity)).toString();
  atomic(amount);
  return {
    id: buyer + ':' + operationId, buyer, receiverId: accountId(token),
    args: {
      receiver_id: accountId(economy), amount,
      msg: JSON.stringify({ action: 'fund_order', operationId, recipeId: recipe.recipeId,
        recipeVersion: recipe.version, quantity, unitPrice, expiresAtMs }),
    },
  };
}

export function orderMatches(order, draft) {
  const expected = JSON.parse(draft.args.msg);
  return order?.buyerId === draft.buyer && order.recipeId === expected.recipeId &&
    order.recipeVersion === expected.recipeVersion && order.unitPrice === expected.unitPrice &&
    order.expiresAtMs === expected.expiresAtMs && Number.isInteger(order.remaining) &&
    order.remaining >= 0 && order.remaining <= expected.quantity;
}

export function matchingOrderItems(items, order, account) {
  if (!order || order.buyerId === account) return [];
  return items.filter(item => item.ownerId === account && item.recipeId === order.recipeId &&
    item.recipeVersion === order.recipeVersion);
}
