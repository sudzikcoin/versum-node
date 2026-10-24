# versum-node

Share your computer's spare compute with the Versum network and get paid per minute.

You install one program. It looks at what the machine has (CPU cores, RAM, GPU, disk, type of
connection), you choose how much of it to share, when, and at what price per minute. Jobs from
buyers run inside a throw-away container that is wiped when the job ends. The node never
advertises "skills": it offers resources and time, nothing else.

**Status: pre-alpha.** The node program is here and runs jobs locally (`run-local`); the hub's job
queue it leases from is being built. Linux x86_64 / aarch64, Node.js ≥ 20, rootless Podman
(recommended) or rootless Docker. No dependencies: `lib/` is the whole program, read it.

## Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/sudzikcoin/versum-node/main/installer/install.sh | sh
```

The script never asks for sudo and writes only under `~/.versum-node` and `~/.config/systemd/user`.
It checks the OS and architecture, finds Node.js ≥ 20 or downloads an official build (checksum
verified), finds Podman or Docker, downloads this repository, installs a user systemd unit and
prints the next steps. Read it first: [installer/install.sh](installer/install.sh).

Then:

```bash
versum-node scan                                   # what this machine has (nothing is sent)
versum-node pair llk_…                             # the key from the site, "connect your computer"
versum-node offer --cpu=4 --ram-gb=8 --price=0.02  # what you share, and your price per minute
versum-node offer --windows="Mon-Fri 22:00-07:00, Sat-Sun 00:00-24:00"   # when (default: always)
systemctl --user enable --now versum-node          # run it; loginctl enable-linger $USER keeps it up
versum-node status                                 # your offer as the hub stores it, reputation, earnings
```

`versum-node on` / `off` starts and stops taking jobs without touching your offer. The local status
page is `http://127.0.0.1:3311/` (loopback only). `versum-node doctor` says what is missing.

## What the node shares

Only what you turn on, within the limits you set:

| Resource | Flag | What you set |
|---|---|---|
| CPU | `--cpu=4` | number of cores, out of what the scanner found (0 = all) |
| RAM | `--ram-gb=8` | gigabytes (0 = all) |
| GPU | `--gpu=true` | on/off (NVIDIA first; needs nvidia-container-toolkit) |
| Disk | `--disk-gb=20` | a scratch quota, used only while a job runs |
| Network | `--network=true` | whether jobs may reach the internet at all; **off by default**, most jobs need none |
| Parallel | `--parallel=2` | how many jobs run at once |
| Time | `--max-job-minutes=240`, `--windows=…` | the longest job you accept; a schedule |
| Price | `--price=0.02` | USD per minute for the bundle above |
| Mobility | `--mobility=mobile` | a laptop that may vanish mid-job is scheduled accordingly |

The scanner reads hardware facts (`/proc`, `nvidia-smi`, the free space of its own directory). It
never walks your files. The exact list: [docs/what-the-node-touches.md](docs/what-the-node-touches.md).

## What the node never touches

- **Your files.** A job sees one empty working directory the node creates for it and deletes
  afterwards. No home directory, no other mounts, no host paths.
- **Your network.** By default a job has no network interface at all. If you allow internet, the
  job goes through the node's own proxy (443/80, LAN addresses denied, every host logged) and never
  sees your LAN directly.
- **Your other programs.** The job runs as an unprivileged user in a user namespace, read-only root
  filesystem, all Linux capabilities dropped, `no-new-privileges`, with CPU, memory, process and
  tmpfs limits enforced by the container runtime. The node refuses a rootful runtime unless you
  explicitly accept the risk (`VERSUM_NODE_ALLOW_ROOTFUL=1`).
- **Your keys.** The node keeps one config file (mode 0600) with its own node key. No job can read
  the node's config or environment; the container gets exactly the buyer's variables plus three
  `VERSUM_*` ids.

A job is a buyer's Python script run in Versum's standard image, or the buyer's own container
image plus a command. Images are always pinned by digest. The manifest the hub sends has no field
for mounts, devices, capabilities or runtime flags: the node builds the argv itself
([lib/manifest.mjs](lib/manifest.mjs)). The node pulls the image, runs it with the limits above,
uploads `/job/out`, reports, removes the container and the working directory. Always, even on
failure. Full threat model: [docs/threat-model.md](docs/threat-model.md).

## How money works

1. A buyer submits a job with resource requirements and a time limit, and pays an estimate into
   escrow (USDC on Base) up front.
2. The hub leases the job, or a piece of it, to a node whose shared resources, window and price fit.
3. The node runs it and reports the minutes the container actually ran. The hub bills
   **actual minutes × your price per minute** on its own clock, never more than the buyer's limit.
   Your price is snapshotted at lease: repricing never changes a running job.
4. The buyer has a window to rate the result. After the window the node's share is paid out to the
   wallet you set in your cabinet. Versum keeps a commission from the buyer's side.
5. Your reputation is your ratings plus your completion rate. Nodes that drop or time out jobs get
   fewer leases.

Payouts are in USDC on Base. You need a wallet address; you do not need to hold any crypto to start.

## What is in this repository

```
bin/versum-node.mjs   the CLI: scan · doctor · pair · offer · on/off · status · start · once · run-local · prune
lib/scan.mjs          cores, RAM, GPU (nvidia-smi / rocm-smi), disk, connection type — pure parsers, tested on fixtures
lib/runtime.mjs       finds Podman or Docker, insists on rootless
lib/manifest.mjs      validates the hub's manifest and builds the container argv (the whole security posture, in one file)
lib/runner.mjs        one attempt: inputs → pull by digest → run → meter → upload /job/out → report → wipe
lib/metering.mjs      cpu seconds from the container's cgroup, as evidence beside the hub's clock
lib/egress.mjs        the per-job proxy, only when the job asks AND you allow network
lib/hub.mjs           the outbound client (the only network the node itself uses)
lib/node.mjs          the loop: heartbeat → lease when free and inside a window → run → report
lib/health.mjs        http://127.0.0.1:3311/
lib/config.mjs        ~/.versum-node/config.json (0600), --windows parsing
egress/               the proxy image: tinyproxy + the LAN deny list
installer/            install.sh and the user systemd unit
protocol/README.md    every call between node and hub, and the manifest contract
docs/                 threat model; what the node reads, writes, sends — and never does
test/                 node --test: manifest posture, parsers, windows, pulse, config permissions
```

Everything that touches money, scheduling across nodes and the buyer side lives on the hub and is
not in this repository.

## Try it without the hub

```bash
git clone https://github.com/sudzikcoin/versum-node && cd versum-node
npm test
node bin/versum-node.mjs scan
node bin/versum-node.mjs run-local test/fixtures/manifest.local.json   # runs a tiny Python job in a container
```

`run-local` takes a manifest whose inputs carry a local `path`, runs it with the exact posture a hub
job gets, and leaves the outputs in `~/.versum-node/jobs/<attempt>/out` for you to inspect.

## Why open source

People run this on their own machines. They must be able to read exactly what it does, build it
themselves, and compare the result with the published release.

## License

Apache License 2.0. See [LICENSE](LICENSE).
