import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { pilotRecipe } from '../../assets/near-fox/economy-catalogue.js';
import { readEquippedWeaponFinish } from '../../src/ui/near-testnet-assets.js';
import { setChogWeaponTint } from '../../src/game/chog-weapon-models.js';
const account = 'alice.testnet';
const economy = 'economy.testnet';
const item = { itemId: 'alice.testnet:op1', ownerId: account, sku: pilotRecipe.sku,
  recipeId: pilotRecipe.recipeId, recipeVersion: pilotRecipe.version };
test('only a finalized account-owned recipe version supplies the equipped finish', async () => {
  const calls = [];
  let candidate = item;
  let itemBlock = 'final-a';
  const view = async (contract, method, args, options) => {
    calls.push({ contract, method, args, options });
    return method === 'get_equipped' ? { value: item.itemId, blockHash: 'final-a' } :
      { value: candidate, blockHash: itemBlock };
  };
  const read = () => readEquippedWeaponFinish(account, { contractId: economy, view });
  assert.equal(await read(), pilotRecipe.sku);
  assert.equal(calls[1].options.blockId, 'final-a');
  assert.deepEqual(calls[0].args, { account_id: account });
  for (const invalid of [{ ...item, ownerId: 'bob.testnet' }, { ...item, recipeVersion: 2 },
    { ...item, itemId: 'different' }, { ...item, sku: 'made-up' }, null]) {
    candidate = invalid;
    assert.equal(await read(), null);
  }
  candidate = item;
  itemBlock = 'final-b';
  assert.equal(await read(), null);
  assert.equal(await readEquippedWeaponFinish(account, { contractId: null, view: () => assert.fail('no RPC') }), null);
});
test('both weapons use private tinted materials and clearing restores shared originals', () => {
  const texture = new THREE.Texture();
  const original = new THREE.MeshStandardMaterial({ map: texture });
  const geometry = new THREE.BoxGeometry();
  const weapon = () => {
    const chogVisual = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, original);
    chogVisual.add(mesh);
    return { chogVisual, mesh, muzzle: new THREE.Object3D() };
  };
  const gun = weapon();
  gun.left = weapon();
  const unequipped = weapon();
  const muzzle = gun.muzzle.position.clone();
  setChogWeaponTint(gun, pilotRecipe.tint);
  for (const held of [gun, gun.left]) {
    assert.notEqual(held.mesh.material, original);
    assert.equal(held.mesh.material.color.getHex(), pilotRecipe.tint);
    assert.equal(held.mesh.material.map, texture);
    assert.equal(held.mesh.geometry, geometry);
  }
  assert.equal(unequipped.mesh.material, original);
  assert.equal(original.color.getHex(), 0xffffff);
  assert.ok(gun.muzzle.position.equals(muzzle));
  const privateMaterial = gun.mesh.material;
  let disposed = 0;
  privateMaterial.addEventListener('dispose', () => disposed++);
  setChogWeaponTint(gun, pilotRecipe.tint);
  assert.equal(gun.mesh.material, privateMaterial);
  setChogWeaponTint(gun, null);
  assert.equal(gun.mesh.material, original);
  assert.equal(gun.left.mesh.material, original);
  assert.equal(disposed, 1);
});
