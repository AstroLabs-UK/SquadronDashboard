# Squadron Dashboard - Windows helper
#   sqndash.cmd --check | --update | --force-update | --restart | --set-pin | --channel | --help
# Settings in data\ are kept. Updates and version checks are done by scripts\update.js (Node),
# the same engine the dashboard itself uses: it follows the newest release tag (or main if there
# are no tags yet), tests the new version before switching to it, and rolls back if that test fails.

$ErrorActionPreference = 'Continue'
$Dir = $PSScriptRoot
if (-not $Dir) { $Dir = Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $Dir
$script:RestartResult = 1

function Show-Usage {
  Write-Host @"
Squadron Dashboard (Windows)

  sqndash --check            compare local version to the update target (also: --version)
  sqndash --update           update if there's a newer release, then restart
  sqndash --force-update     re-download even if up to date, then restart
  sqndash --restart          restart only
  sqndash --set-pin [PIN]    set the PIN that protects the /edit page (4+ characters)
  sqndash --clear-pin        remove the PIN (anyone on the network can then edit)
  sqndash --channel [name]   show, or set, the update channel:
                               release = newest tagged release (default, safest)
                               main    = tip of the main branch (for a test device)
  sqndash --help             this help

Settings from /edit (data\) are never changed by an update.
"@
}

function Write-UpdateStatus([string]$State, [string]$Message) {
  $dataDir = Join-Path $Dir 'data'
  if (-not (Test-Path $dataDir)) { return }
  try {
    $t = [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $json = "{`"state`":`"$State`",`"message`":`"$($Message -replace '"','')`",`"time`":$t}"
    [System.IO.File]::WriteAllText((Join-Path $dataDir 'update-status.json'), $json)
  } catch { }
}

# Print the result the update engine recorded, so a failure is never silent
function Show-LastStatus {
  try {
    $file = Join-Path $Dir 'data\update-status.json'
    if (Test-Path $file) {
      $j = Get-Content $file -Raw | ConvertFrom-Json
      if ($j.message) { Write-Host "Result: $($j.message)" }
    }
  } catch { }
}

function Ensure-DataFolder {
  $dataDir = Join-Path $Dir 'data'
  if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
  $example = Join-Path $Dir 'data.example.json'
  $dataJson = Join-Path $dataDir 'data.json'
  if (-not (Test-Path $dataJson) -and (Test-Path $example)) { Copy-Item $example $dataJson }
}

function Test-Prereqs {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js is not installed - install the LTS version from https://nodejs.org/'
    return $false
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'git is not installed - install Git for Windows'
    return $false
  }
  return $true
}

