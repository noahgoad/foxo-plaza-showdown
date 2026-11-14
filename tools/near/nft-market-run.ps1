param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$market=Join-Path $root 'contracts/near-market'
if(-not $SkipBuild){
 $oldFlags=$env:RUSTFLAGS
 try {
  $env:RUSTFLAGS='-C target-cpu=mvp -C target-feature=+sign-ext'
  cargo +nightly build -Z build-std=std,panic_abort --locked --manifest-path (Join-Path $market 'Cargo.toml') --target wasm32-unknown-unknown --release
  if($LASTEXITCODE -ne 0){throw 'Market Wasm build failed'}
  cargo +nightly build -Z build-std=std,panic_abort --locked --manifest-path (Join-Path $root 'contracts/near-fox/Cargo.toml') --target-dir (Join-Path $market 'target/fox-fixture') --target wasm32-unknown-unknown --release
  if($LASTEXITCODE -ne 0){throw 'Fox Sandbox fixture build failed'}
 } finally {$env:RUSTFLAGS=$oldFlags}
}
$marketWasm=Join-Path $market 'target/wasm32-unknown-unknown/release/near_market.wasm'
$ftWasm=Join-Path $root 'contracts/near-economy/sandbox/mock-ft/target/wasm32-unknown-unknown/release/sandbox_mock_ft.wasm'
$foxWasm=Join-Path $market 'target/fox-fixture/wasm32-unknown-unknown/release/near_fox.wasm'
$passportWasm=Join-Path $root 'contracts/near-passport/target/wasm32-unknown-unknown/release/near_passport.wasm'
foreach($file in @($marketWasm,$ftWasm,$foxWasm,$passportWasm)){if(-not (Test-Path -LiteralPath $file)){throw "Missing pinned Sandbox artifact: $file"}}
$test=Join-Path $market 'sandbox/nft-market.test.mjs'
docker run --rm --mount "type=bind,source=$ftWasm,target=/wasm/sandbox_mock_ft.wasm,readonly" --mount "type=bind,source=$foxWasm,target=/wasm/near_fox.wasm,readonly" --mount "type=bind,source=$passportWasm,target=/wasm/near_passport.wasm,readonly" --mount "type=bind,source=$marketWasm,target=/wasm/near_market.wasm,readonly" --mount "type=bind,source=$test,target=/sandbox/nft-market.test.mjs,readonly" fox-economy-sandbox:local node --test /sandbox/nft-market.test.mjs
if($LASTEXITCODE -ne 0){throw 'Market Sandbox tests failed'}
