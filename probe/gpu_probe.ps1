# gpu_probe.ps1 - item 3 of the GPU work: does CUDA reach a Python process INSIDE the AppContainer on this machine?
#
# Standalone: needs an installed versum-node (0.4.2 or newer: embedded Python + versum-sandbox.exe + the base
# pylib) and the GPU package set unpacked under <home>\state\pylib-gpu (0.4.4 does that when the box is ticked;
# before that, see -GpuDir to point at any folder holding torch for cp312/win_amd64, e.g. a pip --target).
# Runs probe\gpu_probe.py twice with the SAME environment the node builds for a job: once bare (the owner's token),
# once inside versum-sandbox.exe run (AppContainer, zero capabilities, Job Object). Diffs the two result.json files
# and prints the verdict the plan asks for: WORKS / BLOCKED-BY-APPCONTAINER (with the failing call) / NO-GPU.
# Writes <home>\state\gpu-probe-report.json. ASCII only on purpose (PowerShell 5.1 reads a BOM-less file as cp1252).
#
#   powershell -ExecutionPolicy Bypass -File gpu_probe.ps1 [-AppRoot <dir>] [-NodeHome <dir>] [-GpuDir <dir>] [-SkipGrant]
param(
  [string]$AppRoot = "",
  [string]$NodeHome = "",
  [string]$GpuDir = "",
  [switch]$SkipGrant
)
$ErrorActionPreference = "Stop"

function Find-AppRoot {
  if ($AppRoot) { return $AppRoot }
  foreach ($c in @("$env:LOCALAPPDATA\Programs\versum-node", "$env:LOCALAPPDATA\versum-node", "$env:ProgramFiles\versum-node")) {
    if (Test-Path (Join-Path $c "versum-sandbox.exe")) { return $c }
  }
  throw "versum-node is not installed here (no versum-sandbox.exe under LOCALAPPDATA\Programs); pass -AppRoot"
}

$root = Find-AppRoot
if (-not $NodeHome) { $NodeHome = if ($env:VERSUM_NODE_HOME) { $env:VERSUM_NODE_HOME } else { Join-Path $env:USERPROFILE ".versum-node" } }
$python = Join-Path $root "python\python.exe"
$helper = Join-Path $root "versum-sandbox.exe"
$pylib = Join-Path $NodeHome "state\pylib"
if (-not $GpuDir) { $GpuDir = Join-Path $NodeHome "state\pylib-gpu" }
$probePy = Join-Path $PSScriptRoot "gpu_probe.py"
foreach ($p in @($python, $helper, $probePy)) { if (-not (Test-Path $p)) { throw "missing: $p" } }
if (-not (Test-Path (Join-Path $GpuDir "torch"))) { throw "no torch under $GpuDir - tick 'share the GPU' on the node page first (0.4.4) or pass -GpuDir" }

Write-Host "app root : $root"
Write-Host "home     : $NodeHome"
Write-Host "gpu set  : $GpuDir"

# 1. the GPU as the node sees it
$smi = Join-Path $env:SystemRoot "System32\nvidia-smi.exe"
if (Test-Path $smi) {
  Write-Host ("nvidia-smi: " + (& $smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits))
  $cuda = (& $smi | Select-String "CUDA Version:\s*([0-9.]+)").Matches[0].Groups[1].Value
  Write-Host "CUDA (driver): $cuda"
} else { Write-Host "nvidia-smi: not in System32 (no NVIDIA driver?)" }

