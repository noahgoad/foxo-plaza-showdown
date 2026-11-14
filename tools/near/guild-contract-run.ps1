param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$guild=Join-Path $root 'contracts/near-guild'
$economy=Join-Path $root 'contracts/near-economy'
$guildWasm=Join-Path $guild 'target/wasm32-unknown-unknown/release/near_guild.wasm'
$economyWasm=Join-Path $economy 'target/wasm32-unknown-unknown/release/near_economy.wasm'
$mockWasm=Join-Path $economy 'sandbox/mock-ft/target/wasm32-unknown-unknown/release/sandbox_mock_ft.wasm'
if(-not $SkipBuild){
 $oldFlags=$env:RUSTFLAGS
 try {
  $env:RUSTFLAGS='-C target-cpu=mvp -C target-feature=+sign-ext'
  cargo +nightly build -Z build-std=std,panic_abort --locked --manifest-path (Join-Path $guild 'Cargo.toml') --target wasm32-unknown-unknown --release
  if($LASTEXITCODE -ne 0){throw 'Guild Wasm build failed'}
 } finally {$env:RUSTFLAGS=$oldFlags}
}
foreach($file in @($guildWasm,$economyWasm,$mockWasm)){if(-not (Test-Path -LiteralPath $file)){throw "Missing pinned Sandbox artifact: $file. Build existing economy Sandbox fixtures first."}}
$test=Join-Path $root 'contracts/near-guild/sandbox/guild.test.mjs'
docker run --rm --mount "type=bind,source=$economyWasm,target=/wasm/near_economy.wasm,readonly" --mount "type=bind,source=$mockWasm,target=/wasm/sandbox_mock_ft.wasm,readonly" --mount "type=bind,source=$guildWasm,target=/wasm/near_guild.wasm,readonly" --mount "type=bind,source=$test,target=/sandbox/guild.test.mjs,readonly" fox-economy-sandbox:local node --test /sandbox/guild.test.mjs
if($LASTEXITCODE -ne 0){throw 'Guild Sandbox tests failed'}

