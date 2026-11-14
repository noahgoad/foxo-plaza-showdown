$ErrorActionPreference = 'Stop'
$crate = Split-Path -Parent $PSScriptRoot
$previousFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = '-C target-cpu=mvp -C target-feature=+sign-ext'
    cargo +nightly build -Z build-std=std,panic_abort --locked --manifest-path (Join-Path $crate 'Cargo.toml') --target wasm32-unknown-unknown --release
    if ($LASTEXITCODE -ne 0) { throw 'Passport Wasm build failed' }
} finally {
    $env:RUSTFLAGS = $previousFlags
}
$wasm = Join-Path $crate 'target/wasm32-unknown-unknown/release/near_passport.wasm'
$script = Join-Path $PSScriptRoot 'passport.test.mjs'
docker run --rm --mount "type=bind,source=$wasm,target=/wasm/near_passport.wasm,readonly" --mount "type=bind,source=$script,target=/sandbox/passport.test.mjs,readonly" fox-economy-sandbox:local node --test passport.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Passport Sandbox test failed' }
