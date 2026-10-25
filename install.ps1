# versum-node installer — Windows 10 (2004+) / 11. Run in PowerShell:
#   irm https://raw.githubusercontent.com/sudzikcoin/versum-node/main/install.ps1 | iex
# With the key from the site (nothing to type afterwards):
#   $env:VERSUM_NODE_KEY='llk_…'; $env:VERSUM_HUB='https://launchloop.suverse.io'; irm https://raw.githubusercontent.com/sudzikcoin/versum-node/main/install.ps1 | iex
#
# What it does, step by step, and stops with exact instructions when a step needs a reboot or a download:
#   1. checks Windows 10 2004+ / 11 and that virtualization is on
#   2. WSL2: installs it (wsl --install) if missing — this one needs a reboot, after which you run the line again
#   3. Docker: Docker Desktop with the WSL2 backend (winget install, or the download link); waits until it answers
#   4. installs the node INSIDE WSL (Ubuntu) with the Linux installer — the node and every job live in Linux
#   5. registers a scheduled task that starts the node at logon (hidden window) and starts it now
#   6. opens the local page http://127.0.0.1:3311/ (WSL forwards localhost) — pairing, share, price, pause, earnings, log
# Nothing here needs Administrator except the WSL install itself, which Windows asks for by itself.
$ErrorActionPreference = 'Stop'
$Repo = if ($env:VERSUM_NODE_REPO) { $env:VERSUM_NODE_REPO } else { 'https://github.com/sudzikcoin/versum-node' }
$Ref = if ($env:VERSUM_NODE_VERSION) { $env:VERSUM_NODE_VERSION } else { 'main' }
$Distro = if ($env:VERSUM_WSL_DISTRO) { $env:VERSUM_WSL_DISTRO } else { 'Ubuntu' }
$Port = if ($env:VERSUM_NODE_HEALTH_PORT) { $env:VERSUM_NODE_HEALTH_PORT } else { '3311' }
$Raw = $Repo.Replace('://github.com/', '://raw.githubusercontent.com/') + "/$Ref/install.sh"
function Say($m) { Write-Host $m }
function Stop-Here($m) { Write-Host ''; Write-Host "versum-node install: $m" -ForegroundColor Yellow; exit 1 }
# How to come back after a reboot: the one-liner by default; the .exe installer sets VERSUM_NODE_RERUN to its Start-menu entry.
$Rerun = if ($env:VERSUM_NODE_RERUN) { $env:VERSUM_NODE_RERUN } else { "irm $($Raw.Replace('install.sh','install.ps1')) | iex" }

Say 'versum-node — Windows installer'
# 1 — Windows version
$v = [System.Environment]::OSVersion.Version
if ($v.Major -lt 10 -or ($v.Major -eq 10 -and $v.Build -lt 19041)) { Stop-Here "Windows 10 build 19041 (2004) or newer is required (found $v)" }
Say "windows  $v ✓"

# 2 — WSL2
$wslOk = $false
try { $st = (& wsl.exe --status 2>$null | Out-String); if ($LASTEXITCODE -eq 0 -and $st) { $wslOk = $true } } catch {}
if (-not $wslOk) {
  Say 'wsl      not installed. Installing WSL2 with Ubuntu — Windows will ask for Administrator and then needs a REBOOT.'
  & wsl.exe --install -d $Distro
  Stop-Here "WSL2 is being installed. Reboot, let Ubuntu finish its first start (it asks for a Linux username and password), then run the installer again:`n  $Rerun"
}
$distros = (& wsl.exe -l -q 2>$null | Out-String) -split "`r?`n" | ForEach-Object { $_.Trim([char]0, ' ') } | Where-Object { $_ }
if (-not ($distros -contains $Distro)) {
  Say "wsl      WSL is present but $Distro is not. Installing it — a window opens to pick a Linux username and password; close it when done."
  & wsl.exe --install -d $Distro
  Stop-Here "finish the $Distro setup in its window, then run the installer again: $Rerun"
}
Say "wsl      $Distro ✓"

# 3 — Docker (Docker Desktop with the WSL2 backend)
function Docker-Ready { try { & docker.exe info *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false } }
if (-not (Docker-Ready)) {
  $dd = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $dd) { Say 'docker   Docker Desktop is installed but not running — starting it'; Start-Process $dd }
  else {
    Say 'docker   Docker Desktop not found.'
    if (Get-Command winget -ErrorAction SilentlyContinue) { Say '         installing with winget (Windows may ask to confirm)'; & winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements; if (Test-Path $dd) { Start-Process $dd } }
    else { Say '         download it: https://www.docker.com/products/docker-desktop/  (keep "Use WSL 2 based engine" on)'; Start-Process 'https://www.docker.com/products/docker-desktop/' }
  }
  Say '         waiting for Docker to answer (first start takes a minute; accept its terms when it asks)'
  $i = 0; while (-not (Docker-Ready)) { Start-Sleep 5; $i++; Write-Host -NoNewline '.'; if ($i -gt 360) { Stop-Here "Docker did not answer within 30 minutes — start Docker Desktop and run the installer again: $Rerun" } }
  Write-Host ''
}
Say 'docker   answering ✓ (make sure Settings → Resources → WSL integration has your distro on)'

# 4 — the node inside WSL, with the Linux installer (user mode, no systemd needed)
$envLine = ''
if ($env:VERSUM_NODE_KEY) { $envLine += "VERSUM_NODE_KEY='$($env:VERSUM_NODE_KEY)' " }
if ($env:VERSUM_HUB) { $envLine += "VERSUM_HUB='$($env:VERSUM_HUB)' " }
if ($env:VERSUM_NODE_NAME) { $envLine += "VERSUM_NODE_NAME='$($env:VERSUM_NODE_NAME)' " }
Say "node     installing inside WSL ($Distro) from $Raw"
& wsl.exe -d $Distro -- sh -c "command -v curl >/dev/null || (sudo -n apt-get update -qq && sudo -n apt-get install -y -qq curl ca-certificates xz-utils) ; ${envLine}VERSUM_NODE_HEALTH_PORT=$Port sh -c `"`$(curl -fsSL $Raw)`""
if ($LASTEXITCODE -ne 0) { Stop-Here "the Linux installer inside WSL did not finish (exit $LASTEXITCODE). Open '$Distro' from the Start menu and run:  curl -fsSL $Raw | sh" }

# 5 — autostart: a scheduled task at logon runs the node in WSL, hidden
$task = 'Versum node'
$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -- sh -lc `"VERSUM_NODE_HEALTH_PORT=$Port exec ~/.versum-node/bin/versum-node start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $task
Say "task     '$task' registered (starts at logon, restarts if it stops) and started"

# 6 — the page
$url = "http://127.0.0.1:$Port/"
Say ''
Say 'the node is running inside WSL. Everything else happens on its local page:'
Say "  $url"
Say '  pair with your key · choose what to share · set your price · pause · earnings · log'
Start-Sleep 3
Start-Process $url
Say "stop: Stop-ScheduledTask -TaskName '$task' · remove: Unregister-ScheduledTask -TaskName '$task' -Confirm:`$false"