# Sets $script:RestartResult (0 = ok). Everything it runs is sent to the screen with Out-Host so
# it can't leak into a return value - that was the classic PowerShell trap here.
function Restart-App {
  $script:RestartResult = 1
  Write-Host '[update] restarting the dashboard...'

  if (Get-Command docker -ErrorAction SilentlyContinue) {
    $names = cmd /c "docker ps -a --format {{.Names}} 2>nul"
    if ("$names" -match 'squadron-dashboard') {
      cmd /c "docker compose up -d --build" | Out-Host
      if ($LASTEXITCODE -eq 0) {
        Write-Host '[update] done - Docker container restarted'
        $script:RestartResult = 0
        return
      }
    }
  }

  if (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host '[update] npm install...'
    cmd /c "npm install --omit=dev --quiet" | Out-Host
  }

  $serverJs = Join-Path $Dir 'server.js'
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Dir*" -and $_.ProcessId -ne $PID } |
    ForEach-Object {
      Write-Host "[update] stopping node PID $($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

  Start-Sleep -Seconds 1
  if (Test-Path $serverJs) {
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $Dir -WindowStyle Hidden
    Write-Host '[update] done - started node (http://localhost:3000)'
    $script:RestartResult = 0
    return
  }

  Write-Host '[update] could not auto-restart - run: npm start'
}

function Do-Update {
  param([switch]$Force)

  if (-not (Test-Prereqs)) { exit 2 }
  if ($Force) {
    Write-Host 'Warning: Updating will replace locally edited files with the latest versions from GitHub. Any local changes will be lost.'
    Write-Host 'Your settings from /edit (data\) are kept.'
    $answer = Read-Host 'Continue? [y/N]'
    if ($answer -notmatch '^[Yy]') {
      Write-Host 'Cancelled.'
      return
    }
  }

  Ensure-DataFolder
  Write-UpdateStatus 'running' 'Checking GitHub...'
  $mode = if ($Force) { '--force' } else { '--update' }
  & node (Join-Path $Dir 'scripts\update.js') $mode | Out-Host
  $rc = $LASTEXITCODE
  $short = ''
  try { $short = ((cmd /c "git rev-parse --short HEAD 2>&1") | Out-String).Trim() } catch { }

  switch ($rc) {
    0 {
      Show-LastStatus
      exit 0
    }
    10 {
      Write-UpdateStatus 'running' "Downloaded $short - restarting..."
      Restart-App
      if ($script:RestartResult -eq 0) {
        Write-UpdateStatus 'done' "Updated to $short and restarted"
        Write-Host "Updated to $short and restarted."
        exit 0
      }
      Write-UpdateStatus 'error' "Downloaded $short but restart failed - run npm start"
      Write-Host "Downloaded $short but the restart failed - run: npm start"
      exit 1
    }
    20 {
      Show-LastStatus
      Write-Host 'The new version failed its safety check, so it was rolled back. The dashboard was not restarted.'
      exit 20
    }
    1 {
      Write-UpdateStatus 'error' 'Could not reach GitHub'
      Write-Host 'Could not reach GitHub - check the internet connection.'
      exit 1
    }
    default {
      Show-LastStatus
      Write-Host "The update did not complete (code $rc). Full details: type data\update-status.json"
      Write-Host 'If it says git reset failed, close anything using files in this folder (editors, other terminals) and try again.'
      exit $rc
    }
  }
}

function Set-Pin([string]$Pin) {
  if (-not $Pin) {
    $s1 = Read-Host 'New editor PIN (4+ characters)' -AsSecureString
    $s2 = Read-Host 'Type it again' -AsSecureString
    $Pin = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1))
    $again = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2))
    if ($Pin -ne $again) { Write-Host "The two entries don't match - nothing changed."; exit 1 }
  }
  if ($Pin.Length -lt 4) { Write-Host 'The PIN must be at least 4 characters - nothing changed.'; exit 1 }
  Ensure-DataFolder
  [System.IO.File]::WriteAllText((Join-Path $Dir 'data\edit-pin'), $Pin + "`n")
  Write-Host 'Editor PIN saved. It applies straight away - no restart needed.'
  Write-Host 'Open /edit, leave the username blank and enter the PIN as the password.'
}

function Set-Channel([string]$Name) {
  $file = Join-Path $Dir 'data\update-channel'
  if (-not $Name) {
    $cur = 'release'
    if (Test-Path $file) { $cur = (Get-Content $file -Raw).Trim() }
    Write-Host "Update channel: $cur"
    return
  }
  if ($Name -notin @('release', 'main')) { Write-Host "Channel must be 'release' or 'main'."; exit 1 }
  Ensure-DataFolder
  [System.IO.File]::WriteAllText($file, $Name + "`n")
  Write-Host "Update channel set to: $Name"
}

$arg = if ($args.Count -gt 0) { "$($args[0])" } else { '' }
$arg2 = if ($args.Count -gt 1) { "$($args[1])" } else { '' }
switch -Regex ($arg) {
  '^(--check|--version|-v)$' {
    if (-not (Test-Prereqs)) { exit 2 }
    & node (Join-Path $Dir 'scripts\update.js') --check | Out-Host
    exit $LASTEXITCODE
  }
  '^(--update|-u)$'          { Do-Update; break }
  '^(--force-update|-f)$'    { Do-Update -Force; break }
  '^(--restart|-r)$'         { Restart-App; exit $script:RestartResult }
  '^--set-pin$'              { Set-Pin $arg2; break }
  '^--clear-pin$'            {
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Dir 'data\edit-pin')
    Write-Host 'Editor PIN removed. (An EDIT_PIN environment variable, if you set one, still applies.)'
    break
  }
  '^--channel$'              { Set-Channel $arg2; break }
  '^(--help|-h|)$'           { Show-Usage; break }
  default {
    Write-Host "Unknown option: $arg"
    Show-Usage
    exit 1
  }
}
