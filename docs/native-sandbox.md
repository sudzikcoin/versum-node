# The native sandbox — script jobs on Windows and macOS without Docker (v0.4.0)

**What the owner does:** downloads one file from the site, double-clicks it, the node page opens. No WSL, no
Docker Desktop, no reboot, no terminal, no administrator prompt. The installer is under 100 MB and the node
takes about 250 MB on disk (a single Node.js binary, an embedded Python 3.12, the helper). A laptop with
1.5 GB free is fine.

## What runs where

| | Linux | Windows | macOS |
|---|---|---|---|
| Node program | `node bin/versum-node.mjs` (install.sh) or the same code | `versum-node.exe` — one binary (Node.js single executable application, `scripts/build-sea.mjs`) | `versum-node` — one binary per architecture (arm64, x64) |
| Where | `/var/lib/versum-node` (root) or `~/.versum-node` | `%LOCALAPPDATA%\versum-node` | `~/.versum-node/app` |
| Autostart | systemd unit (system or user) | Startup-folder shortcut → `wscript.exe launch.vbs` (hidden) | launchd agent `io.suverse.versum-node` |
| Python for script jobs | the hub's pinned image `ghcr.io/sudzikcoin/versum-python@sha256:…` inside a container | `python\python.exe` from python-build-standalone 3.12 (`packaging/versions.json`, sha256 pinned) | `python/bin/python3`, same source |
| Isolation | fresh rootless Podman/Docker container, `containerArgs()` posture | **AppContainer** + Job Object (`versum-sandbox.exe`) | **Seatbelt** (`/usr/bin/sandbox-exec`) + ulimit + nice |
| Job kinds | `python`, `container`; GPU and network when shared | `python` only (`executor_kind: script_native`) | `python` only |
| Uninstall | remove the unit and the directory | Settings → Apps → Versum node | `~/.versum-node/app/uninstall.sh` |

The hub stores `executor_kind` per node (`node_resources.executor_kind`, reported in every scan) and
`pieces_for_node()` offers a `script_native` node only `python` pieces without GPU and without network.
The node refuses anything else anyway (`fitsNative`), releasing the piece with `reason_code: capacity`.

Container-image jobs stay Linux-only. Docker Desktop (Windows: through WSL2) remains an *advanced* path
(`runtime: docker` in the config, or `VERSUM_NODE_RUNTIME=docker`) for GPU work later; `installer/install-wsl.ps1`
is that path's installer and is not what the .exe runs.

## Isolation guarantees, per OS

### Windows — AppContainer + Job Object (`packaging/windows/sandbox/Sandbox.cs`)
For every attempt `versum-sandbox.exe run …`:
1. `CreateAppContainerProfile("versum-job-<attempt>")` with **zero capabilities**. The interpreter runs with a
   low-box token whose package SID may touch only what is explicitly granted to it or to *ALL APPLICATION
   PACKAGES* (the Windows system directories, read-only).
   - **No network**: without `internetClient` / `privateNetworkClientServer` an AppContainer cannot open any
     socket — not to the internet, not to the LAN, **not to loopback**. Enforced by the kernel's network
     isolation, not by a firewall rule the job could race.
   - **No user files**: `%USERPROFILE%`, the node's config (`home\config.json` with the key), Documents, other
     jobs — not readable, not listable. Only the attempt's directory is granted (full control, inheritable)
     and the Python tree (read + execute, granted once to ALL APPLICATION PACKAGES).
   - **No other processes**: an AppContainer cannot open handles to processes outside its package, cannot
     inject, cannot read the clipboard, cannot write the registry outside its own hive.
2. A Job Object with `JOB_OBJECT_LIMIT_JOB_MEMORY` (= `limits.ram_mb`), `ACTIVE_PROCESS = 64`, CPU rate
   **hard cap** (= `limits.cpu_cores / machine cores`), `DIE_ON_UNHANDLED_EXCEPTION`, and
   `KILL_ON_JOB_CLOSE`: if the helper or the node dies, every process of the job dies with it.
3. The process is created suspended with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, assigned to the job,
   then resumed. Environment = what the node built (`nativeEnv`): `PATH` = the Python tree, every temp/home
   variable inside the attempt's directory, the buyer's `env`, the `VERSUM_*` facts. Nothing of the user's.
4. The helper writes `{cpu_seconds, peak_memory_mb, processes}` every second from the job's accounting
   (the node's cpu evidence beside the hub's clock); at the time limit it `TerminateJobObject`s (exit 124).
5. After the directory is wiped the node deletes the profile (`delete --name`); the uninstaller deletes any
   left in `home\state\appcontainers.txt`.

