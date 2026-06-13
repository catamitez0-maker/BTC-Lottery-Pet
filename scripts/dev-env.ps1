param(
  [switch]$Json
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\tooling.ps1"

$repoRoot = Get-RepoRoot
$report = Get-ProjectToolReport

if ($Json) {
  $report | ConvertTo-Json -Depth 4
  return
}

Write-Host "BTC Lottery Pet development environment" -ForegroundColor Cyan
Write-Host "Repo: $repoRoot"
Write-Host ""
$report | Format-Table Tool, Found, Path, Version -AutoSize

$missing = $report | Where-Object { $_.Required -and -not $_.Found }
if ($missing) {
  Write-Host ""
  Write-Host "Missing required tools:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "- $($_.Tool)" -ForegroundColor Red }
  exit 1
}

Write-Host ""
Write-Host "PATH was updated for this script process." -ForegroundColor Green
Write-Host "To update your current shell, dot-source this script:"
Write-Host ". .\scripts\dev-env.ps1"
