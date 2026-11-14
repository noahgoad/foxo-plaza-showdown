# Isolated guild escrow (T14)

Separate guild contract state and an economy `guild_projects.rs` adapter; near-sdk pinned to 5.17.2 with legacy collections. The immutable `economy_mt` initializer parameter is the only accepted NEP-245 source. Deployment tooling must verify that account's deployed code/config; the contract trusts the configured address and cannot independently authenticate upgrades there.

## Implemented

- Fixed experimental `guild-banner-v1`: exactly 48 Alloy + 2 Core + 2 Catalyst. Immutable project/guild/domain/target/deadline/refund terms hash, checked on contribution.
- NEP-245 receiver matches sender and all previous owners. Accepts active members' three supported materials only. Unique operation replay returns every newly transferred token, never credits twice.
- Escrow retained until all targets funded and the project creator has escrowed exactly 15 FOXO. Commit forwards the fee into an allowlisted economy receiver, which atomically burns 48/2/2 from the guild account, records crafting revenue, and stores an immutable project/terms receipt. Guild output activates only after querying that matching canonical receipt. No partial consumption, transfer, sale, treasury withdrawal, or administration asset-withdrawal method.
- Fee transfers that are fully returned restore `open`/`held` and permit retry. Ambiguous transfer/callback outcomes remain `committing`, with a permissionless canonical-receipt reconciliation call; they cannot be blindly refunded, retried or disbanded. Cancelled projects have independent callback-safe 15 FOXO refunds to the immutable fee payer.
- Active members may display committed output; leaving stops future display, preserving contributions. Disband archives completed output and cancels open projects. Historical reads persist.
- Cancellation/permissionless expiry permit permissionless refund requests to the immutable contributor. A pending transfer retains liability. Private attempt-bound callbacks restore escrow on failure and mark refunded only on success. Stale/replayed callbacks cannot affect later attempts. No timeout heuristic can double-refund.
- Immutable distinct governor set (2–16), threshold >=2. Each governor must consent by joining. Leader/treasurer change requires distinct currently active governors; execution advances epoch, invalidating stale proposals. No one-person bypass.
- Storage must be explicitly prepaid using `fund_storage` by each mutating account/contributor. Actual newly allocated bytes are charged; native storage deposits are currently nonrefundable. There is no storage-credit withdrawal. Per-guild project limit 64; per-project contribution limit 128; identifiers and payloads bounded.

## Verification

From project root (GNU toolchain requires `C:\msys64\mingw64\bin` on PATH):

```powershell
cargo test --manifest-path contracts/near-guild/Cargo.toml --locked
powershell -File tools/near/guild-contract-run.ps1
```

Sandbox runner uses the existing local `fox-economy-sandbox:local` image (near-workspaces 5.0.0 / near-sandbox 0.1.1) and existing economy/mock-FT Wasm artifacts. It compiles the guild using the same nightly/MVP/sign-ext build contract as the economy harness. The real MT fixture uses four consenting contributors, each within existing daily grant caps. No live RPC, wallet, or signing occurs.

## Enable gates / remaining integration

Do not enable production/Testnet user spending from local/Sandbox tests alone. Manual deployment and integration gates remain.

1. Deploy/init must bind both economy MT and FOXO FT contract IDs to independently verified deployed code. Economy owner must explicitly allowlist this deployed guild contract with `configure_guild_contract` and prepay receipt storage. FOXO FT storage registration for guild/economy and MT registration for guild/contributors must be explicit.
2. Canonical economy receipt binds guild/project/terms/fee/fixed inputs. After an unknown callback, `reconcile_commit` reads it; absent proof alone cannot release an unknown FT debit. An unresolved failed FT resolver therefore stays pending until receipt and transfer outcome can be reconciled.
3. Output is an internal nontransferable entitlement; catalogue asset/hash/preview and gameplay display calls are not wired by this crate.
4. This contract is not wired to the local SQLite guild implementation or routes. Initialization, user storage payment UI, storage-refund policy, deployment manifest, indexer ingestion/reconciliation, governance UX, and Testnet receipts remain integration work.
5. A receipt whose callback cannot execute remains pending; no blind timeout unlock exists. Operator reconciliation is required to determine actual outcome safely. No principal is erased by a failed MT transfer.
6. Native one-yocto deposits needed for forwarding/refund calls come from the contract's operating balance, never from material principal. No automatic funding is performed.

Deadline is a chain block timestamp in nanoseconds, not server milliseconds. Calls must preserve integer precision. Roles currently permit all active guild members to display this fixed banner; custom per-SKU role policies require a future version.
