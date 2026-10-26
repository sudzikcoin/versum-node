# What the node reads, writes and sends — and what it never does

## Reads
- `/proc/cpuinfo`, `/proc/meminfo`, `/proc/net/route`, `/sys/class/net/<iface>/wireless` — the scan
- `nvidia-smi` / `rocm-smi` output, `nvidia-ctk --version` — GPU facts
- the free-space figure of the filesystem under `~/.versum-node/jobs`
- `~/.versum-node/config.json` (0600; `/var/lib/versum-node/config.json` for a root install; `%LOCALAPPDATA%\versum-node\home\config.json` on Windows): hub URL, your node key, your name, share, prices, windows, pause, the rootful-Docker consent
- `version.txt` and the two lock files beside the binary; on Windows `nvidia-smi` output, `Win32_VideoController` (WMI) and the ACLs of `System32\nvcuda.dll` and the NVIDIA driver folder (`icacls`, read only) for the GPU report
- the container runtime's own state (`podman info`, `inspect`, cgroup `cpu.stat` of a job container)

## Writes
- `~/.versum-node/config.json`, `~/.versum-node/jobs/<attempt>/` (deleted when the attempt ends), `~/.versum-node/state/egress/<attempt>.log` (only when a job used the network)
- `<state>/pylib` (the 18 standard wheels, 60 MB) and, after "share the GPU", `<state>/pylib-gpu` (2.8 GB); `<state>/gpu-probe.json`; `<state>/update/` and `update.json` while an update is in flight; `<state>/node.log`
- on Windows: AppContainer profiles `versum-job-<attempt>` (deleted after the job; leftovers listed in `home\state\appcontainers.txt` for the uninstaller), read grants on the Python tree and the two package folders for ALL APPLICATION PACKAGES
- the installer also writes `~/.versum-node/{app,bin,node}` and `~/.config/systemd/user/versum-node.service`, and a symlink in `~/.local/bin` (Linux); `%LOCALAPPDATA%\versum-node` and a Startup-folder shortcut (Windows); `~/.versum-node/app` and `~/Library/LaunchAgents/io.suverse.versum-node.plist` (macOS)
- the self-updater renames the old program to `.prev` entries (Windows) or `app.prev` (macOS) and removes them after the first good heartbeat
- as root (Linux): the system user `versum`, `/var/lib/versum-node/…`, `/etc/systemd/system/versum-node.service`, `/usr/local/bin/versum-node`; the advanced WSL path (`install-wsl.ps1`) adds a scheduled task "Versum node" and the files above inside the WSL distro

## Sends to the hub
- heartbeat: status, interval, timezone, node version, platform, the scan (figures from the list above, including the `gpu` block, `python_packages`, `gpu_packages`, `gpu_probe`)
- the offer you set on the local page or with `versum-node offer`, including the name you typed and your prices
- **downloads, not uploads**: wheels from `pypi.org` / `files.pythonhosted.org` (and `download.pytorch.org` for the GPU set), update bundles from `github.com/sudzikcoin/versum-node/releases` — each accepted only when its sha256 matches
- one GET of the hub's public capacity board (`/api/network/capacity`), for the price hint on the local page
- per attempt: cpu seconds, wall seconds, a progress note from the job's own stdout, the output files, exit code, the last 40 lines of the job's stderr

## Never
- walks your disk, reads your home, your shell history, your browser, your keys
- opens a listening port on any interface but 127.0.0.1 (the local page; its writes need a header only that page sends, and no CORS headers are ever returned)
- forwards its own environment into a job
- runs a container with a mount, device, capability or flag that came from a manifest
- keeps anything from a job after it ends, except the egress host log when the job used the network
- sends the hub anything from `detected` beyond hardware figures; it is logged, not inspected

Verify it: `grep -rn "readFileSync\|readdirSync\|statfsSync\|execFile\|spawn" lib bin` lists every place the node touches the system.