# 2. who may read the driver: ALL APPLICATION PACKAGES on System32\nvcuda.dll and on the DriverStore package
$aclReport = @()
$repo = Join-Path $env:SystemRoot "System32\DriverStore\FileRepository"
$dirs = @((Join-Path $env:SystemRoot "System32\nvcuda.dll"))
if (Test-Path $repo) { $dirs += (Get-ChildItem $repo -Directory | Where-Object { $_.Name -match '^nv.*\.inf_amd64_' -and ((Test-Path (Join-Path $_.FullName "nvcuda64.dll")) -or (Test-Path (Join-Path $_.FullName "nvml.dll"))) } | ForEach-Object { $_.FullName }) }
foreach ($d in $dirs) {
  $acl = (& icacls $d 2>&1) -join "`n"
  $ok = $acl -match 'ALL APPLICATION PACKAGES:\(?[^\n]*\((F|RX|R|M|[^)]*RD[^)]*|[^)]*GR[^)]*)\)' -or $acl -match 'S-1-15-2-1:'
  $aclReport += @{ dir = $d; app_packages_read = [bool]$ok }
  Write-Host ("acl      : " + $(if ($ok) { "ok  " } else { "NONE" }) + " ALL APPLICATION PACKAGES read on " + $d)
}

# 3. our folder: the same grant the node gives the base pylib
if (-not $SkipGrant) {
  Write-Host "grant    : ALL APPLICATION PACKAGES read+execute on $GpuDir (versum-sandbox.exe grant-read)"
  & $helper grant-read --dir $GpuDir
  if ($LASTEXITCODE -ne 0) { throw "grant-read failed ($LASTEXITCODE)" }
}

# 4. one job directory per run, built like lib/native.mjs does (in/, out/, tmp/), the probe copied into in/
function New-JobDir($tag) {
  $d = Join-Path $NodeHome ("jobs\gpu-probe-" + $tag + "-" + (Get-Date -Format "yyyyMMddHHmmss"))
  New-Item -ItemType Directory -Force (Join-Path $d "in") | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $d "out") | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $d "tmp") | Out-Null
  Copy-Item $probePy (Join-Path $d "in\gpu_probe.py")
  return $d
}

# the environment lib/native.mjs nativeEnv() + lib/pylib-gpu.mjs gpuJobEnv() build: nothing of the user's, torch\lib on PATH and as CUDA_PATH
function Job-Env($jobDir, $mode) {
  $tmp = Join-Path $jobDir "tmp"
  $torchLib = Join-Path $GpuDir "torch\lib"
  return @{
    SYSTEMROOT = $env:SystemRoot; WINDIR = $env:SystemRoot
    PATH = (Join-Path $root "python") + ";" + $torchLib; PATHEXT = ".EXE;.BAT;.CMD"
    TEMP = $tmp; TMP = $tmp; USERPROFILE = $tmp; HOMEDRIVE = $tmp.Substring(0, 2); HOMEPATH = $tmp.Substring(2)
    LOCALAPPDATA = $tmp; APPDATA = $tmp; NUMBER_OF_PROCESSORS = "$env:NUMBER_OF_PROCESSORS"
    PROCESSOR_ARCHITECTURE = $env:PROCESSOR_ARCHITECTURE
    VERSUM_JOB_DIR = $jobDir; VERSUM_JOB_IN = (Join-Path $jobDir "in"); VERSUM_JOB_OUT = (Join-Path $jobDir "out")
    PYTHONIOENCODING = "utf-8"; PYTHONDONTWRITEBYTECODE = "1"; PYTHONNOUSERSITE = "1"; PYTHONUNBUFFERED = "1"; PYTHONUTF8 = "1"
    PYTHONPATH = $GpuDir + ";" + $pylib
    CUDA_PATH = $torchLib
    VERSUM_PROBE_MODE = $mode
  }
}

function Run-WithEnv($exe, $argv, $envMap, $cwd) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = ($argv | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join " "
  $psi.WorkingDirectory = $cwd
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables.Clear()
  foreach ($k in $envMap.Keys) { $psi.EnvironmentVariables[$k] = [string]$envMap[$k] }
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd(); $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  return @{ code = $p.ExitCode; out = $out; err = $err }
}

$pyArgs = @("-s", "-B", "-u", "-X", "utf8")

