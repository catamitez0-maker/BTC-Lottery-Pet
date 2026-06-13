$ErrorActionPreference = "Stop"

function Get-RepoRoot {
  return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Get-ExistingPath {
  param([string[]]$Paths)

  foreach ($path in $Paths) {
    if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $path).Path
    }
  }

  return $null
}

function Find-ProjectTool {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    return $command.Source
  }

  switch ($Name) {
    "git" {
      return Get-ExistingPath @(
        (Join-Path $env:ProgramFiles "Git\cmd\git.exe"),
        (Join-Path $env:ProgramFiles "Git\bin\git.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Git\cmd\git.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe")
      )
    }
    "node" {
      return Get-ExistingPath @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
        (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
      )
    }
    "npm" {
      return Get-ExistingPath @(
        (Join-Path $env:ProgramFiles "nodejs\npm.cmd"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\npm.cmd"),
        (Join-Path $env:APPDATA "npm\npm.cmd")
      )
    }
    "cargo" {
      return Get-ExistingPath @(
        (Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Rustlang.Rustup_Microsoft.Winget.Source_8wekyb3d8bbwe\cargo.exe")
      )
    }
    default {
      return $null
    }
  }
}

function Add-ToolToPath {
  param([string]$ToolPath)

  if (-not $ToolPath) {
    return
  }

  $dir = Split-Path -Parent $ToolPath
  $parts = $env:PATH -split ";" | Where-Object { $_ }
  if ($parts -notcontains $dir) {
    $env:PATH = "$dir;$env:PATH"
  }
}

function Get-ToolVersion {
  param(
    [string]$ToolPath,
    [string[]]$Arguments = @("--version")
  )

  if (-not $ToolPath) {
    return ""
  }

  try {
    return ((& $ToolPath @Arguments 2>&1) -join " ").Trim()
  } catch {
    return "version check failed: $($_.Exception.Message)"
  }
}

function Get-ProjectToolReport {
  $tools = @(
    @{ Name = "git"; Required = $false; VersionArgs = @("--version") },
    @{ Name = "node"; Required = $true; VersionArgs = @("--version") },
    @{ Name = "npm"; Required = $false; VersionArgs = @("--version") },
    @{ Name = "cargo"; Required = $false; VersionArgs = @("--version") }
  )

  $report = @()
  foreach ($tool in $tools) {
    $path = Find-ProjectTool $tool.Name
    Add-ToolToPath $path
    $report += [pscustomobject]@{
      Tool = $tool.Name
      Required = $tool.Required
      Found = [bool]$path
      Path = $path
      Version = Get-ToolVersion $path $tool.VersionArgs
    }
  }

  return $report
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command
  )

  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}
