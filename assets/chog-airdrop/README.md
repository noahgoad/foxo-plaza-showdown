# Chog supply chest

The supplied Tripo file is preserved in Downloads. `manifest.json` records its SHA-256.

- `chest.glb`: original supplied body, lid, bands, seam, emblem and UVs; only the malformed suspension fittings are replaced by four closed attachment rings. The lid is no longer reconstructed.
- `parachute.glb`: twelve alternating orange/purple fabric sectors with consistent back colors, eight continuous ivory suspension lines. Hide this entire asset on landing.
- `fragments.glb`: twelve pieces clipped from the actual corrected chest, including closed colored cut faces.
- `coin-icon.png`: rendered from the supplied 3D coin, used for its HUD pickup flight.

Prepared by `tools/chog/prepare-airdrop.py`; coin icon by `tools/chog/render-airdrop-coin.py`. Preview renders and authoring blend: `outputs/airdrop-repaired/`. In-game descent, burst and coin previews: `outputs/airdrop-*.png`.

Runtime uses one shared model load per asset and clones geometry/material references where possible. Fracture fading uses temporary cloned materials; coin illumination uses a temporary warm point light. Both are disposed after collection or match exit.
