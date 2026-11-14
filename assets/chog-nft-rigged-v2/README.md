# Chog NFT rigs with finger articulation

Four fitted NFT models from v1 extended to 62 bones: original 22 bones plus 30 deforming phalanges and 10 fingertip reference bones. Both hands have Thumb/Index/Middle/Ring/Little chains. Original source downloads and assets/chog-nft-rigged-v1 remain unchanged.

Build: run Blender in the game root with --background --python tools/chog/rig-nft-fingers.py . Inputs are the fitted v1 .blend files. The output .blend files preserve editable bones and weights; GLBs include the skin/rest skeleton, with no baked animation clips. Finger animations are supplied by src/game/chog-finger-rig.js.

The builder fits finger paths to mesh cross sections, assigns up to four normalized influences per vertex, smooths over real mesh edges, and synchronizes coincident UV-seam weights. Each of the 30 deforming finger joints has nonzero weighted vertices. Reports list actual weighted vertex counts by joint; fingertip reference bones intentionally do not deform vertices.

Runtime aligns each palm against the gun handle, fits bounded finger hinge angles per weapon and hand, and adds trigger-finger squeeze from each hand's shot clock. The support hand uses the foregrip target. Toggle Nắm ngón theo cán súng in the lab to compare open and closed fingers while the weapon remains visible.

Validation: 4 open/closed comparisons, 16 locomotion poses, 20 firing cases. Evidence is under docs/chog-nft-rig/: finger-proof.json, browser-proof.json, weapon-proof.json, fingers-{id}-{open|closed}.png. Finger-tip target distances in the report measure skeleton contact targets, not a guarantee that every triangle clears the weapon. Skin edge stretch is also recorded; residual web compression and local stretching remain, especially in thick astronaut gloves. Extreme poses may need additional weight painting/corrective shapes; this is a reviewable game rig, not collision-constrained hand simulation.

Preview: http://127.0.0.1:8803/chog-lab/?nft=1462&weapon=twins&v=fingers2 . Change nft to 0697, 1070 or 1055. Hold F or the orange button to fire; charger/spinner fire on release.
