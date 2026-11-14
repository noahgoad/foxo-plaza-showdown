import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateCatalogue, verifiedCatalogue } from '../../assets/near-fox/catalogue.js';
const root = new URL('../../', import.meta.url);
const catalogue = JSON.parse(await readFile(new URL('assets/near-fox/catalogue.v2.json', root)));
const readAsset = async path => new Uint8Array(await readFile(new URL(path, root)));
const sha256 = async bytes => createHash('sha256').update(bytes).digest('hex');
const verify = value => verifiedCatalogue(value, { readAsset, sha256 });
test('three versioned pilot products preserve exact costs and stay gated', async () => {
  const result = await verify(catalogue);
  assert.equal(result.items.length, 3);
  assert.ok(result.items.every(item => !item.enabled && item.outputCount === 1));
  assert.equal(result.items[2].transferability, 'guild-bound');
  assert.equal(result.items[1].visualKind, 'garment-region-recolor');
});
test('missing assets and changed bytes reject catalogue', async () => {
  await assert.rejects(verifiedCatalogue(catalogue, { readAsset: async () => { throw Error('missing asset'); }, sha256 }), /missing asset/);
  await assert.rejects(verifiedCatalogue(catalogue, { readAsset: async () => new Uint8Array([1]), sha256 }), /hash mismatch/);
});
test('wrong class, price, recipe version and missing hash fail closed', () => {
  for (const patch of [{ class: 'outfit' }, { feeAtomic: '5' }, { recipeVersion: 1 }, { asset: { path: 'x' } }]) {
    const changed = structuredClone(catalogue); Object.assign(changed.items[0], patch);
    assert.throws(() => validateCatalogue(changed));
  }
});
test('unknown SKU, forged enablement and transferable guild output reject', () => {
  for (const patch of [{ sku: 'unknown' }, { enabled: true }, { transferability: 'tradable' }]) {
    const changed = structuredClone(catalogue); Object.assign(changed.items[2], patch);
    assert.throws(() => validateCatalogue(changed));
  }
});
test('legacy recipe remains unchanged', async () => {
  const { pilotRecipe } = await import('../../assets/near-fox/economy-catalogue.js');
  assert.deepEqual(pilotRecipe.inputs, { alloy: 36, core: 1, catalyst: 0 });
  assert.equal(pilotRecipe.version, 1); assert.equal(pilotRecipe.sku, 'fox-finish-violet');
});

const THREE = await import('three');
test('preview materials restore cleanly without mutating shared models', async () => {
  const { applyCosmeticPreview } = await import('../../assets/near-fox/cosmetic-preview.js');
  const original = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const shared = new THREE.Mesh(new THREE.BoxGeometry(), original); const root = new THREE.Group(); root.add(shared);
  const remove = applyCosmeticPreview({ item: catalogue.items[0], descriptor: { kind: 'weapon-material', color: '#69e5d0', roughness: 0.28, metalness: 0.45 }, weaponVisual: root });
  assert.notEqual(shared.material, original); assert.equal(original.color.getHex(), 0xffffff);
  remove(); remove(); assert.equal(shared.material, original);
});
test('garment preview masks source-space region and preserves shader hooks', async () => {
  const { applyCosmeticPreview } = await import('../../assets/near-fox/cosmetic-preview.js');
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); const root = new THREE.Group(); root.add(mesh);
  let called = false; mesh.material.onBeforeCompile = () => { called = true; };
  const descriptor = JSON.parse(await readFile(new URL(catalogue.items[1].asset.path, rootURL())));
  const remove = applyCosmeticPreview({ item: catalogue.items[1], descriptor, foxModel: root });
  const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <color_fragment>' };
  mesh.material.onBeforeCompile(shader, null);
  assert.ok(called); assert.match(shader.vertexShader, /position\.y/); assert.match(shader.fragmentShader, /foxGarmentMask/);
  remove();
});
function rootURL() { return new URL('../../', import.meta.url); }
test('guild preview is a removable display prop with no combat mutation', async () => {
  const { applyCosmeticPreview } = await import('../../assets/near-fox/cosmetic-preview.js');
  const root = new THREE.Group(); const remove = applyCosmeticPreview({ item: catalogue.items[2], descriptor: { kind: 'guild-banner', color: '#72e1ca', background: '#172b40', width: 0.36, height: 0.54 }, bannerMount: root });
  assert.equal(root.children.length, 1); assert.equal(root.children[0].userData.cosmeticOnly, true);
  remove(); assert.equal(root.children.length, 0);
});

test('model IDs, output license and equip scope cannot be relabelled', () => {
  for (const mutate of [
    item => { item.modelCompatibility.ids = ['another-rig']; },
    item => { item.licenseRequirement.equip = 'everyone'; },
    item => { item.licenseRequirement.produce = 'free'; },
  ]) { const changed = structuredClone(catalogue); mutate(changed.items[0]); assert.throws(() => validateCatalogue(changed)); }
});
