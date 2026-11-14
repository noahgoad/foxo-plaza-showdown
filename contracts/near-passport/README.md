# NEAR Fox career registry

This contract records server-attested career history against a configured NFT collection and token ID. The collection contract supplies NFT ownership. This registry stores the actor credited for each result and does not infer that actor is the current NFT owner. Account rewards and recipe licenses remain outside this registry.

## Calls

- `new({owner_id, collection_id, network, career_signer_id})` initializes an account controlled by itself or its direct parent operator. Append starts disabled.
- Owner calls `set_append_enabled({enabled})` and `set_career_signer({career_signer_id})`.
- Signer calls payable `append_career({record})`. Both transaction signer and predecessor must equal the configured signer. Attach enough NEAR to cover the actual increase in storage. Excess is refunded. The Sandbox fixture attaches 0.1 NEAR per record. Use a reviewed deployment-specific allowance for operation.
- Read `get_config({})`, `get_record({event_id})`, `get_correction({event_id})`, `get_career({collection_id,token_id})`, and `get_history({collection_id,token_id,offset,limit})`. History is append order, with at most 50 records per call. Summary returns `revision`, `matches`, `wins`, `bossWins`, `xp`.

## Record format

```json
{
  "version": 1,
  "network": "near-testnet",
  "contractId": "passport.operator.testnet",
  "collectionId": "fox.operator.testnet",
  "tokenId": "045",
  "eventId": "career:match-1:actor-1",
  "source": "authoritative",
  "sourceId": "match-1:actor-1",
  "actorId": "actor.testnet",
  "matchId": "match-1",
  "rulesVersion": "pilot-1",
  "resultHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "finishedAtMs": 1794450000000,
  "mode": "boss",
  "won": true,
  "xp": 100,
  "provenanceHash": null,
  "correctsEventId": null,
  "correctionReason": null,
  "traitManifestHash": null
}
```

Modes are `hunt`, `boss`, `control`, `trials`. Optional `traitManifestHash` binds the record to a content manifest when supplied. `legacy_migration` requires `provenanceHash` naming the source snapshot. `correction` requires a target event, evidence hash and reason. It replaces the target's contribution to the summary while preserving the target record and appending the correction. Corrections must follow the latest record for that token, actor and match.

Exact event retries return false. An event ID with changed content, a reused source/source ID, or a repeated token/actor/match under a fresh event ID is rejected. Events with an earlier finish time append successfully without overwriting later history. Pausing prevents new records while reads and exact retry acknowledgements remain available.

The contract emits `fox_passport` version `1.0.0` events named `career_appended`. The record and summary are committed in the same receipt.

## Verification

Run from the project root.

```powershell
cargo test --release --locked --manifest-path contracts/near-passport/Cargo.toml --lib
powershell -NoProfile -ExecutionPolicy Bypass -File contracts/near-passport/sandbox/run.ps1
```

The Sandbox runner uses the `fox-economy-sandbox:local` image built by `contracts/near-economy/sandbox/run.ps1`. It rebuilds this registry with the installed nightly toolchain and MVP-compatible standard library. The image pins Node and near-workspaces through the economy Sandbox lockfile. Native debug tests currently hit the Windows GNU undefined NEAR host-symbol linker failure. Release validation tests and Docker Sandbox execute successfully.
