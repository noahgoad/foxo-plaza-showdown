export const pilotRecipe = Object.freeze({
  recipeId: 'violet-fox-finish',
  version: 1,
  label: 'Violet Fox Finish',
  sku: 'fox-finish-violet',
  inputs: Object.freeze({ alloy: 36, core: 1, catalyst: 0 }),
  feeAtomic: '8000000000000000000000000',
  tint: 0xd6b9ff,
});

export function onchainPilotRecipe() {
  const { recipeId, version, sku, inputs, feeAtomic } = pilotRecipe;
  return { recipeId, version, sku, inputs, feeAtomic };
}
