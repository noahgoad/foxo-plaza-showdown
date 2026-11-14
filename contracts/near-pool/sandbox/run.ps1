$ErrorActionPreference = 'Stop'
$crate = Split-Path -Parent $PSScriptRoot
$previousFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = '-C target-cpu=mvp -C target-feature=+sign-ext'
    cargo +nightly build -Z build-std=std,panic_abort --locked --manifest-path (Join-Path $crate 'Cargo.toml') --target wasm32-unknown-unknown --release
    if ($LASTEXITCODE -ne 0) { throw 'Pool Wasm build failed' }
} finally { $env:RUSTFLAGS = $previousFlags }
$wasm = Join-Path $crate 'target/wasm32-unknown-unknown/release/near_pool.wasm'
$mockWasm = Join-Path (Split-Path -Parent $crate) 'near-economy/sandbox/mock-ft/target/wasm32-unknown-unknown/release/sandbox_mock_ft.wasm'
$script = Join-Path $PSScriptRoot 'pool.test.mjs'
docker run --rm --mount "type=bind,source=$wasm,target=/wasm/near_pool.wasm,readonly" --mount "type=bind,source=$mockWasm,target=/wasm/sandbox_mock_ft.wasm,readonly" --mount "type=bind,source=$script,target=/sandbox/pool.test.mjs,readonly" fox-economy-sandbox:local node --test pool.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Pool Sandbox test failed' }