# 5a. bare: the owner's token, same environment - the baseline
$bareDir = New-JobDir "bare"
Write-Host ""; Write-Host "=== BARE (owner token) ==="
$bare = Run-WithEnv $python ($pyArgs + @((Join-Path $bareDir "in\gpu_probe.py"))) (Job-Env $bareDir "bare") $bareDir
Write-Host $bare.out; if ($bare.err) { Write-Host $bare.err }
$bareResult = Get-Content (Join-Path $bareDir "out\result.json") -Raw | ConvertFrom-Json

# 5b. AppContainer: versum-sandbox.exe run, the helper inherits OUR environment, so it is set on this process first
$acDir = New-JobDir "appcontainer"
Write-Host ""; Write-Host "=== APPCONTAINER (versum-sandbox.exe run) ==="
$name = "versum-gpuprobe-" + ([guid]::NewGuid().ToString("N"))
$meta = Join-Path $NodeHome "state\gpu-probe-meta.json"
$cores = [int]$env:NUMBER_OF_PROCESSORS
$acArgs = @("run", "--name", $name, "--dir", $acDir, "--memory-mb", "8192", "--cpu-cores", "$cores", "--timeout-s", "900", "--meta", $meta, "--", $python) + $pyArgs + @((Join-Path $acDir "in\gpu_probe.py"))
$ac = Run-WithEnv $helper $acArgs (Job-Env $acDir "appcontainer") $acDir
Write-Host $ac.out; if ($ac.err) { Write-Host $ac.err }
& $helper delete --name $name | Out-Null
$acResult = $null
if (Test-Path (Join-Path $acDir "out\result.json")) { $acResult = Get-Content (Join-Path $acDir "out\result.json") -Raw | ConvertFrom-Json }

# 6. the verdict
Write-Host ""; Write-Host "=== VERDICT ==="
$verdict = ""
if (-not $bareResult.nvcuda.ok -and $bareResult.verdict -eq "no_gpu") { $verdict = "NO-GPU: no CUDA device on this machine (bare: " + $bareResult.nvcuda.error + ")" }
elseif (-not $bareResult.torch.ok) { $verdict = "GPU-SET-BROKEN: torch fails even bare - " + $bareResult.torch.error }
elseif ($null -eq $acResult) { $verdict = "BLOCKED-BY-APPCONTAINER: the sandboxed interpreter wrote no result at all (exit " + $ac.code + ") - see stderr above (0xC0000135 = a DLL it may not read)" }
elseif ($acResult.torch.ok) { $verdict = "WORKS: torch.cuda.is_available() True and a 2048x2048 matmul ran on " + $acResult.torch.device + " inside the AppContainer (" + $acResult.torch.matmul_ms + " ms)" }
else {
  $first = if (-not $acResult.nvcuda.ok) { "nvcuda: " + $acResult.nvcuda.error } else { "torch: " + $acResult.torch.error }
  $verdict = "BLOCKED-BY-APPCONTAINER: bare passes, inside the container the first failing call is " + $first + " -> fall back to the restricted Job Object (docs/gpu-native.md, section 3b)"
}
Write-Host $verdict
foreach ($k in @("nvcuda", "torch", "cupy", "numba")) {
  $b = $bareResult.$k.ok; $a = if ($acResult) { $acResult.$k.ok } else { $false }
  Write-Host ("  {0,-7} bare {1,-5} appcontainer {2,-5} {3}" -f $k, $b, $a, $(if (-not $a -and $acResult) { $acResult.$k.error } else { "" }))
}

$report = @{ at = (Get-Date).ToUniversalTime().ToString("o"); verdict = $verdict; acl = $aclReport; bare = $bareResult; appcontainer = $acResult; appcontainer_exit = $ac.code; appcontainer_stderr = $ac.err }
$reportPath = Join-Path $NodeHome "state\gpu-probe-report.json"
$report | ConvertTo-Json -Depth 6 | Set-Content -Path $reportPath -Encoding UTF8
Write-Host "report   : $reportPath"
Remove-Item -Recurse -Force $bareDir, $acDir -ErrorAction SilentlyContinue
if ($verdict.StartsWith("WORKS")) { exit 0 } elseif ($verdict.StartsWith("NO-GPU")) { exit 2 } else { exit 1 }
