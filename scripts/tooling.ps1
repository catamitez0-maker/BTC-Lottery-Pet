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

function Add-EnvironmentListPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [switch]$Append
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return
  }

  $current = [Environment]::GetEnvironmentVariable($Name, "Process")
  $parts = $current -split ";" | Where-Object { $_ }
  if ($parts -contains $Path) {
    return
  }

  if ($Append) {
    [Environment]::SetEnvironmentVariable($Name, "$current;$Path", "Process")
  } else {
    [Environment]::SetEnvironmentVariable($Name, "$Path;$current", "Process")
  }
}

function Test-LibraryPathContains {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FileName
  )

  foreach ($path in ($env:LIB -split ";" | Where-Object { $_ })) {
    if (Test-Path -LiteralPath (Join-Path $path $FileName) -PathType Leaf) {
      return $true
    }
  }

  return $false
}

function Find-Vcvars64 {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat")
  )

  $existing = Get-ExistingPath $candidates
  if ($existing) {
    return $existing
  }

  $vswhere = Get-ExistingPath @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
  )
  if (-not $vswhere) {
    return $null
  }

  $installations = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  foreach ($installation in $installations) {
    $vcvars = Join-Path $installation "VC\Auxiliary\Build\vcvars64.bat"
    if (Test-Path -LiteralPath $vcvars -PathType Leaf) {
      return (Resolve-Path -LiteralPath $vcvars).Path
    }
  }

  return $null
}

function Import-Vcvars64Environment {
  $vcvars = Find-Vcvars64
  if (-not $vcvars) {
    return $false
  }

  $command = "call `"$vcvars`" >nul && set"
  $lines = & cmd.exe /d /c $command
  if ($LASTEXITCODE -ne 0) {
    return $false
  }

  foreach ($line in $lines) {
    if ($line -match "^([^=]+)=(.*)$") {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
  }

  return $true
}

function Ensure-WindowsSdkForMsvc {
  param([string]$Architecture = "x64")

  if (Test-LibraryPathContains "kernel32.lib") {
    return $true
  }

  $kitRoots = @(
    (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10"),
    (Join-Path $env:ProgramFiles "Windows Kits\10")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }

  foreach ($kitRoot in $kitRoots) {
    $libRoot = Join-Path $kitRoot "Lib"
    if (-not (Test-Path -LiteralPath $libRoot -PathType Container)) {
      continue
    }

    $sdkVersion = Get-ChildItem -LiteralPath $libRoot -Directory |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "um\$Architecture\kernel32.lib") -PathType Leaf } |
      Sort-Object { [version]$_.Name } -Descending |
      Select-Object -First 1

    if (-not $sdkVersion) {
      continue
    }

    $version = $sdkVersion.Name
    Add-EnvironmentListPath "LIB" (Join-Path $sdkVersion.FullName "um\$Architecture") -Append
    Add-EnvironmentListPath "LIB" (Join-Path $sdkVersion.FullName "ucrt\$Architecture") -Append
    Add-EnvironmentListPath "INCLUDE" (Join-Path $kitRoot "Include\$version\ucrt") -Append
    Add-EnvironmentListPath "INCLUDE" (Join-Path $kitRoot "Include\$version\shared") -Append
    Add-EnvironmentListPath "INCLUDE" (Join-Path $kitRoot "Include\$version\um") -Append
    Add-EnvironmentListPath "INCLUDE" (Join-Path $kitRoot "Include\$version\winrt") -Append
    Add-EnvironmentListPath "INCLUDE" (Join-Path $kitRoot "Include\$version\cppwinrt") -Append
    Add-EnvironmentListPath "PATH" (Join-Path $kitRoot "bin\$version\$Architecture")
    $env:WindowsSdkDir = "$kitRoot\"
    $env:WindowsSDKLibVersion = "$version\"
    return (Test-LibraryPathContains "kernel32.lib")
  }

  return $false
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
