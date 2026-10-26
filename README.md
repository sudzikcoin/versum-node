# versum-node

Share your computer's spare compute with the Versum network and get paid per minute, in USDC on Base.

You install one program. It looks at what the machine has (CPU cores, RAM, GPU, disk, type of
connection), you choose how much of it to share, when, and at what price per minute. Buyers' scripts
run inside a sandbox that is wiped when the job ends. The node never advertises "skills": it offers
resources and time, nothing else.

**Current release: v0.4.6** (2026-10-26). Windows 10/11 and macOS 12+ get a one-click installer; Linux
gets a one-line installer. Alpha: the first live job went end to end on 2026-10-25, and every release
is proven on clean GitHub runners (install, pair, run a job inside the sandbox, update itself, uninstall)
before it is published.

## Install

### Windows and macOS: one download, one double-click

On the site, **Connect a computer** (`https://launchloop.suverse.io/connect`) → **Download for Windows**
or **Download for macOS**. The pairing key is inside the file name
(`versum-node-setup-llk_….exe`, `Versum-Node-arm64-llk_….dmg`), so nothing has to be typed.
Double-click it. The node installs under your own account, starts, pairs, and opens its local page.

- No administrator prompt, no WSL, no Docker, no Node.js, no reboot. The installer is under 100 MB;
  the node takes about 250 MB on disk (one binary, an embedded Python 3.12, the sandbox helper).
- The installers are not code-signed: Windows SmartScreen says "Windows protected your PC" → *More
  info* → *Run anyway*; macOS Gatekeeper wants a right-click → *Open* (Sequoia: System Settings →
  Privacy & Security → *Open Anyway*). The site shows these two clicks.
- Apple silicon and Intel Macs get different images; `/connect` picks the right one.

Details, logs and uninstall: [docs/installers.md](docs/installers.md).

### Linux: one line

```bash
# as root on a server: a dedicated user `versum` and a system service are created; as a user: a user unit with linger
curl -fsSL https://raw.githubusercontent.com/sudzikcoin/versum-node/main/install.sh | VERSUM_HUB='https://launchloop.suverse.io' VERSUM_NODE_KEY='llk_…' sh
```

The line checks the OS, finds or downloads Node.js ≥ 20 (checksum verified), finds rootless Podman or
Docker, downloads this repository, installs a systemd unit that starts at boot, starts the node and
prints the local page's address. Without the two variables it installs an unpaired node whose page asks
for the key. Read it before you run it: [install.sh](install.sh) → [installer/install.sh](installer/install.sh).

### Versions and updates

| Version | What it brought | Updates itself? |
|---|---|---|
| 0.4.0 | Windows/macOS without Docker: single binary, embedded Python, OS sandbox | no |
| 0.4.1 | one script contract on every runtime (`VERSUM_JOB_IN` / `VERSUM_JOB_OUT`) | no |
| 0.4.2 | the standard Python packages downloaded and verified on first start | no |
| 0.4.3 | **self-update**: the node hears about releases on the heartbeat and swaps itself when idle | yes |
| 0.4.4 | GPU on native Windows nodes: detection, the cu128 wheel set, the in-sandbox probe, a GPU price | yes |
| 0.4.5 | "Name this computer" on the local page (the name reaches the hub) | yes |
| 0.4.6 | a fresh node shares **half** the machine by default; the restricted-token sandbox for GPU jobs when the AppContainer blocks the driver is built but ships OFF (`gpu_jobobject_fallback: true` opts in; see docs/gpu-native.md 3b) | yes |

From 0.4.3 on, an installed Windows or macOS node updates itself: every heartbeat answer names the
newest release and the sha256 of this platform's update bundle; the node downloads it in the background,
checks the hash, starts the new binary once to hear its version, stops taking new jobs, swaps the program
when nothing runs, and rolls back if the new program does not come up. **The key, the settings, the name,
the price and the downloaded Python packages stay.** How it works: [docs/self-update.md](docs/self-update.md).

**Nodes on 0.4.0, 0.4.1 or 0.4.2 cannot update themselves.** Those versions ignore the heartbeat answer
and have no update code; nothing the hub sends can change the program on disk. Each of them needs **one
manual reinstall** with the current installer from `/connect`. That reinstall is the last one done by
hand. A Linux node installed from this repository runs from source and does not swap itself either:
`git pull` (or run the install line again) updates it.

**`http://127.0.0.1:3311/`** is the node's local page, reachable from that machine only. Everything an
owner does happens there: pair with the key, name the computer, choose what to share, set the price per
minute next to the market hint, choose hours, pause and resume, see the runtime, earnings and the log.

