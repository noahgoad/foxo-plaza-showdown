# Imported Chog weapons

Source originals: C:/Users/XuanCanh/Downloads/asset3D/weapon (untouched). Build with Blender tools/chog/prepare-weapons.py. Grip origin is zero, forward +Z, up +Y; source tilt is removed. Textures preserved; game variants use approximately 18,000 triangles each. manifest.json records source SHA256, size, grip-relative muzzle ports and support point.

Mapping: futuristic_ray_gun -> Rascal (shooter); toy_ray_gun -> both Double Trouble pistols (twins), also Party Crasher (blaster) at a larger scale; colorful_gun -> Whirlwind (spinner); stylized_sniper_rifle -> Longshot (charger). Four source models, five game profiles.

Character weapon instances keep the existing controller, weapon runner, recoil and projectiles. Imported visuals replace procedural shells at both LODs. Double Trouble now uses two full instances with separate left/right muzzle transforms. The spinner stays rigid as requested; fireStream selects ports 0,1,2,0,1,2 per emitted round, including muzzle effects. Muzzle reading is side-effect free; aiming/laser inspection does not advance the port. Existing damage, cadence, charge and planted twin speed are retained.

SuppliedChog relocates each gun to its corresponding imported wrist, restores its local driver pose before the next animation update, and fits the support arm to grip-relative support targets for two-handed weapons. NFT v2 rigs now have independent finger joints; NativeFingerRig aligns palms and curls fingers around the handles. Older base/v1 rigs retain their original hand silhouette.

Lab: /chog-lab/?nft=1462&weapon=twins . Select any weapon, hold F or hold the orange button. Charger and spinner require hold/release. This lab uses the actual WeaponRunner and Projectiles with no collision targets; it verifies firing and visuals, not multiplayer or live hit registration.

Verification: tools/chog/weapon-browser-test.cjs runs all five profiles for all four NFTs, checking actual shot emission, both twin hands and spinner port ordering. Evidence: docs/chog-nft-rig/weapon-proof.json and weapon-{nft}-{kind}.png.
