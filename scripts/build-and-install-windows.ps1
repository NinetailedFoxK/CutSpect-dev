# Build and install the Windows package on this machine.
#
# Usage (from the repository root, in a normal PowerShell window):
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-and-install-windows.ps1
#
# What it does:
#   1. Verifies Node.js/npm (tries to install Node LTS via winget if missing).
#   2. Installs dependencies (downloads Electron + FFmpeg/ffprobe binaries).
#   3. Runs typecheck + unit tests + build (npm run verify).
#   4. Builds the Windows installer: Squirrel Setup.exe + ZIP (npm run make:win).
#   5. Launches the generated Setup.exe so you can complete installation.
#
# Notes:
#   - Requires internet access (Electron, ffmpeg-static and ffprobe are downloaded).
#   - China network: set a mirror before running, e.g.
#       $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
#     (you can also export the same variable in your shell profile).

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "[build-install] repo root: $root"

function Test-CommandExists([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# --- 1. Node.js / npm -------------------------------------------------------
# Node may already be installed but missing from PATH (e.g. C:\Program Files\nodejs).
if (-not (Test-CommandExists node)) {
  foreach ($cand in @("$env:ProgramFiles\nodejs", "$env:LOCALAPPDATA\Programs\nodejs", "${env:ProgramFiles(x86)}\nodejs")) {
    if ($cand -and (Test-Path (Join-Path $cand 'node.exe'))) {
      $env:PATH = "$cand;$env:PATH"
      Write-Host "[build-install] Found existing Node at $cand (added to this session PATH)."
      break
    }
  }
}

if (-not (Test-CommandExists node) -or -not (Test-CommandExists npm)) {
  Write-Host '[build-install] Node.js / npm not found on PATH.'
  if (Test-CommandExists winget) {
    Write-Host '[build-install] Trying to install Node.js LTS via winget ...'
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Write-Host ''
    Write-Host '[build-install] Node was installed. CLOSE and REOPEN your terminal, then re-run this script.'
    exit 1
  }
  Write-Host '[build-install] Please install Node.js (>= 22.12) from https://nodejs.org and re-run.'
  exit 1
}

Write-Host "[build-install] node $(node -v) / npm $(npm -v)"

# --- 2. Dependencies --------------------------------------------------------
Write-Host '[build-install] Installing dependencies (this downloads Electron, ~hundreds of MB) ...'
npm install --no-audit --no-fund

# --- 3. Verify (typecheck + tests + build) ----------------------------------
Write-Host '[build-install] Running typecheck + tests + build (npm run verify) ...'
npm run verify

# --- 4. Build Windows package (Setup.exe + ZIP) -----------------------------
Write-Host '[build-install] Building Windows package (npm run make:win) ...'
npm run make:win

# --- 5. Locate and launch the installer -------------------------------------
$setup = Get-ChildItem -Path (Join-Path $root 'out\make') -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -eq '.exe' -and $_.Name -like '*Setup*' } |
  Select-Object -First 1
if (-not $setup) {
  $setup = Get-ChildItem -Path (Join-Path $root 'out\make') -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -eq '.exe' } |
    Select-Object -First 1
}

$zip = Get-ChildItem -Path (Join-Path $root 'out\make') -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -eq '.zip' } |
  Select-Object -First 1

if ($setup) {
  Write-Host "[build-install] Installer: $($setup.FullName)"
}
if ($zip) {
  Write-Host "[build-install] Portable ZIP: $($zip.FullName)"
}

if (-not $setup) {
  Write-Host '[build-install] ERROR: no .exe found under out\make. Build may have failed. See output above.'
  exit 1
}

Write-Host '[build-install] Launching the installer. Follow the wizard to install the app.'
Start-Process -FilePath $setup.FullName
Write-Host '[build-install] Done. After installation, find "CutSpect" / "laipian-tai" in the Start menu.'