### The command line, if you prefer it

```bash
versum-node scan                                   # what this machine has (nothing is sent)
versum-node pair llk_… --hub=https://launchloop.suverse.io
versum-node offer --cpu=4 --ram-gb=8 --price=0.02  # what you share, and your price per minute
versum-node offer --windows="Mon-Fri 22:00-07:00, Sat-Sun 00:00-24:00"   # when (default: always)
versum-node start                                  # the service runs this; `versum-node open` shows the page
versum-node status · on · off · doctor · gpu-check · prune
```

## How jobs run

A job is a buyer's Python script (composed on the hub from the buyer's words, or written by the buyer)
with its input files. Where it runs depends on the OS:

| | Linux | Windows | macOS |
|---|---|---|---|
| Isolation | a fresh rootless Podman/Docker container: user namespace, read-only root, all capabilities dropped, `no-new-privileges`, cpu/memory/pids limits | **AppContainer** with zero capabilities + a **Job Object** (memory cap, hard CPU rate cap, 64 processes, kill on close) | **Seatbelt** (`sandbox-exec`, deny by default) + `ulimit -t` / `ulimit -f` + `nice` |
| Python | the hub's pinned image `ghcr.io/sudzikcoin/versum-python@sha256:…` | embedded Python 3.12 (python-build-standalone, sha256-pinned) | the same |
| Job kinds | `python`, `container`; GPU and network when shared | `python` (`executor_kind: script_native`); GPU after "share the GPU" | `python` only |
| Network inside the job | none, unless the buyer asks **and** you allow it (then a logged proxy, 443/80, LAN denied) | **none, ever** — not even loopback | **none, ever** |

**Python packages on a native node (0.4.2).** The embedded Python ships nothing. On the first start after
an install the node downloads the standard image's package set as 18 wheels from PyPI (numpy, pandas,
pillow, requests, pypdf, openpyxl, python-docx and their dependencies, the same pinned versions the Linux
image has), checks every file's sha256 against `pylib-lock.json` shipped with the release, unpacks them
with its own interpreter and puts the folder on `PYTHONPATH` for jobs. The page says "preparing Python
packages, 60 MB (n of 18)"; the heartbeat reports `python_packages: ok | pending | failed`, and the hub
offers python jobs to a native node only once it says `ok`.

**The script contract, every runtime (0.4.1).** A job reads its inputs from the directory named by
`VERSUM_JOB_IN` and writes its results into `VERSUM_JOB_OUT`. In a Linux container those are `/job/in`
and `/job/out`; on a Windows or macOS node they are the `in/` and `out/` folders of the attempt's own
directory, which is also the working directory. A script written as
`os.environ.get('VERSUM_JOB_OUT', '/job/out')` runs everywhere; one that hard-codes `/job/out` dies on a
native node. The hub's composer writes scripts this way.

**What a job never gets, on any OS:** your files (only its own attempt directory, deleted afterwards),
your network (see the table), your other programs, the node's key or environment (the job's environment
is built from scratch: the buyer's variables plus the `VERSUM_*` ids and paths). The manifest the hub
sends has no field for mounts, devices, capabilities or runtime flags; the node builds the command itself
([lib/manifest.mjs](lib/manifest.mjs), [lib/native.mjs](lib/native.mjs)). The time limit kills, a stall
(no output and no CPU movement for 15 minutes) kills, and the attempt's directory is deleted always,
even on failure.

**Container-image jobs, GPU-through-a-container jobs and jobs that need the network are Linux-only.**
Docker Desktop on Windows/macOS is still an advanced path (`runtime: docker` in the config) and is not
what the one-click installer sets up.

The per-OS isolation tables, what the CI probe verifies on every release and the honest list of what the
sandboxes do not do: [docs/native-sandbox.md](docs/native-sandbox.md). Threat model:
[docs/threat-model.md](docs/threat-model.md). The exact list of what the node reads, writes and sends:
[docs/what-the-node-touches.md](docs/what-the-node-touches.md).

## GPU on a native Windows node (0.4.4)

- **Detection.** The scan asks `nvidia-smi` (shipped inside the NVIDIA driver) for the GPU's name, VRAM,
  driver and the driver's CUDA version, and reports a `gpu` block on every heartbeat. A machine without a
  GPU, an AMD GPU, or an NVIDIA GPU without a CUDA driver hides the GPU box on the local page and says why.
  macOS has no NVIDIA driver; nothing runs there.
