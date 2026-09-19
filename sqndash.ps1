# Squadron Dashboard - Windows helper (same roles as sqndash / update.sh on Linux)
#
#   .\sqndash.ps1 --update
#   .\sqndash.ps1 --force-update
#   .\sqndash.ps1 --restart
#   .\sqndash.ps1 --help
#
# Or from CMD:  sqndash.cmd --force-update
#
# Settings in data\ are never overwritten. Force update replaces tracked files with GitHub.

$ErrorActionPreference = 'Stop'
$Dir = $PSScriptRoot
if (-not $Dir) { $Dir = Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $Dir

function Show-Usage {
  Write-Host @"
Squadron Dashboard (Windows)

  sqndash --update         update if a newer version is on GitHub, then restart
  sqndash --force-update   re-download even if already up to date, then restart
  sqndash --restart        restart the dashboard only
  sqndash --help           show this help

Your settings (from /edit) live in data\ and are never changed by an update.
"@
}

function Write-UpdateStatus {
  param([string]$State, [string]$Message)
  $dataDir = Join-Path $Dir 'data'
  if (-not (Test-Path $dataDir)) { return }
  $payload = @{ state = $State; message = $Message; time = [int][double]::Parse((Get-Date -UFormat %s)) } | ConvertTo-Json -Compress
  $statusFile = Join-Path $dataDir 'update-status.json'
  try {
    [System.IO.File]::WriteAllText($statusFile, $payload)
  } catch { }
}

function Ensure-DataFolder {
  $dataDir = Join-Path $Dir 'data'
  if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
  $example = Join-Path $Dir 'data.example.json'
  $dataJson = Join-Path $dataDir 'data.json'
  if (-not (Test-Path $dataJson) -and (Test-Path $example)) {
    Copy-Item $example $dataJson
  }
}

function Resolve-RemoteTip {
  $candidates = @('@{u}', 'origin/main', 'origin/master')
  foreach ($c in $candidates) {
    try {
      $tip = (& git rev-parse $c 2>$null | Select-Object -First 1)
      if ($LASTEXITCODE -eq 0 -and $tip) { return $tip.Trim() }
    } catch { }
  }
  return $null
}

function Sync-Code {
  param([switch]$Force)

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host '[update] git is not installed - install Git for Windows and try again'
    return 2
  }

  Ensure-DataFolder
  Write-Host '[update] checking GitHub...'

  & git fetch --quiet origin 2>$null
  if ($LASTEXITCODE -ne 0) {
    & git fetch --quiet 2>$null
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[update] cannot reach GitHub - check internet / remote'
    return 1
  }

  $local = (& git rev-parse HEAD 2>$null | Select-Object -First 1)
  if ($local) { $local = $local.Trim() }
  $remote = Resolve-RemoteTip
  if (-not $remote) {
    Write-Host '[update] could not determine remote tip - is origin configured?'
    return 3
  }

  $rc = 10
  if ($local -eq $remote) {
    if (-not $Force) {
      $short = (& git rev-parse --short HEAD).Trim()
      Write-Host "[update] already on the latest version ($short)"
      return 0
    }
    Write-Host '[update] already on the latest version - forcing a clean re-apply anyway'
    $rc = 11
  } else {
    Write-Host '[update] new version found - downloading...'
  }

  # Safety copy of settings
  $keep = Join-Path $env:TEMP ("sqndash-data-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $keep | Out-Null
  $dataDir = Join-Path $Dir 'data'
  if (Test-Path $dataDir) {
    Copy-Item -Recurse -Force $dataDir (Join-Path $keep 'data')
  }

  # Match GitHub exactly; local edits to tracked files are discarded
  & git reset --hard $remote --quiet 2>$null
  if ($LASTEXITCODE -ne 0) {
    & git reset --hard $remote
  }
  & git clean -fd --quiet 2>$null

  # Restore settings if anything went missing
  if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
  foreach ($f in @('data.json', 'data.backup.json')) {
    $dest = Join-Path $dataDir $f
    $src = Join-Path $keep "data\$f"
    if (-not (Test-Path $dest) -and (Test-Path $src)) {
      Copy-Item $src $dest
    }
  }
  Remove-Item -Recurse -Force $keep -ErrorAction SilentlyContinue

  $short = (& git rev-parse --short HEAD).Trim()
  Write-Host "[update] downloaded $short"
  return $rc
}

function Restart-App {
  Write-Host '[update] restarting the dashboard...'

  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if ($docker) {
    $names = & docker ps -a --format '{{.Names}}' 2>$null
    if ($names -match 'squadron-dashboard') {
      & docker compose up -d --build
      if ($LASTEXITCODE -eq 0) {
        Write-Host '[update] done - Docker container rebuilt/restarted'
        return 0
      }
    }
  }

  if (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host '[update] installing dependencies...'
    & npm install --omit=dev --quiet
  }

  # Stop any node process serving this folder, then start again in background if possible
  $serverJs = Join-Path $Dir 'server.js'
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Dir*" } |
    ForEach-Object {
      Write-Host "[update] stopping node PID $($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

  Start-Sleep -Seconds 1
  if (Test-Path $serverJs) {
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $Dir -WindowStyle Hidden
    Write-Host '[update] done - started node server.js (http://localhost:3000)'
    return 0
  }

  Write-Host '[update] could not auto-restart - run: npm start'
  return 1
}

function Do-Update {
  param([switch]$Force)

  if ($Force) {
    Write-Host 'Warning: Updating will replace locally edited files with the latest versions from GitHub. Any local changes will be lost.'
    Write-Host 'Your settings from /edit (data\) are kept.'
    $answer = Read-Host 'Continue? [y/N]'
    if ($answer -notmatch '^[Yy]') {
      Write-Host 'Cancelled.'
      return
    }
  }

  Write-UpdateStatus 'running' 'Checking GitHub...'
  $rc = Sync-Code -Force:$Force
  $short = ''
  try { $short = (& git rev-parse --short HEAD 2>$null).Trim() } catch { }

  switch ($rc) {
    0 {
      Write-UpdateStatus 'done' "Already on the latest version ($short) - nothing to update"
      exit 0
    }
    10 {
      Write-UpdateStatus 'running' "Downloaded $short - restarting the dashboard..."
      if ((Restart-App) -eq 0) {
        Write-UpdateStatus 'done' "Updated to $short and restarted"
        exit 0
      }
      Write-UpdateStatus 'error' "Downloaded $short but restarting failed - run: npm start"
      exit 1
    }
    11 {
      Write-UpdateStatus 'running' "Downloaded $short - restarting the dashboard..."
      if ((Restart-App) -eq 0) {
        Write-UpdateStatus 'done' "Already on the latest version ($short) - re-applied it and restarted"
        exit 0
      }
      Write-UpdateStatus 'error' "Downloaded $short but restarting failed - run: npm start"
      exit 1
    }
    1 {
      Write-UpdateStatus 'error' "Couldn't reach GitHub - check the internet connection"
      exit 1
    }
    default {
      Write-UpdateStatus 'error' "The update failed (code $rc)"
      exit $rc
    }
  }
}

$arg = if ($args.Count -gt 0) { $args[0] } else { '' }
switch -Regex ($arg) {
  '^(--update|-u)$'       { Do-Update; break }
  '^(--force-update|-f)$' { Do-Update -Force; break }
  '^(--restart|-r)$'      { exit (Restart-App) }
  '^(--help|-h|)$'        { Show-Usage; break }
  default {
    Write-Host "Unknown option: $arg"
    Write-Host ''
    Show-Usage
    exit 1
  }
}
