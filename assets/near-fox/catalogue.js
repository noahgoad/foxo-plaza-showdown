// V2 is deliberately separate from the immutable Violet v1 contract recipe.
const terms = Object.freeze({
  'weapon-finish-aurora-v2': ['aurora-weapon-finish', 'weapon-finish', 'weapon-material', 24, 0, 2, '5000000000000000000000000', 'tradable'],
  'outfit-recolor-tide-v2': ['tide-garment-recolor', 'outfit-recolor', 'garment-region-recolor', 36, 1, 0, '8000000000000000000000000', 'tradable'],
  'guild-banner-beacon-v2': ['guild-beacon-banner', 'guild-banner', 'guild-banner', 48, 2, 2, '15000000000000000000000000', 'guild-bound'],
});
function requireValue(ok, message) { if (!ok) throw new Error('Invalid catalogue: ' + message); }
function assetReference(ref) {
  requireValue(ref && /^assets\/[a-zA-Z0-9_./-]+$/.test(ref.path) && !ref.path.includes('..'), 'asset path');
  requireValue(/^[a-f0-9]{64}$/.test(ref.sha256), 'asset hash');
}
export function validateCatalogue(value) {
  requireValue(value?.schemaVersion === 2 && value.rulesVersion === 'fox-economy-2.1', 'version');
  requireValue(Array.isArray(value.items) && value.items.length === 3, 'three pilot SKUs required');
  const seen = new Set();
  for (const item of value.items) {
    const expected = terms[item.sku];
    requireValue(expected && !seen.has(item.sku), 'unknown or duplicate SKU'); seen.add(item.sku);
    const [recipeId, kind, visualKind, alloy, core, catalyst, fee, transferability] = expected;
    requireValue(item.recipeId === recipeId && item.recipeVersion === 2 && item.class === kind && item.visualKind === visualKind, 'recipe version or class');
    requireValue(item.inputs?.alloy === alloy && item.inputs?.core === core && item.inputs?.catalyst === catalyst && Object.keys(item.inputs).length === 3 && item.feeAtomic === fee, 'recipe inputs or fee');
    requireValue(item.outputCount === 1 && item.transferability === transferability, 'output rights');
    requireValue(item.enabled === false && item.status === 'local-preview-only' && typeof item.disabledReason === 'string' && item.disabledReason.length > 0, 'runtime gate not approved');
    requireValue(item.license?.commercialUseApproved === false && typeof item.license.sourceModels === 'string', 'source-model rights');
    requireValue(typeof item.licenseRequirement?.produce === 'string' && item.licenseRequirement.buyerNeedsProducerLicense === false, 'producer/equip license');
    const producer = kind === 'weapon-finish' ? 'armorer:aurora-v2' : kind === 'outfit-recolor' ? 'stylist:tide-v2' : 'guild:beacon-v2';
    requireValue(item.licenseRequirement.produce === producer && item.licenseRequirement.equip ===
      (kind === 'guild-banner' ? 'active-guild-member' : 'owned-item'), 'producer/equip license');
    requireValue(item.entitlementScope === (kind === 'guild-banner' ? 'active-guild-membership' : 'item-owner'), 'entitlement scope');
    assetReference(item.asset); assetReference(item.preview);
    requireValue(item.modelCompatibility?.ids?.length > 0 && item.modelCompatibility.models?.length > 0 && item.modelCompatibility.preserveRig === true && item.modelCompatibility.preserveHat === true && item.modelCompatibility.preserveCombatGeometry === true, 'model compatibility');
    const modelIds = kind === 'weapon-finish' ? ['shooter','twins','spinner','charger','blaster'] : ['near-fox-garment-v1'];
    requireValue(JSON.stringify(item.modelCompatibility.ids) === JSON.stringify(modelIds), 'model IDs');
    for (const model of item.modelCompatibility.models) assetReference(model);
  }
  return value;
}
// A caller must read and hash actual bytes, including referenced source models.
// Validation itself cannot confer ownership, production license or chain finality.
export async function verifiedCatalogue(value, { readAsset, sha256 }) {
  const snapshot = structuredClone(value);
  validateCatalogue(snapshot);
  const checked = new Map();
  for (const item of snapshot.items) {
    for (const ref of [item.asset, item.preview, ...item.modelCompatibility.models]) {
      if (!checked.has(ref.path)) checked.set(ref.path, await sha256(await readAsset(ref.path)));
      if (checked.get(ref.path) !== ref.sha256) throw new Error('Catalogue asset hash mismatch: ' + ref.path);
    }
  }
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  return freeze(snapshot);
}
export async function loadCatalogue({ fetcher = fetch, cryptoImpl = globalThis.crypto } = {}) {
  const root = new URL('../../', import.meta.url);
  const response = await fetcher(new URL('assets/near-fox/catalogue.v2.json', root));
  if (!response.ok) throw new Error('Catalogue unavailable');
  return verifiedCatalogue(await response.json(), {
    readAsset: async path => { const r = await fetcher(new URL(path, root)); if (!r.ok) throw new Error('Missing catalogue asset: ' + path); return new Uint8Array(await r.arrayBuffer()); },
    sha256: async bytes => [...new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join(''),
  });
}