- **"share the GPU".** Ticking the box on an NVIDIA machine with driver CUDA ≥ 12.8 downloads the GPU
  wheel set beside the standard packages: `cu128`, 14 wheels, **2.8 GB** (torch 2.9.1+cu128 with the CUDA
  runtime it bundles, cupy, numba and their dependencies), pinned in `pylib-gpu-lock.json`, sha256-checked,
  resumable. `gpu_packages: pending | ok | failed` on the heartbeat and on the page.
- **The probe.** The node runs `probe/gpu_probe.py` on itself: once with the owner's token and once
  **inside the real AppContainer**, first the driver stage (`nvcuda.dll`, `cuInit`, a context) on first
  start, then the torch stage (a matmul on the device) once the set is in. The verdict goes to the hub as
  `gpu_probe: appcontainer_ok | jobobject_ok | blocked | no_gpu` and to the page as "GPU in the sandbox: works |
  works in restricted-token mode | blocked".
- **If the AppContainer blocks the driver (0.4.6, OFF by default).** With `gpu_jobobject_fallback: true` in
  config.json the probe runs its sandboxed half once more through `versum-sandbox.exe run --mode jobobject`: the same Job Object around a **restricted, low-integrity token**
  (restricting SIDs RESTRICTED + the session's logon SID, so it sees the system directories, the Python tree, the
  package folders, its job directory and the desktop, and nothing of yours) with the interpreter blocked outbound by a firewall rule — the one step that needs
  administrator rights, once; Windows asks when the verdict first comes back `jobobject_ok`. GPU jobs then run in
  that mode; CPU jobs stay in the AppContainer. It ships off because on the release runner the restricted-token
  process dies at start (`0xC0000142`, STATUS_DLL_INIT_FAILED) — the gap and what is proven: `docs/gpu-native.md` 3b.
  The hub leases GPU pieces to a native node only with `gpu_packages = ok` **and** `gpu_probe =
  appcontainer_ok` or `jobobject_ok`. `versum-node gpu-check` runs it by hand (exit 0 works, 1 blocked, 2 no GPU).
- **A separate price.** The page takes a price per GPU minute; the default suggestion and the hub's
  fallback when none is set is 5 × the CPU price. The rate is snapshotted at lease.

**Open question: does the Windows AppContainer admit CUDA?** Nothing public says whether the driver's
kernel-mode door accepts a low-box token, GitHub has no GPU runners for a user account, and no machine
with an NVIDIA GPU has run 0.4.4 yet (the one RTX machine on the network runs 0.4.0 and needs the manual
reinstall above). CI proves the no-GPU side only: the probe runs inside the AppContainer on the runner
and reports `no_gpu`. The answer arrives on the first real NVIDIA machine's heartbeat; if it is `blocked`,
the fallback design is written in [docs/gpu-native.md](docs/gpu-native.md) and not built.

## The local page

- **What you share** — CPU cores, RAM and disk sliders (0.4.6 default on a fresh node: half the cores, half
  the RAM, the smaller of 1 GB and half the free disk; before 0.4.6: everything the scan found), the GPU box
  (shown only on an NVIDIA machine with a CUDA driver, or on a Linux container node), "jobs may use the
  internet" (Linux only; off by default), parallel jobs (default 1), the longest job you accept (default
  240 minutes), hours (default: always), a laptop that may vanish mid-job (`mobility`).
- **Price** per minute, next to the **market hint** read from the hub's public capacity board: "market
  now: 3 nodes online, from $0.0100/min, typical $0.0200/min — a reference, not a rate". A GPU price
  field on an NVIDIA machine.
- **Name this computer** (0.4.5) — prefilled from a chosen hostname ("HP-Laptop" → "HP Laptop") or, for a
  factory hostname, the CPU family ("Ryzen 7 PC", "Apple M2 Pro Mac"); saved with the offer and sent to the
  hub, so the site and the cabinet show it instead of "My computer". A name typed on the page wins over a
  rename made in the cabinet when both are used.
