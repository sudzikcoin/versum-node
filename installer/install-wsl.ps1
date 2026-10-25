# versum-node ADVANCED Windows installer (WSL2 + Docker Desktop) -- for GPU work later; the normal path is the
# one-click .exe from the site (no WSL, no Docker). Windows 10 (2004+) / 11. Run in PowerShell:
#   irm https://raw.githubusercontent.com/sudzikcoin/versum-node/main/installer/install-wsl.ps1 | iex
# With the key from the site (nothing to type afterwards):
#   $env:VERSUM_NODE_KEY='llk_...'; $env:VERSUM_HUB='https://launchloop.suverse.io'; irm https://raw.githubusercontent.com/sudzikcoin/versum-node/main/installer/install-wsl.ps1 | iex
#
# What it does, step by step, and stops with exact instructions when a step needs a reboot or a download:
#   1. checks Windows 10 2004+ / 11
#   2. WSL2: installs it (wsl --install) if missing -- this one needs a reboot, after which you run the line again
#   3. Docker: Docker Desktop with the WSL2 backend (winget install, or the download link); waits until it answers
#   4. installs the node INSIDE WSL (Ubuntu) with the Linux installer -- the node and every job live in Linux
#   5. registers a scheduled task that starts the node at logon (hidden window) and starts it now
#   6. opens the local page http://127.0.0.1:3311/ (WSL forwards localhost) -- pairing, share, price, pause, earnings, log
# Nothing here needs Administrator except the WSL install itself, which Windows asks for by itself.
#
# Every line it prints also goes to %LOCALAPPDATA%\versum-node\install.log (PowerShell version, execution
# policy, what was found, each step and its exit code). VERSUM_NODE_DRYRUN=1 walks the plan, writes the log
# and changes nothing. VERSUM_NODE_DIALOG=1 (set by the .exe installer) shows the stop reason in a message box.
#
# THIS FILE MUST STAY PURE ASCII: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page, where the
# UTF-8 bytes of an arrow or a check mark turn into curly quotes, which the parser treats as quotes -- the whole
# script then fails to parse and the window closes before a single line is shown (v0.3.0 did exactly that).
$ErrorActionPreference = 'Stop'
$Repo = if ($env:VERSUM_NODE_REPO) { $env:VERSUM_NODE_REPO } else { 'https://github.com/sudzikcoin/versum-node' }
$Ref = if ($env:VERSUM_NODE_VERSION) { $env:VERSUM_NODE_VERSION } else { 'main' }
$Distro = if ($env:VERSUM_WSL_DISTRO) { $env:VERSUM_WSL_DISTRO } else { 'Ubuntu' }
$Port = if ($env:VERSUM_NODE_HEALTH_PORT) { $env:VERSUM_NODE_HEALTH_PORT } else { '3311' }
$DryRun = ($env:VERSUM_NODE_DRYRUN -eq '1')
$Raw = $Repo.Replace('://github.com/', '://raw.githubusercontent.com/') + "/$Ref/install.sh"
# How to come back after a reboot: the one-liner by default; the .exe installer sets VERSUM_NODE_RERUN to its Start-menu entry.
$Rerun = if ($env:VERSUM_NODE_RERUN) { $env:VERSUM_NODE_RERUN } else { "irm $($Raw.Replace('install.sh','install.ps1')) | iex" }

