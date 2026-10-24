# versum-node

Share your computer's spare compute with the Versum network and get paid per minute.

You install one program. It looks at what the machine has (CPU cores, RAM, GPU, disk, type of
connection), you choose how much of it to share, when, and at what price per minute. Jobs from
buyers run inside a throw-away container that is wiped when the job ends. The node never
advertises "skills": it offers resources and time, nothing else.

**Status: pre-alpha.** This repository is the public home of the node. The first installable
release is not out yet; follow the releases page.

## Install (one line)

```bash
curl -fsSL https://versum.suverse.io/install.sh | sh
```

The script checks the OS, installs or finds a container runtime (Docker or Podman), downloads the
node binary, and starts the local setup page at `http://127.0.0.1:3311`. On that page you link the
node to your Versum account, pick what to share, and set your price. Nothing is shared until you
press *Start*.

Supported at launch: Linux x86_64 with Docker or Podman. macOS and Windows (via Docker Desktop or
WSL2) follow. Phones are not nodes yet.

## What the node shares

Only what you turn on, within the limits you set:

| Resource | What you set |
|---|---|
| CPU | number of cores, out of what the scanner found |
| RAM | gigabytes |
| GPU | on/off (NVIDIA first), memory ceiling |
| Disk | a scratch quota, used only while a job runs |
| Network | whether jobs may reach the internet at all; most jobs run with no network |
| Time | a schedule (always, or hours of the day), and a maximum minutes per job |
| Price | USD per minute for the bundle above |

The scanner reads hardware facts (`/proc`, `nvidia-smi`, `df`). It never walks your files.

## What the node never touches

- **Your files.** A job sees one empty working directory that the node creates for it and deletes
  afterwards. No home directory, no other mounts, no host paths.
- **Your network.** By default a job has no network interface at all. If you allow internet, the
  job goes through the node's own egress proxy and never sees your LAN.
- **Your other programs.** The job runs as an unprivileged user, read-only root filesystem, all
  Linux capabilities dropped, `no-new-privileges`, with CPU, memory, process and disk limits
  enforced by the container runtime.
- **Your keys.** The node keeps one config file (mode 0600) with its own node key. No job can read
  the node's config or environment.

A job is a buyer's Python script run in Versum's standard image, or the buyer's own container
image plus a command. The node pulls the image, runs it with the limits above, collects the
output directory, uploads it, and removes the container, the image layers it pulled for that job
(if you choose), and the working directory.

## How money works

1. A buyer submits a job with resource requirements and a time limit, and pays an estimate into
   escrow (USDC on Base) up front.
2. The hub assigns the job, or a piece of it, to a node whose shared resources and price fit.
3. The node runs it and reports the minutes the container actually ran. The hub bills
   **actual minutes × your price per minute**, never more than the buyer's limit.
4. The buyer has a short window to rate the result. After the window the node's share is paid out
   to the wallet you set in your cabinet. Versum keeps a commission from the buyer's side.
5. Your reputation is your ratings plus your completion rate. Nodes that drop or time out jobs
   get fewer assignments.

Payouts are in USDC on Base. You need a wallet address; you do not need to hold any crypto to
start.

## What is in this repository

```
installer/   install.sh and the per-OS steps it runs
scanner/     reads cores, RAM, GPU, disk, connection type
runner/      pulls an image, runs one job in an isolated container, meters minutes
hub/         the outbound connection to the Versum hub: register, heartbeat, take, report
ui/          the local setup and status page (127.0.0.1 only)
docs/        protocol, threat model, how to audit what the node does
```

Everything that touches money, scheduling across nodes and the buyer side lives on the hub and is
not in this repository.

## Why open source

People run this on their own machines. They must be able to read exactly what it does, build it
themselves, and compare the result with the published release.

## License

Apache License 2.0. See [LICENSE](LICENSE).
