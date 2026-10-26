# ============================================================
#  PlaceMill Build & Package Script
#  Usage: .\build.ps1 [-Dev] [-Clean] [-SkipFrontend] [-Target <target>]
# ============================================================
param(
    [switch]$Dev,
    [switch]$Clean,
    [switch]$SkipFrontend,
    [ValidateSet("msi", "nsis", "all")]
    [string]$Target = "nsis"
)

# Force UTF-8 output to avoid garbled text
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$AppName = "placemill"
$DistDir = Join-Path $ScriptDir "dist"
$TargetDir = Join-Path $ScriptDir "src-tauri\target"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  PlaceMill Build Script" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ---- Check environment ----
Write-Host "[1/4] Checking environment..." -ForegroundColor Yellow

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js not found. Please install https://nodejs.org"
    exit 1
}
Write-Host "  Node.js: $(node -v)" -ForegroundColor Green

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    Write-Error "Rust/Cargo not found. Please install https://rustup.rs"
    exit 1
}
Write-Host "  Cargo:   $(cargo -V)" -ForegroundColor Green

# G-06: without a signing key the bundles still build, but the auto-updater
# rejects them (no .sig sidecar). Say so up front instead of at upload time.
if ($env:TAURI_SIGNING_PRIVATE_KEY -or $env:TAURI_SIGNING_PRIVATE_KEY_PATH) {
    Write-Host "  Signing: update bundles will be signed" -ForegroundColor Green
} else {
    Write-Host "  Signing: OFF - set TAURI_SIGNING_PRIVATE_KEY_PATH to enable auto-updates" -ForegroundColor Yellow
}

# ---- Clean ----
if ($Clean) {
    Write-Host ""
    Write-Host "[ Clean ] Removing old build artifacts..." -ForegroundColor Yellow
    if (Test-Path $DistDir) {
        Remove-Item -Recurse -Force $DistDir
        Write-Host "  Deleted dist/" -ForegroundColor Gray
    }
    if (Test-Path $TargetDir) {
        $releaseDir = Join-Path $TargetDir "release"
        if (Test-Path $releaseDir) {
            Remove-Item -Recurse -Force $releaseDir
            Write-Host "  Deleted target/release/" -ForegroundColor Gray
        }
    }
    Write-Host "  Clean done" -ForegroundColor Green
}

# ---- Install dependencies ----
Write-Host ""
Write-Host "[2/4] Checking dependencies..." -ForegroundColor Yellow

if (-not (Test-Path (Join-Path $ScriptDir "node_modules"))) {
    Write-Host "  Installing npm dependencies..." -ForegroundColor Gray
    npm install
}

# ---- Build frontend ----
if (-not $SkipFrontend) {
    Write-Host ""
    Write-Host "[3/4] Building frontend (Vite)..." -ForegroundColor Yellow

    # R-36: type-check before bundling. `vite build` transpiles each file on its
    # own and strips types, so a `.tsx` that does not compile still ships — the
    # release path used to be the one place a type error could reach users.
    Write-Host "  Running tsc --noEmit..." -ForegroundColor Gray
    npx tsc --noEmit
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Frontend type-check failed"
        exit 1
    }

    Write-Host "  Running vite build..." -ForegroundColor Gray
    npx vite build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Frontend build failed"
        exit 1
    }
    Write-Host "  Frontend build done" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[3/4] Skipping frontend build (--SkipFrontend)" -ForegroundColor Yellow
}

# ---- Build Rust / Package ----
Write-Host ""
Write-Host "[4/4] Building Rust backend & packaging..." -ForegroundColor Yellow

Push-Location (Join-Path $ScriptDir "src-tauri")

if ($Dev) {
    Write-Host "  Mode: Debug" -ForegroundColor Gray
    Write-Host "  Running cargo build..." -ForegroundColor Gray
    cargo build
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Error "Rust build failed"
        exit 1
    }
    Write-Host "  Debug build done!" -ForegroundColor Green
    Write-Host "  Output: src-tauri/target/debug/$AppName.exe" -ForegroundColor Cyan
} else {
    Write-Host "  Mode: Release" -ForegroundColor Gray
    Write-Host "  Target: $Target" -ForegroundColor Gray

    npx @tauri-apps/cli build --bundles $Target 2>&1
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Error "Package failed"
        exit 1
    }

    # ---- Update manifest (G-06) ----
    # latest.json is what the updater downloads; it needs the .sig sidecar the
    # bundler wrote next to the installer, so it only exists for signed builds.
    if ($env:TAURI_SIGNING_PRIVATE_KEY -or $env:TAURI_SIGNING_PRIVATE_KEY_PATH) {
        Write-Host "  Generating update manifest..." -ForegroundColor Gray
        node (Join-Path $ScriptDir "scripts\release-latest-json.mjs")
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Write-Error "Update manifest generation failed"
            exit 1
        }
    }
}

Pop-Location

# ---- Done ----
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
if ($Dev) {
    Write-Host "  Debug build complete!" -ForegroundColor Green
    Write-Host "  Output: src-tauri\target\debug\$AppName.exe" -ForegroundColor Cyan
} else {
    Write-Host "  Build complete!" -ForegroundColor Green
    Write-Host "  Output: src-tauri\target\release\bundle\" -ForegroundColor Cyan
}
Write-Host "============================================================" -ForegroundColor Cyan