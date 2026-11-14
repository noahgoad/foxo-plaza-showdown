import { accountId, atomic } from './schema.js';

export function recipeQuote(recipe, expected) {
  if (!recipe || recipe.recipeId !== expected.recipeId || recipe.version !== expected.version ||
      recipe.sku !== expected.sku || !['alloy', 'core', 'catalyst'].every(key =>
        Number.isSafeInteger(recipe.inputs?.[key]) && recipe.inputs[key] >= 0)) {
    throw new Error('Crafting recipe changed. Refresh the Workshop.');
  }
  if (atomic(recipe.feeAtomic) === 0n) throw new Error('Crafting price is unavailable.');
  return recipe;
}

export function craftTransfer({ token, economy, account, recipe, operationId }) {
  accountId(account);
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(operationId)) throw new Error('Invalid craft operation.');
  atomic(recipe.feeAtomic);
  return {
    receiverId: accountId(token),
    itemId: account + ':' + operationId,
    args: {
      receiver_id: accountId(economy), amount: recipe.feeAtomic,
      msg: JSON.stringify({ action: 'craft', operationId, recipeId: recipe.recipeId, recipeVersion: recipe.version }),
    },
  };
}

export function craftMatches(item, { itemId, account, recipe }) {
  return item?.itemId === itemId && item.ownerId === account && item.sku === recipe.sku &&
    item.recipeId === recipe.recipeId && item.recipeVersion === recipe.version;
}
