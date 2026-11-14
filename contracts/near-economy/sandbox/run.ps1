$ErrorActionPreference = 'Stop'
$sandbox = $PSScriptRoot
$economy = Split-Path -Parent $sandbox
$mock = Join-Path $sandbox 'mock-ft'
$previousFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = '-C target-cpu=mvp -C target-feature=+sign-ext'
    foreach ($crate in @($economy, $mock)) {
        cargo +nightly build -Z build-std=std,panic_abort --locked --manifest-path (Join-Path $crate 'Cargo.toml') --target wasm32-unknown-unknown --release
        if ($LASTEXITCODE -ne 0) { throw "Wasm build failed for $crate" }
    }
} finally {
    $env:RUSTFLAGS = $previousFlags
}
$economyWasm = Join-Path $economy 'target/wasm32-unknown-unknown/release/near_economy.wasm'
$mockWasm = Join-Path $mock 'target/wasm32-unknown-unknown/release/sandbox_mock_ft.wasm'
docker build -t fox-economy-sandbox:local $sandbox
if ($LASTEXITCODE -ne 0) { throw 'Sandbox Docker image build failed' }
docker run --rm --mount "type=bind,source=$economyWasm,target=/wasm/near_economy.wasm,readonly" --mount "type=bind,source=$mockWasm,target=/wasm/sandbox_mock_ft.wasm,readonly" fox-economy-sandbox:local
if ($LASTEXITCODE -ne 0) { throw 'Sandbox tests failed' }
