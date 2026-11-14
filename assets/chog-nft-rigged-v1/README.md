# Four Chog Genesis models bound to the existing Chog rig

Source: C:/Users/XuanCanh/Downloads/asset3D/character. All four sources are genuine meshopt-compressed GLBs with no skins. Original files remain unchanged.

Outputs: chog-1462-rigged.glb, chog-0697-rigged.glb, chog-1070-rigged.glb, chog-1055-rigged.glb. Matching .blend files preserve editable authoring scenes. These assets contain skinning and the rest rig; runtime locomotion is supplied by the game's existing SuppliedChog adapter, not baked animation clips.

Rig source: assets/chog-base-v2/chog-base-rig.blend. The 22-bone names and hierarchy are preserved. Arm rest pivots are now fitted to each source mesh; rest positions therefore differ from the base rig. Models are normalized to height 1.48 with feet at zero. Render topology is unchanged. Bone heat is solved on a voxel proxy; up to four normalized influences are transferred to the original render mesh. The upper head is rigidly assigned to Head, keeping hat, glasses, hood and facial features together. There are no independent finger bones or facial controls in this existing rig.

Per-model reports and manifest.json record source hashes, counts, influence limits and weight-sum validation. All four have zero unweighted vertices. This is automatic skin binding with visual locomotion inspection, not hand-painted film-quality deformation or exhaustive testing of every possible pose.

Preview URLs (local server 8803):

- /chog-lab/?nft=1462
- /chog-lab/?nft=0697
- /chog-lab/?nft=1070
- /chog-lab/?nft=1055

Use WASD, Shift, Space; toggle Xem bộ xương for the imported skeleton. Existing game characters were not replaced by this task.

Rebuild with Blender background script tools/chog/rig-nft-characters.py. Browser locomotion audit: tools/chog/nft-rig-browser-test.cjs through the Playwright runner. Proof screenshots and runtime numeric results: docs/chog-nft-rig/.


Arm/leg correction: isolate weights by side and limb, with smooth elbow/wrist/knee/ankle transitions and rigid shoe regions. Runtime limb directions now follow the original character controller instead of treating its gun-holding idle as the neutral limb pose. Hands follow controller wrist orientation; the weapon keeps its original aim but is relocated to the imported right wrist, with its local transform restored before each controller update to prevent drift. Gun is enabled by default in the NFT lab.

Verified on four models at idle/walk/run/jump (16 snapshots): 22 bones, finite skinned vertices, bounded mesh height, visible weapon and wrist-to-weapon distance below 0.25. This does not provide articulated trigger fingers: the shared rig has no finger bones.


Gun-arm repair (2026-10-20): after running rig-nft-characters.py, run fit-nft-arm-pivots.py in Blender. The second step fits shoulder/elbow/wrist forward and lateral centres to mesh cross sections, and puts wrist height at 0.65 instead of inside the palm at 0.62. Source topology and original downloaded GLBs are preserved. Reports set exactRestRigPreserved=false for these fitted variants.

Runtime now maps full driver limb frames including twist. Imported open hands follow the forearm frame instead of inheriting the original character's power-grip wrist twist. Finger articulation is still absent. Regression audit measures arm edge stretch and rigid palm shape (2% tolerance accommodates the controller's whole-body squash), in addition to the existing pose/weapon checks.
