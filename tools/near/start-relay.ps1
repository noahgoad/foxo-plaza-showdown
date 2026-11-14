param([int]$Port = 8818, [switch]$SocialPilot, [switch]$QuartermasterPilot, [ValidateRange(1,9999)][int]$QuartermasterRound = 1, [switch]$GasSponsorPilot,
    [string[]]$PublicGameOrigin)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$configuration = Join-Path $project 'config/economy.testnet.json'
$setupFile = Join-Path $project 'contracts/near-fox/mint-console/backend-setup.json'
$configurationValue = Get-Content -LiteralPath $configuration -Raw | ConvertFrom-Json
$setupValue = Get-Content -LiteralPath $setupFile -Raw | ConvertFrom-Json
$env:NEAR_RELAY_PORT = [string]$Port
$env:NEAR_AUTHORITATIVE_RESULTS = '1'
$env:CHOG_SIM_CPU_ONLY = '1'
$env:NEAR_GAME_URL = 'http://127.0.0.1:8817/dist/'
$env:NEAR_GAME_ORIGINS = 'http://127.0.0.1:8817,http://localhost:8817'
foreach ($publicOrigin in $PublicGameOrigin) {
    $origin = [uri]$publicOrigin
    if ($origin.Scheme -ne 'https' -or $origin.GetLeftPart([UriPartial]::Authority) -ne $publicOrigin) {
        throw 'Provide the HTTPS game origin without a path.'
    }
    $env:NEAR_GAME_ORIGINS += ",$publicOrigin"
}
if ($SocialPilot -and !$env:NEAR_SOCIAL_ORIGINS -and !$env:NEAR_SOCIAL_CLIENT_ID) {
    $env:NEAR_SOCIAL_ORIGINS = 'http://localhost:3000'
}
if ($GasSponsorPilot) {
    $env:NEAR_GAS_SPONSOR_ACCOUNT = 'sponsor.xuancanh1.testnet'
    $env:NEAR_GAS_SPONSOR_KEY_FILE = Join-Path $project 'outputs/near-secrets/sponsor.key'
    $env:NEAR_GAS_SPONSOR_BUDGET_ATOMIC = '100000000000000000000000'
}
if ($QuartermasterPilot) {
    $env:NEAR_QUARTERMASTER_KEY_FILE = Join-Path $project 'outputs/near-secrets/quartermaster.key'
    $env:NEAR_QUARTERMASTER_ROUND = [string]$QuartermasterRound
}
$env:NEAR_ECONOMY_CONTRACT = 'economy.xuancanh1.testnet'
$env:NEAR_TOKEN_CONTRACT = $configurationValue.contracts.token
if (!$env:NEAR_INDEX_START_HEIGHT) {
    # Finalized checkpoint before the Economy deployment.
    $env:NEAR_INDEX_START_HEIGHT = '277381420'
}
$env:NEAR_PASSPORT_CONTRACT = 'passport.xuancanh1.testnet'
$env:NEAR_SETTLEMENT_SIGNER = $setupValue.signers.settler.accountId
$env:NEAR_SETTLEMENT_KEY_FILE = Join-Path $project 'outputs/near-secrets/settler.key'
$env:NEAR_CAREER_SIGNER = $setupValue.signers.career.accountId
$env:NEAR_CAREER_KEY_FILE = Join-Path $project 'outputs/near-secrets/career.key'
$env:NEAR_CAREER_STORAGE_DEPOSIT = '20000000000000000000000'
if ($configurationValue.features.nearRewards) {
    $pilotFile = Join-Path $project 'config/pilot.testnet.json'
    $pilot = Get-Content -LiteralPath $pilotFile -Raw | ConvertFrom-Json
    $env:NEAR_FIXED_CAMPAIGN = $pilot.campaignId
    $env:NEAR_SEASON_START_MS = [string]$pilot.seasonStartMs
}
foreach ($path in @($env:NEAR_SETTLEMENT_KEY_FILE, $env:NEAR_CAREER_KEY_FILE)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'The local relay signer key is missing.'
    }
}
Push-Location -LiteralPath $project
try {
    node server/near-relay.mjs
    if ($LASTEXITCODE -ne 0) { throw 'NEAR relay exited with an error.' }
} finally {
    Pop-Location
}