# ---- log: %LOCALAPPDATA%\versum-node\install.log, appended, from the first line ----
$LogDir = if ($env:VERSUM_NODE_LOG_DIR) { $env:VERSUM_NODE_LOG_DIR } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'versum-node' } else { Join-Path $HOME '.versum-node' }
$LogFile = Join-Path $LogDir 'install.log'
try { if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null } } catch {}
function Log($m) { try { Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 } catch {} }
function Say($m) { Write-Host $m; Log $m }
function Stop-Here($m) {
  Write-Host ''; Write-Host "versum-node install: $m" -ForegroundColor Yellow
  Log "STOP: $m"; Log "log: $LogFile"
  $global:VersumNodeStop = $m
  if ($env:VERSUM_NODE_DIALOG -eq '1') { Show-Dialog ("Versum node setup stopped.`n`n$m`n`nThe log is at:`n$LogFile") }
  exit 1
}
function Show-Dialog($text) {
  try { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($text, 'Versum node setup', 'OK', 'Warning') }
  catch { try { (New-Object -ComObject WScript.Shell).Popup($text, 0, 'Versum node setup', 48) | Out-Null } catch {} }
}
# Run a native program without the 5.1 trap (stderr + ErrorActionPreference=Stop = terminating error); returns @{code; out}.
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $r = @{ code = -1; out = ''; found = $false }
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { Log "run: $exe -- not found"; return $r }
  $r.found = $true
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $raw = & $exe @arguments 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" } }
    $r.code = $LASTEXITCODE
    $r.out = (($raw | Out-String) -replace [char]0, '').Trim()
  } catch { $r.out = $_.Exception.Message; $r.code = -1 }
  finally { $ErrorActionPreference = $prev }
  Log ("run: {0} {1} -> exit {2}{3}" -f $exe, ($arguments -join ' '), $r.code, $(if ($r.out) { "`n" + $r.out } else { '' }))
  return $r
}
function Test-Admin { try { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { return $false } }

Log '----------------------------------------------------------------'
Say "versum-node -- Windows installer ($Ref)$(if ($DryRun) { '  [DRY RUN: nothing will change]' })"
Log ("powershell {0} ({1}) on {2} {3}" -f $PSVersionTable.PSVersion, $(if ($PSVersionTable.PSEdition) { $PSVersionTable.PSEdition } else { 'Desktop' }), [System.Environment]::OSVersion.VersionString, $(if ([System.Environment]::Is64BitProcess) { 'x64' } else { 'x86' }))
try { Log ("execution policy: process={0} user={1} machine={2} effective={3}" -f (Get-ExecutionPolicy -Scope Process), (Get-ExecutionPolicy -Scope CurrentUser), (Get-ExecutionPolicy -Scope LocalMachine), (Get-ExecutionPolicy)) } catch { Log "execution policy: $($_.Exception.Message)" }
Log ("user: {0} admin: {1} localappdata: {2}" -f $env:USERNAME, (Test-Admin), $env:LOCALAPPDATA)
Log ("key: {0} hub: {1} rerun: {2}" -f $(if ($env:VERSUM_NODE_KEY) { $env:VERSUM_NODE_KEY.Substring(0, [Math]::Min(8, $env:VERSUM_NODE_KEY.Length)) + '...' } else { 'none' }), $(if ($env:VERSUM_HUB) { $env:VERSUM_HUB } else { 'default' }), $Rerun)
Say "log      $LogFile"

# 1 -- Windows version
$v = [System.Environment]::OSVersion.Version
$OnWindows = ($env:OS -eq 'Windows_NT')
if ($OnWindows -and ($v.Major -lt 10 -or ($v.Major -eq 10 -and $v.Build -lt 19041))) { Stop-Here "Windows 10 build 19041 (version 2004) or newer is required; this machine has $v. Update Windows and run the installer again." }
Say "windows  $v ok"

# 2 -- WSL2
$wsl = Invoke-Native 'wsl.exe' @('--status')
$wslOk = ($wsl.found -and $wsl.code -eq 0)
if (-not $wsl.found) {
  Say 'wsl      wsl.exe is not on this machine at all.'
  if ($DryRun) { Say '         dry run: would stop here and ask you to install WSL from the Microsoft Store.' }
  else { Stop-Here "WSL (Windows Subsystem for Linux) is not installed and this Windows cannot install it by itself.`nInstall 'Windows Subsystem for Linux' from the Microsoft Store (or run 'wsl --install' in an Administrator PowerShell), reboot, then run the installer again:`n  $Rerun" }
}
elseif (-not $wslOk) {
  Say 'wsl      not installed yet. Installing WSL2 with Ubuntu -- Windows asks for Administrator permission (click Yes) and then needs a REBOOT.'
  if (-not (Test-Admin)) { Say '         (this window is not elevated; the permission prompt comes from Windows itself)' }
  if ($DryRun) { Say "         dry run: would run  wsl.exe --install -d $Distro  and stop until the reboot." }
  else {
    $r = Invoke-Native 'wsl.exe' @('--install', '-d', $Distro)
    if ($r.code -ne 0) { Stop-Here "WSL2 could not be installed (wsl --install exited $($r.code)). If Windows asked for permission and you clicked No, run the installer again and click Yes. Otherwise open an Administrator PowerShell, run  wsl --install -d $Distro , reboot, then:`n  $Rerun" }
    Stop-Here "WSL2 is being installed. Reboot, let Ubuntu finish its first start (it asks for a Linux username and password), then run the installer again:`n  $Rerun"
  }
}
if ($wslOk) {
  $l = Invoke-Native 'wsl.exe' @('-l', '-q')
  $distros = ($l.out -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  Log ("wsl distros: {0}" -f ($(if ($distros) { $distros -join ', ' } else { 'none' })))
  if (-not ($distros -contains $Distro)) {
    Say "wsl      WSL is present but $Distro is not. Installing it -- a window opens to pick a Linux username and password; close it when done."
    if ($DryRun) { Say "         dry run: would run  wsl.exe --install -d $Distro  and stop until it is set up." }
    else {
      $r = Invoke-Native 'wsl.exe' @('--install', '-d', $Distro)
      Stop-Here "finish the $Distro setup in its window (username and password), then run the installer again:`n  $Rerun"
    }
  } else { Say "wsl      $Distro ok" }
}

# 3 -- Docker (Docker Desktop with the WSL2 backend)
function Docker-Ready { $d = Invoke-Native 'docker.exe' @('info'); return ($d.found -and $d.code -eq 0) }
$pf = if ($env:ProgramFiles) { $env:ProgramFiles } else { 'C:\Program Files' }
$dd = "$pf\Docker\Docker\Docker Desktop.exe"
$dockerReady = Docker-Ready
Log ("docker: ready={0} desktop exe present={1} winget={2}" -f $dockerReady, (Test-Path $dd), [bool](Get-Command winget -ErrorAction SilentlyContinue))
if (-not $dockerReady) {
  if (Test-Path $dd) {
    Say 'docker   Docker Desktop is installed but not running -- starting it'
    if (-not $DryRun) { Start-Process $dd }
  } else {
    Say 'docker   Docker Desktop is not installed.'
    if ($DryRun) { Say '         dry run: would install it with winget (or open https://www.docker.com/products/docker-desktop/) and wait until it answers.' }
    elseif (Get-Command winget -ErrorAction SilentlyContinue) {
      Say '         installing with winget (Windows may ask to confirm)'
      $w = Invoke-Native 'winget' @('install', '-e', '--id', 'Docker.DockerDesktop', '--accept-source-agreements', '--accept-package-agreements')
      if (Test-Path $dd) { Start-Process $dd }
      else { Stop-Here "Docker Desktop is not installed and winget could not install it (exit $($w.code)).`nInstall it from https://www.docker.com/products/docker-desktop/ (keep 'Use WSL 2 based engine' on), start it once, then run the installer again:`n  $Rerun" }
    } else {
      Start-Process 'https://www.docker.com/products/docker-desktop/'
      Stop-Here "Docker Desktop is not installed.`nInstall it from https://www.docker.com/products/docker-desktop/ (keep 'Use WSL 2 based engine' on), start it once, then run the installer again:`n  $Rerun"
    }
  }
  if ($DryRun) { Say '         dry run: would wait up to 30 minutes for Docker to answer.' }
  else {
    Say '         waiting for Docker to answer (first start takes a minute; accept its terms when it asks)'
    $i = 0; while (-not (Docker-Ready)) { Start-Sleep 5; $i++; Write-Host -NoNewline '.'; if ($i -gt 360) { Stop-Here "Docker did not answer within 30 minutes. Start Docker Desktop, accept its terms, and run the installer again:`n  $Rerun" } }
    Write-Host ''
  }
}
if ($dockerReady -or -not $DryRun) { Say 'docker   answering ok (make sure Settings -> Resources -> WSL integration has your distro on)' }

# 4 -- the node inside WSL, with the Linux installer (user mode, no systemd needed)
$envLine = ''
if ($env:VERSUM_NODE_KEY) { $envLine += "VERSUM_NODE_KEY='$($env:VERSUM_NODE_KEY)' " }
if ($env:VERSUM_HUB) { $envLine += "VERSUM_HUB='$($env:VERSUM_HUB)' " }
if ($env:VERSUM_NODE_NAME) { $envLine += "VERSUM_NODE_NAME='$($env:VERSUM_NODE_NAME)' " }
$inner = "command -v curl >/dev/null || (sudo -n apt-get update -qq && sudo -n apt-get install -y -qq curl ca-certificates xz-utils) ; ${envLine}VERSUM_NODE_HEALTH_PORT=$Port sh -c `"`$(curl -fsSL $Raw)`""
Say "node     installing inside WSL ($Distro) from $Raw"
if ($DryRun) { Say "         dry run: would run  wsl.exe -d $Distro -- sh -c <linux installer>" }
else {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & wsl.exe -d $Distro -- sh -c $inner
  $code = $LASTEXITCODE; $ErrorActionPreference = $prev
  Log "run: wsl.exe -d $Distro -- sh -c <linux installer> -> exit $code"
  if ($code -ne 0) { Stop-Here "the Linux installer inside WSL did not finish (exit $code). Open '$Distro' from the Start menu and run:  curl -fsSL $Raw | sh" }
}

# 5 -- autostart: a scheduled task at logon runs the node in WSL, hidden
$task = 'Versum node'
if ($DryRun) { Say "task     dry run: would register the scheduled task '$task' (at logon, hidden, restarts) and start it" }
else {
  $action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -- sh -lc `"VERSUM_NODE_HEALTH_PORT=$Port exec ~/.versum-node/bin/versum-node start`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  Say "task     '$task' registered (starts at logon, restarts if it stops) and started"
}

# 6 -- the page
$url = "http://127.0.0.1:$Port/"
Say ''
if ($DryRun) { Say "dry run complete -- nothing was changed. The real run would open $url"; Log 'DRY RUN OK'; exit 0 }
Say 'the node is running inside WSL. Everything else happens on its local page:'
Say "  $url"
Say '  pair with your key - choose what to share - set your price - pause - earnings - log'
Start-Sleep 3
Start-Process $url
Say "stop: Stop-ScheduledTask -TaskName '$task' - remove: Unregister-ScheduledTask -TaskName '$task' -Confirm:`$false"
Log 'OK'
