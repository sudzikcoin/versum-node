# versum-node — what the Windows installer (.exe) runs after copying the files. It is a thin wrapper around
# install.ps1 (the one-liner's script), with two additions:
#   1. the pairing key and the hub come from the installer's FILE NAME, so nothing is typed:
#        versum-node-setup-llk_<32 chars>.exe                          → key, hub = default (prod)
#        versum-node-setup-llk_<32 chars>-hub-api.example.io~dev.exe   → key + hub https://api.example.io/dev  (~ stands for /)
#      No key in the name → the node installs unpaired and its local page asks for the key.
#   2. the program version is pinned to the release this installer was built from (version.txt).
# -Uninstall removes the scheduled task and the node inside WSL (the WSL distro itself stays).
param([string]$Source = '', [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$App = Join-Path $Here 'app'
$Version = (Get-Content (Join-Path $App 'version.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $Version) { $Version = 'main' }

if ($Uninstall) {
  try { Unregister-ScheduledTask -TaskName 'Versum node' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  try { & wsl.exe -- sh -lc 'rm -rf ~/.versum-node ~/.local/bin/versum-node 2>/dev/null; systemctl --user disable --now versum-node 2>/dev/null; true' } catch {}
  exit 0
}

$Host.UI.RawUI.WindowTitle = 'Versum node — setup'
Write-Host "versum-node setup $Version"
Write-Host 'This window shows the progress and closes itself. At the end your browser opens the node page.'
Write-Host ''

# 1 — the key and the hub, from the installer's file name
$name = if ($Source) { [System.IO.Path]::GetFileName($Source) } else { '' }
$m = [regex]::Match($name, 'llk_[0-9A-Za-z]{32}')
if ($m.Success) {
  $env:VERSUM_NODE_KEY = $m.Value
  Write-Host 'key      found in the installer name — the node pairs by itself'
  $h = [regex]::Match($name, '-hub-([A-Za-z0-9._~-]+?)(?:\.exe)?$')
  if ($h.Success) { $env:VERSUM_HUB = 'https://' + $h.Groups[1].Value.Replace('~', '/'); Write-Host "hub      $($env:VERSUM_HUB)" }
} else {
  Write-Host 'key      none in the installer name — the node page will ask for it after install'
}
$env:VERSUM_NODE_VERSION = $Version
$env:VERSUM_NODE_RERUN = 'Start menu → "Versum node setup (run again)"'

# 2 — the same installer the one-liner runs
try {
  & (Join-Path $App 'install.ps1')
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 exited $LASTEXITCODE" }
  Start-Sleep 4
} catch {
  Write-Host ''
  Write-Host "setup stopped: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host 'Fix what it says above, then Start menu → "Versum node setup (run again)". Press Enter to close.'
  [void](Read-Host)
  exit 1
}
