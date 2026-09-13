<#
.SYNOPSIS
  Windows Desktop One-Click Launcher for LeetCode Tracker.

.DESCRIPTION
  Automates the startup workflow:
  1. Checks Node.js runtime availability.
  2. Probes target loopback port (default: 3000):
     - If LeetCode Tracker is already running, opens the browser directly to prevent database lease collisions.
     - If occupied by an unrelated service, warns the user and aborts.
  3. Verifies frontend build assets and builds if missing.
  4. Launches the Fastify server and awaits health readiness.
  5. Opens the default browser once the local service is responsive.
  6. Keeps the console alive for graceful shutdown on Ctrl+C.
#>

param(
  [int]$Port = 3000,
  [string]$HostName = "127.0.0.1",
  [switch]$Minimize
)

$ErrorActionPreference = "Stop"

# Resolve repo root directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = (Resolve-Path "$scriptDir\..").Path
Set-Location -Path $repoRoot

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "       LeetCode Tracker - Desktop Launcher          " -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan

# 1. Verify Node.js
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
  Write-Host "Error: Node.js is not found in PATH." -ForegroundColor Red
  Write-Host "Please install Node.js 24.x from https://nodejs.org/" -ForegroundColor Yellow
  Read-Host "Press Enter to exit..."
  exit 1
}

$url = "http://${HostName}:${Port}"
$statsUrl = "${url}/api/v1/catalog/stats"

# 2. Probe whether LeetCode Tracker is already running
$alreadyRunning = $false
try {
  $probe = Invoke-RestMethod -Uri $statsUrl -Method Get -TimeoutSec 1 -ErrorAction Stop
  if ($probe -and $probe.PSObject.Properties['totalProblems']) {
    $alreadyRunning = $true
  }
} catch {
  # Server not responding or port not open
}

if ($alreadyRunning) {
  Write-Host "LeetCode Tracker is already running on ${url}." -ForegroundColor Green
  Write-Host "Opening default browser..." -ForegroundColor Cyan
  Start-Process $url
  Start-Sleep -Seconds 1
  exit 0
}

# 3. Check if port is occupied by a different process
$tcpPortInUse = $false
try {
  $tcpConn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($tcpConn) {
    $tcpPortInUse = $true
  }
} catch {
  # Get-NetTCPConnection may fail if non-elevated or unavailable
}

if ($tcpPortInUse) {
  Write-Host "Warning: Port $Port is currently in use by an unrecognized process." -ForegroundColor Yellow
  Write-Host "Please free port $Port or set a custom port with `$env:PORT." -ForegroundColor Yellow
  Read-Host "Press Enter to exit..."
  exit 1
}

# 4. Verify frontend build
$distIndex = Join-Path $repoRoot "apps\web\dist\index.html"
if (-not (Test-Path $distIndex)) {
  Write-Host "Frontend build assets missing. Running build..." -ForegroundColor Yellow
  npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed. Please fix build errors before launching." -ForegroundColor Red
    Read-Host "Press Enter to exit..."
    exit 1
  }
}

# 5. Start Fastify server
Write-Host "Starting LeetCode Tracker server on port $Port..." -ForegroundColor Cyan
$serverScript = Join-Path $repoRoot "apps\server\src\server.ts"

$env:PORT = $Port.ToString()
$env:HOST = $HostName

$processArgs = @{
  FilePath = "node"
  ArgumentList = "apps/server/src/server.ts"
  WorkingDirectory = $repoRoot
  PassThru = $true
}

if ($Minimize) {
  $processArgs["WindowStyle"] = "Minimized"
}

$serverProcess = Start-Process @processArgs

# 6. Health check polling (up to 15 seconds)
Write-Host "Waiting for local service readiness..." -NoNewline -ForegroundColor Gray
$ready = $false
$attempts = 0
$maxAttempts = 30

while (-not $ready -and $attempts -lt $maxAttempts) {
  Start-Sleep -Milliseconds 500
  $attempts++
  Write-Host "." -NoNewline -ForegroundColor Gray

  if ($serverProcess.HasExited) {
    Write-Host ""
    Write-Host "Server process exited prematurely with exit code $($serverProcess.ExitCode)." -ForegroundColor Red
    Read-Host "Press Enter to exit..."
    exit 1
  }

  try {
    $res = Invoke-RestMethod -Uri $statsUrl -Method Get -TimeoutSec 1 -ErrorAction Stop
    if ($res -and $res.PSObject.Properties['totalProblems']) {
      $ready = $true
    }
  } catch {
    # Keep waiting
  }
}

Write-Host ""

if ($ready) {
  Write-Host "LeetCode Tracker is ready!" -ForegroundColor Green
  Write-Host "  Web: $url/" -ForegroundColor Cyan
  Write-Host "  API: $statsUrl" -ForegroundColor Cyan
  Write-Host "Opening default browser..." -ForegroundColor Green
  Start-Process $url
  Write-Host "`n[Server is running. Press Ctrl+C in this window to stop cleanly]`n" -ForegroundColor Gray
} else {
  Write-Host "Warning: Health check timed out, but process is still running." -ForegroundColor Yellow
  Write-Host "Opening browser anyway: $url" -ForegroundColor Yellow
  Start-Process $url
}

# Keep the launcher attached to the server process
try {
  $serverProcess.WaitForExit()
} finally {
  if (-not $serverProcess.HasExited) {
    Write-Host "`n[Stopping server process...]" -ForegroundColor Yellow
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
