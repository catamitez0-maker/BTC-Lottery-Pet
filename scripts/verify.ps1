param(
  [switch]$Strict,
  [switch]$SkipAudit,
  [switch]$SkipRust,
  [switch]$BuildInstaller
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\tooling.ps1"

$repoRoot = Get-RepoRoot
Set-Location $repoRoot

$tools = Get-ProjectToolReport
$node = ($tools | Where-Object Tool -eq "node").Path
$npm = ($tools | Where-Object Tool -eq "npm").Path
$cargo = ($tools | Where-Object Tool -eq "cargo").Path

if (-not $node) {
  throw "Node.js is required. Run scripts\dev-env.ps1 to see detected tools."
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules") -PathType Container)) {
  throw "Frontend dependencies are missing. Run npm install before scripts\verify.ps1."
}

if (-not $SkipRust -and $cargo) {
  if (-not (Get-Command "link.exe" -ErrorAction SilentlyContinue)) {
    [void](Import-Vcvars64Environment)
  }

  if ((Get-Command "link.exe" -ErrorAction SilentlyContinue) -and -not (Test-LibraryPathContains "kernel32.lib")) {
    [void](Ensure-WindowsSdkForMsvc)
  }

  if (-not (Get-Command "link.exe" -ErrorAction SilentlyContinue)) {
    throw "MSVC linker link.exe is not available. Install the Desktop development with C++ workload, or run from a Visual Studio Developer shell."
  }

  if (-not (Test-LibraryPathContains "kernel32.lib")) {
    throw "Windows SDK libraries are not available to MSVC. Install a Windows 10/11 SDK component in Visual Studio Build Tools."
  }
}

function Invoke-NpmOrNode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$NpmScript,
    [Parameter(Mandatory = $true)]
    [scriptblock]$NodeFallback
  )

  if ($npm) {
    Invoke-Step $Name { & $npm run $NpmScript }
    return
  }

  Write-Host ""
  Write-Host "==> $Name (direct Node fallback; npm not found)" -ForegroundColor Cyan
  & $NodeFallback
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

Invoke-NpmOrNode "Frontend unit tests" "test:frontend" {
  & $node ".\node_modules\typescript\bin\tsc" -p "tsconfig.frontend-test.json"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $node "--test" "test\miningLogic.test.mjs"
}

Invoke-NpmOrNode "Frontend production build" "build" {
  & $node ".\node_modules\typescript\bin\tsc"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $node ".\node_modules\vite\bin\vite.js" "build" "--configLoader" "runner"
}

if (-not $SkipAudit) {
  if ($npm) {
    Invoke-Step "Production dependency audit" { & $npm audit --omit=dev }
  } elseif ($Strict) {
    throw "npm audit requires npm, but npm was not found."
  } else {
    Write-Host ""
    Write-Host "==> Production dependency audit skipped: npm not found" -ForegroundColor Yellow
  }
}

if (-not $SkipRust) {
  if ($cargo) {
    Invoke-Step "Rust tests" { & $cargo test --manifest-path "src-tauri\Cargo.toml" }
    Invoke-Step "Rust clippy" { & $cargo clippy --manifest-path "src-tauri\Cargo.toml" -- -D warnings }
  } elseif ($Strict) {
    throw "Rust checks require cargo, but cargo was not found."
  } else {
    Write-Host ""
    Write-Host "==> Rust checks skipped: cargo not found" -ForegroundColor Yellow
  }
}

if ($BuildInstaller) {
  if (-not $npm) {
    throw "Installer build requires npm/Tauri CLI, but npm was not found."
  }
  Invoke-Step "Tauri installer build" { & $npm run tauri:build }
}

Write-Host ""
Write-Host "Verification script completed." -ForegroundColor Green
if (-not $npm -or (-not $cargo -and -not $SkipRust)) {
  Write-Host "Some checks were skipped because optional tools were not found. Use -Strict for release gating." -ForegroundColor Yellow
}
