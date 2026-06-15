[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$IncludeNodeModules
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\tooling.ps1"

$repoRoot = Get-RepoRoot

function Resolve-RepoPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $fullPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $RelativePath))
  if (-not $fullPath.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch path outside repository: $RelativePath"
  }

  return $fullPath
}

function Remove-GeneratedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $fullPath = Resolve-RepoPath $RelativePath
  if (-not (Test-Path -LiteralPath $fullPath)) {
    Write-Host "skip missing  $RelativePath"
    return
  }

  if ($PSCmdlet.ShouldProcess($fullPath, "Remove generated development file")) {
    Remove-Item -LiteralPath $fullPath -Recurse -Force
    Write-Host "removed       $RelativePath" -ForegroundColor Green
  }
}

function Remove-GeneratedFilesByPattern {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Pattern
  )

  Get-ChildItem -LiteralPath $repoRoot -Force -File -Filter $Pattern |
    ForEach-Object {
      $relativePath = $_.Name
      if ($PSCmdlet.ShouldProcess($_.FullName, "Remove generated development log")) {
        Remove-Item -LiteralPath $_.FullName -Force
        Write-Host "removed       $relativePath" -ForegroundColor Green
      }
    }
}

Set-Location $repoRoot

$generatedPaths = @(
  "dist",
  ".test-dist",
  "src-tauri\target",
  "src-tauri\target-dev",
  "artifacts"
)

if ($IncludeNodeModules) {
  $generatedPaths += "node_modules"
}

Write-Host "Cleaning generated development files in $repoRoot" -ForegroundColor Cyan
foreach ($path in $generatedPaths) {
  Remove-GeneratedPath $path
}
Remove-GeneratedFilesByPattern "*.log"

Write-Host ""
Write-Host "Cleanup complete." -ForegroundColor Green
if (-not $IncludeNodeModules) {
  Write-Host "node_modules was kept. Add -IncludeNodeModules for a full dependency reset."
}
