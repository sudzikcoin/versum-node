# Threat model (v1)

Who can hurt whom, and what the node does about it. Honest about what it does not do.

## The node owner, against a malicious job

| Threat | Control in v1 | Residual |
|---|---|---|
| Container escape via a kernel or runtime bug | rootless Podman/Docker (user namespace), `--cap-drop ALL`, `no-new-privileges`, read-only root, `noexec` tmpfs, default seccomp, no devices except a shared GPU, no host mounts beyond the attempt directory | a kernel 0-day in the user namespace; keep the kernel and runtime updated; gVisor/Kata are not in v1 |
| The node user is root-equivalent (member of `docker`) | the installer refuses to run as root; `doctor` refuses rootful runtimes unless the owner sets `VERSUM_NODE_ALLOW_ROOTFUL=1` | an owner who sets the flag |
| Job reads the owner's files | the only mount is `~/.versum-node/jobs/<attempt>`; config is `0600` outside it; the container runs as the owner's uid inside a user namespace | — |
| Job reaches the LAN or the internet | `--network none` by default; with `allow_network` a per-job proxy on an internal network, CONNECT 443/80 only, deny list for RFC 1918 / loopback / link-local / `.local` / metadata names, every host logged to `state/egress/<attempt>.log` | a public hostname resolving to a LAN address passes the name filter (DNS rebinding). Keep `allow_network` off unless you trust the buyers |
| Job burns more than paid | `--cpus`, `--memory`+`--memory-swap`, `--pids-limit`, the hub's time limit kills the container, `max_job_minutes` caps what the owner accepts; billed minutes equal reserved minutes, so mining is just a paid job | disk: tmpfs is capped, `/job` is not quota'd in v1 — `disk_free_mb` is re-scanned and jobs over the owner's `share.disk_mb` are released |
| Job leaves things behind | container removed, proxy removed, directory deleted in `finally`; leftovers reaped at every start | pulled images stay cached (`versum-node prune`) |
| Job reads the node's secrets | the container gets exactly the manifest's `env` plus `VERSUM_*` ids; the node's environment is never forwarded; the key lives in `config.json` 0600 outside `/job` | — |
| Illegal content processed on this machine | nothing is inspected or kept; buyers are identified and pay through escrow; abuse reports go to the hub | the owner's jurisdiction; read the terms before sharing |

## The buyer, against a malicious node

| Threat | Control in v1 | Residual |
|---|---|---|
| Node steals inputs or outputs | **none on the node** — a node owner can read `/job`. The hub tells buyers: do not send secrets or data you cannot afford to leak | encrypted or attested execution is not in v1 |
| Node fakes or inflates minutes | the hub bills on its own clock from lease to finish, capped at the time limit; the node's `cpu_seconds` is evidence only | a node that stalls to run the clock is caught by the stall watchdog here and by completion rate at the hub |
| Node returns garbage | the buyer rates within a window; reject refunds the piece; reputation is ratings × completion rate | redundant execution is not in v1 |

## The hub, against the node

| Threat | Control in v1 |
|---|---|
| A compromised hub pushes a hostile manifest | the manifest has no field for flags, mounts or devices; the node builds the argv; images must be digest-pinned; the node connects only to the hub URL in its 0600 config over TLS |
| The hub asks for more than the owner shares | `fitsShare()` releases the piece before it runs |
