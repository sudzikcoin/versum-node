# versum-node -- what the Windows installer (.exe) runs after copying the files (through setup.cmd, which keeps
# the window open and writes the log even when this file cannot run). It is a thin wrapper around install.ps1
# (the one-liner's script), with these additions:
#   1. the pairing key and the hub come from the installer's FILE NAME, so nothing is typed:
#        versum-node-setup-llk_<32 chars>.exe                          -> key, hub = default (prod)
#        versum-node-setup-llk_<32 chars>-hub-api.example.io~dev.exe   -> key + hub https://api.example.io/dev  (~ stands for /)
#        versum-node-setup-llk_<32 chars>-hub-... (1).exe              -> same (a browser's duplicate-download suffix is ignored)
#      No key in the name -> the node installs unpaired and its local page asks for the key.
#   2. the program version is pinned to the release this installer was built from (version.txt).
#   3. every step goes to %LOCALAPPDATA%\versum-node\install.log; a failure shows a message box and keeps the window.
# -DryRun walks the plan and writes the log without changing the machine. -Uninstall removes the scheduled
# task and the node inside WSL (the WSL distro itself stays). Exit codes: 0 done, 3 stopped and the reason was
# shown here; anything else means PowerShell never ran this file (setup.cmd then shows the generic message).
# THIS FILE MUST STAY PURE ASCII (see the note at the top of install.ps1).
param([string]$Source = '', [switch]$Uninstall, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$App = Join-Path $Here 'app'
$Version = (Get-Content (Join-Path $App 'version.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $Version) { $Version = 'main' }
$LogDir = if ($env:VERSUM_NODE_LOG_DIR) { $env:VERSUM_NODE_LOG_DIR } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'versum-node' } else { Join-Path $HOME '.versum-node' }
$LogFile = Join-Path $LogDir 'install.log'
try { if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null } } catch {}
function Log($m) { try { Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 } catch {} }
function Say($m) { Write-Host $m; Log $m }
function Show-Dialog($text) {
  try { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($text, 'Versum node setup', 'OK', 'Warning') }
  catch { try { (New-Object -ComObject WScript.Shell).Popup($text, 0, 'Versum node setup', 48) | Out-Null } catch {} }
}

if ($Uninstall) {
  Log 'setup.ps1 -Uninstall'
  try { Unregister-ScheduledTask -TaskName 'Versum node' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  try { & wsl.exe -- sh -lc 'rm -rf ~/.versum-node ~/.local/bin/versum-node 2>/dev/null; systemctl --user disable --now versum-node 2>/dev/null; true' } catch {}
  exit 0
}

try { $Host.UI.RawUI.WindowTitle = 'Versum node - setup' } catch {}
Log '================================================================'
Log ("setup.ps1 $Version  powershell {0} ({1})  source={2}  dryrun={3}" -f $PSVersionTable.PSVersion, $(if ($PSVersionTable.PSEdition) { $PSVersionTable.PSEdition } else { 'Desktop' }), $Source, [bool]$DryRun)
Log ("here={0} app={1} install.ps1 present={2}" -f $Here, $App, (Test-Path (Join-Path $App 'install.ps1')))
Say "versum-node setup $Version$(if ($DryRun) { '  [DRY RUN]' })"
Say "log      $LogFile"
Write-Host 'This window shows the progress. At the end your browser opens the node page; if something stops it, the reason stays here.'
Write-Host ''

# 1 -- the key and the hub, from the installer's file name
$name = if ($Source) { [System.IO.Path]::GetFileName($Source) } else { '' }
$m = [regex]::Match($name, 'llk_[0-9A-Za-z]{32}')
if ($m.Success) {
  $env:VERSUM_NODE_KEY = $m.Value
  Say 'key      found in the installer name -- the node pairs by itself'
  $h = [regex]::Match($name, '-hub-([A-Za-z0-9._~-]+)')
  if ($h.Success) { $env:VERSUM_HUB = 'https://' + $h.Groups[1].Value.Replace('~', '/'); Say "hub      $($env:VERSUM_HUB)" }
} else {
  Say "key      none in the installer name ($(if ($name) { $name } else { 'no source name' })) -- the node page will ask for it after install"
}
$env:VERSUM_NODE_VERSION = $Version
$env:VERSUM_NODE_RERUN = 'Start menu -> "Versum node setup (run again)"'
$env:VERSUM_NODE_DIALOG = '1'
if ($DryRun) { $env:VERSUM_NODE_DRYRUN = '1' }

# 2 -- the same installer the one-liner runs
$global:VersumNodeStop = $null
$failed = $null
try {
  $script = Join-Path $App 'install.ps1'
  if (-not (Test-Path $script)) { throw "install.ps1 is missing at $script (the installer files did not copy)" }
  & $script
  if ($LASTEXITCODE -ne 0) { $failed = if ($global:VersumNodeStop) { $global:VersumNodeStop } else { "install.ps1 exited $LASTEXITCODE" } }
} catch {
  $failed = $_.Exception.Message
  Log ("EXCEPTION: {0}`n{1}" -f $_.Exception.Message, $_.ScriptStackTrace)
  Show-Dialog ("Versum node setup stopped with an unexpected error.`n`n$failed`n`nThe log is at:`n$LogFile`n`nFix what it says, then Start menu -> 'Versum node setup (run again)'.")
}
if ($failed) {
  Write-Host ''
  Write-Host "setup stopped: $failed" -ForegroundColor Yellow
  Write-Host "Log: $LogFile"
  Write-Host 'Fix what it says above, then Start menu -> "Versum node setup (run again)". Press Enter to close.'
  Log 'setup.ps1 exit 3 (stopped, reason shown)'
  if (-not $env:CI) { [void](Read-Host) }
  exit 3
}
Log 'setup.ps1 exit 0'
if (-not $DryRun) { Start-Sleep 4 }
exit 0
