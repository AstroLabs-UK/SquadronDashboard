# Squadron Dashboard - Windows helper
#   sqndash.cmd --update | --force-update | --restart | --help
# Settings in data\ are kept. Force update replaces tracked files with GitHub.

$ErrorActionPreference = 'Continue'
$Dir = $PSScriptRoot
if (-not $Dir) { $Dir = Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $Dir

function Show-Usage {
  Write-Host @"
Squadron Dashboard (Windows)

  sqndash --check            compare local version to GitHub (also: --version)
  sqndash --update           update if newer on GitHub, then restart
  sqndash --force-update     re-download even if up to date, then restart
  sqndash --restart          restart only
  sqndash --help             this help

Settings from /edit (data\) are never changed by an update.
"@
}

function Show-VersionCheck {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'git is not installed'
    exit 2
  }
  if (-not (Test-Path (Join-Path $Dir '.git'))) {
    Write-Host "Not a git repository: $Dir"
    exit 3
  }
  Write-Host 'Fetching from GitHub...'
  $f = Invoke-Git 'fetch origin'
  if ($f.ExitCode -ne 0) { Invoke-Git 'fetch' | Out-Null }
  $local = ((Invoke-Git 'rev-parse --short HEAD').Output | Out-String).Trim().Split("`n")[0].Trim()
  $localFull = ((Invoke-Git 'rev-parse HEAD').Output | Out-String).Trim().Split("`n")[0].Trim()
  $localMsg = ((Invoke-Git 'log -1 --pretty=%s').Output | Out-String).Trim().Split("`n")[0].Trim()
  $remoteRef = $null
  foreach ($ref in @('origin/main', 'origin/master', 'origin/HEAD')) {
    $r = Invoke-Git "rev-parse --verify $ref"
    if ($r.ExitCode -eq 0) { $remoteRef = $ref; break }
  }
  if (-not $remoteRef) {
    Write-Host "Local:  $local  $localMsg"
    Write-Host 'Remote: (could not resolve origin/main or origin/master)'
    exit 3
  }
  $remote = ((Invoke-Git "rev-parse --short $remoteRef").Output | Out-String).Trim().Split("`n")[0].Trim()
  $remoteFull = ((Invoke-Git "rev-parse $remoteRef").Output | Out-String).Trim().Split("`n")[0].Trim()
  $remoteMsg = ((Invoke-Git "log -1 --pretty=%s $remoteRef").Output | Out-String).Trim().Split("`n")[0].Trim()
  $behind = ((Invoke-Git "rev-list --count HEAD..$remoteRef").Output | Out-String).Trim().Split("`n")[0].Trim()
  $ahead = ((Invoke-Git "rev-list --count $remoteRef..HEAD").Output | Out-String).Trim().Split("`n")[0].Trim()
  Write-Host "Local:  $local  $localMsg"
  Write-Host "GitHub: $remote  $remoteMsg  ($remoteRef)"
  if ($localFull -eq $remoteFull) {
    Write-Host 'Status: up to date'
    exit 0
  }
  Write-Host "Status: local is behind by $behind commit(s), ahead by $ahead"
  exit 10
}

function Write-UpdateStatus([string]$State, [string]$Message) {
  $dataDir = Join-Path $Dir 'data'
  if (-not (Test-Path $dataDir)) { return }
  try {
    $t = [int][double]::Parse((Get-Date -UFormat %s))
    $json = "{`"state`":`"$State`",`"message`":`"$($Message -replace '"','')`",`"time`":$t}"
    [System.IO.File]::WriteAllText((Join-Path $dataDir 'update-status.json'), $json)
  } catch { }
}

function Ensure-DataFolder {
  $dataDir = Join-Path $Dir 'data'
  if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
  $example = Join-Path $Dir 'data.example.json'
  $dataJson = Join-Path $dataDir 'data.json'
  if (-not (Test-Path $dataJson) -and (Test-Path $example)) { Copy-Item $example $dataJson }
}

function Invoke-Git {
  param([Parameter(Mandatory)][string]$GitArgs)
  # Always via cmd.exe so PowerShell never mangles refs like @{u}
  $out = cmd /c "git $GitArgs 2>&1"
  return @{ ExitCode = $LASTEXITCODE; Output = $out }
}