- **Pause / Resume** — the offer stays, no new leases; running jobs finish.
- **What you can share** (0.4.8) — besides the machine's cores, the page's "Found on this computer" block
  sells what this computer *already runs*. Four kinds, each with its own price, its own daily $ cap, its own
  Pause and its own timeout:

  | kind | what it is | what a buyer asks for | priced |
  |---|---|---|---|
  | **text** | Ollama (11434), LM Studio (1234), llama.cpp / vLLM / any OpenAI-compatible server (8000 / 8080 / 5000) | a chat completion, streamed | **per 1,000 tokens** (a call is capped at 4,000) |
  | **image** | ComfyUI (8188), A1111 (7860) | text to image: prompt, negative, width, height, steps, seed | **per image** (up to 4 a call) |
  | **speech** | any `/asr` server (whisper-asr-webservice), any `/v1/audio/transcriptions` server (faster-whisper-server, speaches), whisper.cpp's `/inference` | an audio file in, the text plus a `.txt` and an `.srt` out | **per minute of audio**, 6 decimals |
  | **tool** | an MCP server from your Claude Desktop / Cursor / VS Code config | one `tools/call`, tool by tool | **per call** |

  The rules that hold for all four:
  - **Nothing is shared until you tick it**, and a price is required before the tick.
  - **The node self-tests every kind before it may be sold.** ComfyUI is asked what checkpoints it has, A1111
    for its options, a speech server is given a quarter second of silence, an MCP server is started once and
    asked for its tools. A kind that is found but fails is shown **greyed with the reason** ("ComfyUI has no
    checkpoint installed — put a model in models/checkpoints and rescan") and **cannot be ticked**: the node
    never offers what it cannot actually relay. The heartbeat carries that verdict (`ready` / `starting` /
    `error`), the reason and the last latency, and the hub stops offering a service the moment it turns.
  - **MCP servers are picked tool by tool.** Sharing the server starts it once so its tools can be listed —
    that is the only time a shared server runs without a paid call. A tool that can read or change files or
    run commands shows the red line *"this tool can read or change files on your computer"* and is
    **unticked by default**; nothing of it is offered until you tick it by hand. An idle shared server is
    **stopped after 10 minutes**.
  - **The daily cap and Pause are per service.** Once today's sales of one service reach its cap the hub
    stops offering that one; Pause stops it at once. Both leave the offer and its history in place.
  - **Nothing of a call is written to this computer.** No prompt, no answer, no image file of ours: a PNG or
    an `.srt` goes straight from memory to the hub, which puts it in the buyer's job outputs. The node's log
    holds the call id and nothing else.
  - **DATA ACCESS, said plainly on every card:** these are *your own programs*, so the buyer's prompt and
    result pass through your machine and you could technically read them. Said once more below.
- **Your own programs are not sandboxed, and that is the point** (0.4.8) — Ollama, ComfyUI, A1111, your
  speech server and your MCP servers keep running exactly as they do now: as you, outside the sandbox, with
  your files, your GPU and whatever access you already gave them. The AppContainer / sandbox-exec sandbox in
  this node is for **buyers' scripts only** and never wraps these. That is why a filesystem MCP tool carries
  a red line and why sharing one is a decision about trust, not a slider.
- The runtime card (which sandbox, package and probe state), presence, earnings, the update line
  ("updating to v0.4.5 — downloading 12 of 39 MB", "updated to v0.4.5 from v0.4.4", "rolled back"),
  and the log.

Writes to the page need a header only the page itself sends, and the page never returns CORS headers:
a web page in your browser cannot drive it.

## How money works

1. A buyer funds a cap into escrow (USDC on Base) or pays through x402 before the job is created.
2. The hub leases the job, or a piece of it, to the **cheapest** node whose kind, shared resources, open
   window, packages and price fit.
3. The node runs it and reports. The hub bills **actual minutes × your price per minute** on its own
   clock, to six decimals, never more than the cap. Your price is snapshotted at lease: repricing never
   changes a running job.
4. **No free work** (hub rules since 2026-10-26). For a machine job the minutes are owed the moment your
   attempt finishes with **exit 0 and at least one output file**: **80 %** of the billed amount is written to
   your ledger right then, Versum keeps 20 %, and a buyer's Reject is a rating only. The hub refunds the buyer
   by itself only on objective failure it sees (non-zero exit, exit 0 without output, timeout, node vanished),
   and those runs are requeued on another node. For people and agent tools the result is held until the buyer
   opens it; opening pays. The lease manifest tells you who you work for (`buyer`: reject rate, spend).
5. Payouts go to the wallet you set in the cabinet on the site once your balance reaches **$1**. You need a
   wallet address; you do not need to hold any crypto to start.
6. Your reputation is your ratings plus your completion rate. Nodes that drop or time out jobs get fewer
   leases.

## What is in this repository

```
bin/versum-node.mjs   the CLI: scan · doctor · pair · offer · on/off · status · start · once · run-local · gpu-check · prune
lib/scan.mjs          cores, RAM, GPU, disk, connection type — pure parsers, tested on fixtures; the node's version
lib/gpu-detect.mjs    nvidia-smi / Win32_VideoController → the gpu block (0.4.4)
lib/runtime.mjs       finds the executor: the built-in sandbox on Windows/macOS, Podman or Docker (rootless) on Linux
lib/native.mjs        the native sandbox: AppContainer (Windows, via packaging/windows/sandbox) / Seatbelt (macOS)
lib/container.mjs     the container executor (pull by digest, containerArgs posture, per-job proxy, cgroup cpu)
lib/manifest.mjs      validates the hub's manifest and builds the container argv (the whole security posture, in one file)
lib/runner.mjs        one attempt: inputs → run → meter → upload outputs → report → wipe
lib/pylib.mjs         the 18 standard wheels: download, sha256 against pylib-lock.json, unpack, import check (0.4.2)
lib/pylib-gpu.mjs     the cu128 GPU wheel set, resumable (0.4.4)
lib/gpu-probe.mjs     runs probe/gpu_probe.py bare and inside the sandbox; the gpu_probe verdict (0.4.4)
lib/update.mjs        self-update: decide, download, verify, smoke, swap when idle, roll back (0.4.3)
lib/metering.mjs      cpu seconds from the container's cgroup, as evidence beside the hub's clock
lib/egress.mjs        the per-job proxy, only when the job asks AND you allow network (Linux)
lib/hub.mjs           the outbound client (the only network the node itself uses)
lib/node.mjs          the loop: heartbeat → lease when free and inside a window → run → report
lib/local-ui.mjs      http://127.0.0.1:3311/ — the page, the market hint, the name suggestion (0.4.5)
lib/config.mjs        ~/.versum-node/config.json (0600), --windows parsing
probe/                sandbox_probe.py (what the CI job proves), gpu_probe.py / gpu_probe.ps1
packaging/            Inno Setup script + launch.vbs + the C# sandbox helper (Windows); the installer app (macOS); pinned Python
installer/            install.sh (Linux), install-macos.sh, install-wsl.ps1 (advanced), systemd units
scripts/              build-sea.mjs (the single binary), pylib-gpu-lock.mjs (regenerates the GPU lock)
pylib-lock.json       the 18 wheels per platform with sha256; pylib-gpu-lock.json the GPU set
protocol/README.md    every call between node and hub, and the manifest contract
docs/                 installers, native sandbox, GPU, self-update, threat model, what the node touches
test/                 node --test test/*.test.mjs; test/e2e/ = what release.yml runs on the real installers
```

Everything that touches money, scheduling across nodes and the buyer side lives on the hub and is not in
this repository. Releases are built by [.github/workflows/release.yml](.github/workflows/release.yml) on
every `v*` tag: build, install the real `.exe` and `.dmg` on `windows-latest` and `macos-latest`, pair
with a dev hub, run a job inside the sandbox, update the installed node to a candidate built in the same
run, uninstall, and only then publish the assets.

## Honest gaps

- **Unsigned installers.** SmartScreen and Gatekeeper warn once. Code signing is a certificate purchase,
  not code.
- **Intel Macs** are verified only under Rosetta on Apple-silicon runners: the x64 binary loads and runs,
  the Seatbelt probe has not run on an Intel kernel. The sandbox code is the same as arm64's.
- **Windows on ARM** is untested; the installer is x64 only.
- **No resource pooling.** RAM and disk are never combined across machines: a job that needs 32 GB needs
  one node with 32 GB. CPU and GPU parallelism exists only through pieces: a job split into pieces runs
  them on several nodes at once, each piece within one node.
- **macOS memory and disk limits are polls**, not kernel caps; a job can overshoot briefly before it is
  killed. Windows has kernel caps. Details in [docs/native-sandbox.md](docs/native-sandbox.md).
- **AppContainer + CUDA is unproven** (see above).
- **A buyer's inputs are readable by the node owner.** Do not send secrets or data you cannot afford to
  leak; encrypted or attested execution is not in v1.

## Try it without the hub

```bash
git clone https://github.com/sudzikcoin/versum-node && cd versum-node
node --test test/*.test.mjs
node bin/versum-node.mjs scan
node bin/versum-node.mjs run-local test/fixtures/manifest.local.json   # runs a tiny Python job in a container
```

`run-local` takes a manifest whose inputs carry a local `path`, runs it with the exact posture a hub job
gets, and leaves the outputs in `~/.versum-node/jobs/<attempt>/out` for you to inspect.

## Why open source

People run this on their own machines. They must be able to read exactly what it does, build it
themselves, and compare the result with the published release.

## License

Apache License 2.0. See [LICENSE](LICENSE).
