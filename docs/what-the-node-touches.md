# What the node reads, writes and sends — and what it never does

## Reads
- `/proc/cpuinfo`, `/proc/meminfo`, `/proc/net/route`, `/sys/class/net/<iface>/wireless` — the scan
- `nvidia-smi` / `rocm-smi` output, `nvidia-ctk --version` — GPU facts
- the free-space figure of the filesystem under `~/.versum-node/jobs`
- `~/.versum-node/config.json` (0600): hub URL, your node key, your share, price, windows
- the container runtime's own state (`podman info`, `inspect`, cgroup `cpu.stat` of a job container)

## Writes
- `~/.versum-node/config.json`, `~/.versum-node/jobs/<attempt>/` (deleted when the attempt ends), `~/.versum-node/state/egress/<attempt>.log` (only when a job used the network)
- the installer also writes `~/.versum-node/{app,bin,node}` and `~/.config/systemd/user/versum-node.service`, and a symlink in `~/.local/bin`

## Sends to the hub
- heartbeat: status, interval, timezone, node version, the scan (figures from the list above)
- the offer you set with `versum-node offer`
- per attempt: cpu seconds, wall seconds, a progress note from the job's own stdout, the output files, exit code, the last 40 lines of the job's stderr

## Never
- walks your disk, reads your home, your shell history, your browser, your keys
- opens a listening port on any interface but 127.0.0.1 (the status page)
- forwards its own environment into a job
- runs a container with a mount, device, capability or flag that came from a manifest
- keeps anything from a job after it ends, except the egress host log when the job used the network
- sends the hub anything from `detected` beyond hardware figures; it is logged, not inspected

Verify it: `grep -rn "readFileSync\|readdirSync\|statfsSync\|execFile\|spawn" lib bin` lists every place the node touches the system.
