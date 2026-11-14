# Pilot v2 asset provenance

## Existing source models

- Fox: `assets/near-fox/fox-garment.glb`, derived from the user-supplied binary FBX with a `.glb` extension. `tools/chog/convert-near-fox.py` converts it; `tools/chog/repair-fox-garment.py` preserves the original mesh/texture and repairs garment skin weights. See `docs/near-fox-preview.md`. No separate Fox model license grant was located in the repository.
- Imported weapons: preserve `assets/chog-weapons-v1/README.md` and `manifest.json`. Original files remain in `C:/Users/XuanCanh/Downloads/asset3D/weapon`.
- Original local metadata credits `tyifefnog3946` for futuristic ray gun, toy ray gun and stylized sniper rifle; `shikhanh3` for colorful gun. The four `_meta.json` files have title/caption/author and temporary asset links, but no license/rights grant field. Temporary signed URLs are deliberately not copied here.
- The repository software MIT notice in `LICENSE` is preserved. It is not treated as evidence that those supplied model copyrights or commercial redistribution rights were granted.

## New preview content

The JSON material recipes, SVG design swatches, renderer helper and simple geometric guild banner are authored in this implementation. They do not copy another catalogue's art. The weapon finish reuses existing gun geometry/maps; the outfit is a hue-gated recolor of the existing yellow shirt, with no new clothing geometry. The banner is a plain stand, cloth plane and original chevron crest.

All three SKUs remain disabled. Catalogue `commercialUseApproved=false` records the unresolved source-model grant rather than inventing permission. No source assets, credits or existing notices were removed.