function Sync-Code {
  param([switch]$Force)

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host '[update] git is not installed - install Git for Windows'
    return 2
  }
  if (-not (Test-Path (Join-Path $Dir '.git'))) {
    Write-Host '[update] not a git repo - clone from GitHub or run git init + git remote add origin <url>'
    return 3
  }

  Ensure-DataFolder
  Write-Host '[update] checking GitHub...'

  $remoteList = (Invoke-Git 'remote').Output
  if (-not ("$remoteList" -match 'origin')) {
    Write-Host '[update] no origin remote. Add one:'
    Write-Host '  git remote add origin https://github.com/AstroLabs-UK/SquadronDashboard.git'
    return 3
  }

  $fetch = Invoke-Git 'fetch origin'
  if ($fetch.ExitCode -ne 0) {
    $fetch = Invoke-Git 'fetch'
  }
  if ($fetch.ExitCode -ne 0) {
    Write-Host '[update] cannot reach GitHub:'
    Write-Host ($fetch.Output | Out-String)
    return 1
  }

  # Resolve tip: try origin/main, origin/master, then first origin/* branch
  $remoteRef = $null
  foreach ($ref in @('origin/main', 'origin/master', 'origin/HEAD')) {
    $r = Invoke-Git "rev-parse --verify $ref"
    if ($r.ExitCode -eq 0) {
      $remoteRef = $ref
      break
    }
  }
  if (-not $remoteRef) {
    $br = Invoke-Git 'branch -r'
    foreach ($line in @($br.Output)) {
      $name = ("$line").Trim()
      if ($name -match '^origin/\S+' -and $name -notmatch 'HEAD') {
        $remoteRef = ($name -split '\s+')[0]
        break
      }
    }
  }
  if (-not $remoteRef) {
    Write-Host '[update] no remote branch found after fetch. Output of git branch -r:'
    Invoke-Git 'branch -r' | ForEach-Object { Write-Host $_.Output }
    Write-Host 'Push code to GitHub first, or run: git reset --hard origin/main'
    return 3
  }

  $local = (Invoke-Git 'rev-parse HEAD').Output
  $local = if ($local) { ("$local").Trim().Split("`n")[0].Trim() } else { '' }
  $remote = (Invoke-Git "rev-parse $remoteRef").Output
  $remote = if ($remote) { ("$remote").Trim().Split("`n")[0].Trim() } else { '' }

  $rc = 10
  if ($local -and $remote -and ($local -eq $remote)) {
    if (-not $Force) {
      $short = (Invoke-Git 'rev-parse --short HEAD').Output
      Write-Host "[update] already on the latest version ($("$short".Trim()))"
      return 0
    }
    Write-Host "[update] already on latest - forcing clean re-apply of $remoteRef"
    $rc = 11
  } else {
    Write-Host "[update] updating to $remoteRef ..."
  }

  # Backup settings
  $keep = Join-Path $env:TEMP ('sqndash-data-' + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $keep | Out-Null
  $dataDir = Join-Path $Dir 'data'
  if (Test-Path $dataDir) { Copy-Item -Recurse -Force $dataDir (Join-Path $keep 'data') }

  # Force match GitHub - never stop for dirty tree
  $reset = Invoke-Git "reset --hard $remoteRef"
  if ($reset.ExitCode -ne 0) {
    Write-Host '[update] git reset failed:'
    Write-Host ($reset.Output | Out-String)
    return 4
  }
  Invoke-Git 'clean -fd' | Out-Null

  # Restore settings if missing
  if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
  foreach ($f in @('data.json', 'data.backup.json')) {
    $dest = Join-Path $dataDir $f
    $src = Join-Path $keep "data\$f"
    if (-not (Test-Path $dest) -and (Test-Path $src)) { Copy-Item $src $dest }
  }
  Remove-Item -Recurse -Force $keep -ErrorAction SilentlyContinue

  $short = (Invoke-Git 'rev-parse --short HEAD').Output
  Write-Host "[update] downloaded $("$short".Trim())"
  return $rc
}

function Restart-App {
  Write-Host '[update] restarting the dashboard...'

  if (Get-Command docker -ErrorAction SilentlyContinue) {
    $names = cmd /c "docker ps -a --format {{.Names}} 2>nul"
    if ("$names" -match 'squadron-dashboard') {
      cmd /c "docker compose up -d --build"
      if ($LASTEXITCODE -eq 0) {
        Write-Host '[update] done - Docker container restarted'
        return 0
      }
    }
  }

  if (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host '[update] npm install...'
    cmd /c "npm install --omit=dev --quiet"
  }

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
    Write-Host '[update] done - started node (http://localhost:3000)'
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
  try { $short = ((Invoke-Git 'rev-parse --short HEAD').Output | Out-String).Trim() } catch { }

  switch ($rc) {
    0 {
      Write-UpdateStatus 'done' "Already on the latest version ($short)"
      exit 0
    }
    10 {
      Write-UpdateStatus 'running' "Downloaded $short - restarting..."
      if ((Restart-App) -eq 0) {
        Write-UpdateStatus 'done' "Updated to $short and restarted"
        exit 0
      }
      Write-UpdateStatus 'error' "Downloaded $short but restart failed - run npm start"
      exit 1
    }
    11 {
      Write-UpdateStatus 'running' "Re-applied $short - restarting..."
      if ((Restart-App) -eq 0) {
        Write-UpdateStatus 'done' "Re-applied $short and restarted"
        exit 0
      }
      Write-UpdateStatus 'error' "Restart failed - run npm start"
      exit 1
    }
    1 {
      Write-UpdateStatus 'error' 'Could not reach GitHub'
      exit 1
    }
    default {
      Write-UpdateStatus 'error' "Update failed (code $rc)"
      exit $rc
    }
  }
}

$arg = if ($args.Count -gt 0) { "$($args[0])" } else { '' }
switch -Regex ($arg) {
  '^(--check|--version|-v)$' { Show-VersionCheck; break }
  '^(--update|-u)$'          { Do-Update; break }
  '^(--force-update|-f)$'    { Do-Update -Force; break }
  '^(--restart|-r)$'         { exit (Restart-App) }
  '^(--help|-h|)$'           { Show-Usage; break }
  default {
    Write-Host "Unknown option: $arg"
    Show-Usage
    exit 1
  }
}