What `sandbox-check` / the CI probe verifies on the real runner: connect to 1.1.1.1:443 → refused; DNS →
refused; 127.0.0.1:3311 (the node's own page!) → refused; `os.listdir("C:\\Users")` → denied; a write to
`C:\Users\Public` → denied; `out\result.json` → written; `TEMP`/`USERPROFILE` → inside the job.

### macOS — Seatbelt profile (`sandboxProfile()` in `lib/native.mjs`)
`sandbox-exec -f <profile>` where the profile is generated per attempt:
- `(deny default)` then only: `process-fork`, `process-exec` **inside the Python tree**, `signal` to the same
  sandbox, `sysctl-read`, POSIX semaphores/shm (multiprocessing), three mach services (logger, libinfo,
  SecurityServer), `file-read-metadata` (stat), read of `/usr`, `/bin`, `/System`, `/private/etc`, time zone,
  dyld cache, `/dev`; write to `/dev/null`, `/dev/zero`, `/dev/tty`.
- `/Users`, `/Volumes`, `/Library` and the owner's home are **not listed and not allowed**, so deny-default keeps
  them shut (no file contents, no directory listings); the data volume is denied again by its firmlink path
  (`/System/Volumes/Data`) so that spelling cannot stand in for `/Users`. The only two trees opened are the
  Python tree (read + execute) and the attempt's directory (read + write). The job's working directory is set
  to the attempt's directory, so `getcwd()` resolves without reading any parent.
- `(deny network*)`: no sockets of any family, no DNS, no loopback.
- The job runs through `/bin/sh -c 'ulimit -t <cpu seconds> -f <blocks>; exec nice -n 10 sandbox-exec …'`
  in its own process group. CPU seconds are a hard kernel cap (time limit × cores + 30 s), a single file is
  capped at `limits.disk_mb`, priority is lowered so the owner's own work comes first.
- The node polls `ps -axo pgid=,rss=,cputime=` every second: the group's RSS over `limits.ram_mb` → the whole
  group is killed; cpu seconds are reported. The job directory's size is measured every 5 s (both OSes):
  over `limits.disk_mb` → killed.

### Both
- The time limit (`limits.time_limit_minutes`) kills; a stall (no output, no cpu movement for 15 min) kills;
  the attempt's directory is deleted afterwards, always, even on failure (`runner.mjs`).
- The manifest cannot name a host path, a mount, a device, a capability or an interpreter flag: the node
  builds the argv itself (`nativeCommand`: `python -E -s -B -u -X utf8 <script> …`, `/job/...` mapped into
  the attempt's directory) and the environment itself (`nativeEnv`).
- The node's own key never enters the sandbox: the config lives outside the granted/allowed paths and the
  job's environment is built from scratch.

## Honest gaps

- **Not signed, not notarized.** Windows SmartScreen and macOS Gatekeeper warn once; the site documents the
  two clicks. Code signing is a certificate purchase, not code.
- **Windows arm64**: the installer is x64 only. Windows on ARM runs it through emulation if at all; untested.
- **macOS memory limit is a poll, not a kernel cap.** A job that allocates faster than once per second can
  overshoot `limits.ram_mb` briefly before it is killed. (RLIMIT_AS is not enforced by macOS.) On Windows the
  Job Object limit is a kernel cap.
- **macOS CPU share is `nice`, not a quota.** `limits.cpu_cores` is enforced as a total cpu-seconds budget
  (`ulimit -t`), not as a rate; a job can use every core for a while, at low priority. Windows has a hard rate cap.
- **macOS process-group escape.** A job that calls `setsid()` leaves the group the node kills. It stays
  inside the Seatbelt profile (no network, nowhere to write once the directory is gone) and inside the
  `ulimit -t` budget, so it cannot do harm, only burn cpu until the budget ends. Windows has none of this: the
  Job Object holds every descendant.
- **Disk is a soft limit** on both (no quota without administrator rights): measured every 5 s, killed when
  over, outputs over the cap not uploaded. A job can write faster than that for five seconds.
- **No GPU, no network, no container images** on native nodes — by design in v0.4.0; those jobs go to
  Linux nodes. The WSL2 + Docker Desktop path (`installer/install-wsl.ps1`) is kept for GPU work later.
- **The Seatbelt profile language is undocumented by Apple** (`sandbox-exec` is marked deprecated but ships
  in every macOS through 15 and is what Chrome, Safari helpers and `xcodebuild` use). Each release's CI run on
  `macos-latest` is the regression test; a future macOS could change a path the profile allows (e.g. where the
  dyld cache lives) and the probe would catch it.
- **The stdout/stderr of the job pass through the helper** (Windows) — a job can print anything, including
  lines that look like the helper's `[sandbox]` lines; the node only *logs* those, it never acts on them.
- **The Intel (x64) build's sandbox is unverified on real Intel hardware.** GitHub's macOS runners are all Apple
  silicon, so CI only loads the x64 binary under Rosetta (which proves it runs) — it does not run the Seatbelt
  probe under Rosetta, because translated x86_64 processes need Rosetta's own runtime paths that the profile
  denies. The sandbox code is identical to arm64's (which is fully probed each release); a buyer on an Intel Mac
  gets the same profile, but it has not been exercised on an Intel kernel in CI. Running the Intel build under
  Rosetta on an Apple-silicon Mac (the wrong download) will have its jobs killed by the sandbox — pick the
  Apple-silicon dmg there.
- **CI runners are not laptops.** `windows-latest` and `macos-latest` have Docker/WSL *installed*; the e2e
  does not use them (the node's runtime order puts the native sandbox first and the e2e asserts
  `executor_kind: script_native` + `sandbox: appcontainer|seatbelt`), but a true "clean image" is the user's
  machine. Also: the macOS runner is Apple silicon; the Intel build is tested there under Rosetta
  (`sandbox-check`), not on an Intel Mac.
