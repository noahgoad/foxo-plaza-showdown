import * as THREE from 'three';
// Render-only tools. These never authorize equip, craft, guild membership or sale.
// Call only with an asset descriptor read through verifiedCatalogue/loadCatalogue.
const active = new WeakMap();
function number(value, min, max) { if (!Number.isFinite(value) || value < min || value > max) throw new Error('Invalid cosmetic descriptor'); return value; }
export async function loadGuildAvatarTexture() {
  const texture=await new THREE.TextureLoader().loadAsync(new URL('./pilot-v2/guild-avatar.png',import.meta.url).href);
  texture.colorSpace=THREE.SRGBColorSpace;
  return texture;
}

export function applyCosmeticPreview({ item, descriptor, weaponVisual, foxModel, bannerMount, bannerTexture }) {
  if (!item || descriptor?.kind !== item.visualKind) throw new Error('Cosmetic descriptor/class mismatch');
  const root = item.class === 'weapon-finish' ? weaponVisual : item.class === 'outfit-recolor' ? foxModel : item.class === 'guild-banner' ? bannerMount : null;
  if (!root?.isObject3D) throw new Error('Compatible preview model required');
  if (!/^#[0-9a-f]{6}$/i.test(descriptor.color)) throw new Error('Invalid cosmetic color');
  const color = new THREE.Color(descriptor.color);
  active.get(root)?.();
  const undo = [];
  if (item.class === 'guild-banner') {
    const width = number(descriptor.width, 0.1, 1), height = number(descriptor.height, 0.1, 1);
    const group = new THREE.Group(); group.name = 'guild-beacon-banner-preview'; group.userData.cosmeticOnly = true;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ color: descriptor.background, roughness: 0.9, side: THREE.DoubleSide }));
    cloth.position.set(width / 2, height / 2, 0); group.add(cloth);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, height + 0.15, 6), new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.3 }));
    pole.position.y = (height + 0.15) / 2; group.add(pole);
    const emblem = new THREE.Shape(); emblem.moveTo(0, height * 0.25); emblem.lineTo(width * 0.22, -height * 0.13); emblem.lineTo(0, -height * 0.03); emblem.lineTo(-width * 0.22, -height * 0.13); emblem.closePath();
    const crest = new THREE.Mesh(new THREE.ShapeGeometry(emblem), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    if(bannerTexture){
      crest.geometry.dispose();
      crest.material.dispose();
      const size=width*0.9;
      const avatar=new THREE.Mesh(new THREE.PlaneGeometry(size,size),
        new THREE.MeshBasicMaterial({map:bannerTexture,side:THREE.DoubleSide,toneMapped:false}));
      avatar.position.set(width/2,height*0.55,0.001);
      group.add(avatar);
    }else{
      crest.position.set(width / 2, height * 0.55, 0.001); group.add(crest);
    }
    root.add(group);
    undo.push(() => { root.remove(group); group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); });
  } else {
    const isRecolor = item.class === 'outfit-recolor';
    if (isRecolor && (!Array.isArray(descriptor.localY) || !Array.isArray(descriptor.localZ))) throw new Error('Garment mask missing');
    const bounds = isRecolor ? [...descriptor.localY, ...descriptor.localZ].map(n => number(n, -1, 1)) : [];
    const glslBounds = bounds.map(n => n.toFixed(5));
    if (isRecolor && (bounds.length !== 4 || bounds[0] >= bounds[1] || bounds[2] >= bounds[3])) throw new Error('Garment mask invalid');
    root.traverse(mesh => {
      if (!mesh.isMesh) return;
      const original = mesh.material;
      const copies = (Array.isArray(original) ? original : [original]).map(source => {
        const clone = source.clone();
        if (isRecolor) {
          const strength = number(descriptor.strength, 0, 1), priorHook = source.onBeforeCompile;
          const hueMin = number(descriptor.sourceColorGate?.yellowHueMin, 0, 1), hueFull = number(descriptor.sourceColorGate?.yellowHueFull, 0, 1), chromaMin = number(descriptor.sourceColorGate?.chromaMin, 0, 1);
          if (hueMin >= hueFull) throw new Error("Invalid garment hue gate");
          // Source-space mask follows the existing skin; no position, bones, UV,
          // muzzle, hitbox or timing change. Hat/face lie above the mask; source-color gating excludes fur and gloves.
          clone.onBeforeCompile = (shader, renderer) => {
            priorHook?.call(clone, shader, renderer);
            shader.uniforms.foxGarmentColor = { value: color };
            shader.vertexShader = 'varying float foxGarmentMask;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nfoxGarmentMask = step(' + glslBounds[0] + ', position.y) * step(position.y, ' + glslBounds[1] + ') * step(' + glslBounds[2] + ', position.z) * step(position.z, ' + glslBounds[3] + ');');
            shader.fragmentShader = 'varying float foxGarmentMask;\nuniform vec3 foxGarmentColor;\n' + shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nvec3 foxSourceColor = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));\nfloat foxYellowRatio = (foxSourceColor.g - foxSourceColor.b) / max(0.001, foxSourceColor.r - foxSourceColor.b);\nfloat foxFabric = smoothstep(' + hueMin.toFixed(4) + ', ' + hueFull.toFixed(4) + ', foxYellowRatio) * step(' + chromaMin.toFixed(4) + ', foxSourceColor.r - foxSourceColor.b);\nfloat foxFabricLight = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\ndiffuseColor.rgb = mix(diffuseColor.rgb, foxGarmentColor * foxFabricLight * 1.4, foxGarmentMask * foxFabric * ' + strength.toFixed(4) + ');');
          };
          clone.customProgramCacheKey = () => source.customProgramCacheKey() + ':fox-garment-mask-v2:' + bounds.join(',') + ':' + strength + ':' + hueMin + ':' + hueFull + ':' + chromaMin;
        } else {
          clone.color?.copy(color); clone.roughness = number(descriptor.roughness, 0, 1); clone.metalness = number(descriptor.metalness, 0, 1);
          clone.onBeforeCompile = source.onBeforeCompile; clone.customProgramCacheKey = source.customProgramCacheKey.bind(source);
        }
        return clone;
      });
      const applied = Array.isArray(original) ? copies : copies[0]; mesh.material = applied;
      undo.push(() => { if (mesh.material === applied) mesh.material = original; copies.forEach(m => m.dispose()); });
    });
  }
  let removed = false;
  const remove = () => { if (removed) return; removed = true; undo.reverse().forEach(fn => fn()); if (active.get(root) === remove) active.delete(root); };
  active.set(root, remove); return remove;
}
