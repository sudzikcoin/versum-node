# Node ↔ hub protocol, v2

Everything is outbound HTTPS from the node to the hub with the node key as a bearer token
(`Authorization: Bearer llk_…`), under `/api/agent/v1`. The node never listens on the network.
Every error is `{ "error": { "code", "message" } }` with a stable `code`.
The header `x-versum-protocol: 2.0.0` names what the node speaks.

## Registry (live on the hub today)

| Call | Body | Meaning |
|---|---|---|
| `GET /me` | — | who am I; fails if the key is wrong |
| `POST /me/heartbeat` | `{ status, interval_seconds, timezone, app, platform, resources? }` | alive; `resources` = the scan below, stored as the latest report. 0.4.3: `platform` = `win32-x64` \| `darwin-arm64` \| `darwin-x64`; the answer carries `release: { version, published_at, asset: { url, sha256, size } }` — the newest node release and this platform's update bundle; the node updates itself from it (docs/self-update.md) |
| `GET /me/node` | — | my offer as stored: enabled, price, share, windows, window_open_now, presence, reputation, earnings |
| `PUT /me/node` | `{ resources?, share?, price_per_minute_usd?, mobility?, windows?, timezone?, enabled? }` | change any part of the offer; `enabled: true` needs a price and a scan |

**resources** (the scan): `cpu_cores, cpu_model, cpu_arch, ram_mb, disk_free_mb, gpu_count, gpu_model, gpu_vram_mb, os, container_runtime (docker|podman|none), executor_kind (container_docker | script_native — v2.1, 0.4.0: a script_native node runs `python` pieces only, without GPU or network, in the OS sandbox; the scheduler offers it nothing else), connection_type (ethernet|wifi|cellular|satellite|unknown), downlink_mbps, uplink_mbps, node_version, detected {}`. `detected` may never carry a path, a user name or an environment variable.

**share**: `cpu_cores, ram_mb, disk_mb` (null = all of the scan), `gpu, max_parallel_jobs (1–32), max_job_minutes, allow_network`.

**windows**: `[{ weekday: 0–6 | "Mon" | null, start: "HH:MM" | minutes, end, timezone? }]`; `[]` = always. End is exclusive; an overnight window is two rows.

## Jobs (the hub implements these in its block 4; the node is written against them)

| Call | Body → Reply | Meaning |
|---|---|---|
| `POST /jobs/lease` | `{ free: { cpu_cores, ram_mb, disk_mb, gpu, network, running } }` → `204` or `200 manifest` | one piece for me, or nothing |
| `POST /attempts/{id}/heartbeat` | `{ cpu_seconds, wall_seconds, note, progress_age_s }` | every 30 s while running |
| `POST /attempts/{id}/outputs/stream` | raw bytes; headers `x-file-name`, `content-type`, `content-length` | one output file |
| `POST /attempts/{id}/finish` | `{ exit_code, outcome, wall_seconds, cpu_seconds, outputs[], failure_reason, stderr_tail }` | the run is over |
| `POST /attempts/{id}/release` | `{ reason_code, detail }` | I will not run this (manifest refused, over my share) — no penalty when honest |

`outcome` ∈ `succeeded | failed | timeout`. The hub bills on its own clock (lease → finish, capped at the time limit); `cpu_seconds` and `wall_seconds` are the node's evidence beside it.

## The manifest

```json
{
  "attempt_id": "uuid", "piece_id": "uuid", "job_id": "uuid",
  "kind": "python",
  "image": "ghcr.io/sudzikcoin/versum-python:3.12@sha256:<64 hex>",
  "command": ["python", "/job/in/run.py"],
  "env": { "THREADS": "4" },
  "args": { "shard": 3, "of": 8 },
  "limits": { "cpu_cores": 2, "ram_mb": 4096, "disk_mb": 10240, "gpu": false, "network": false, "time_limit_minutes": 30 },
  "inputs": [ { "name": "run.py", "url": "https://…signed…", "size_bytes": 1234, "sha256": "<64 hex>" } ],
  "price_per_minute_usd": 0.02
}
```

What the node guarantees about it (`lib/manifest.mjs`):

- `image` **must** be pinned by digest; an unpinned image is refused before anything is pulled.
- `command` is an argv; `env` is at most 64 plain `KEY=value` pairs and may not set `PATH`, `HOME`, `LD_*`, `PYTHONPATH`, `NODE_OPTIONS` or proxy variables.
- There is no field for mounts, devices, capabilities, privileges, host paths or runtime flags. The node builds the argv itself: fresh named container, `--user uid:gid`, read-only root, `tmpfs /tmp` (noexec), `--cap-drop ALL`, `no-new-privileges`, `--cpus/--memory/--memory-swap/--pids-limit` from `limits`, the attempt's own directory as the **only** mount at `/job`, `--network none` unless `limits.network` **and** the owner allowed it (then a per-job proxy, 443/80, LAN denied), GPU only when asked **and** shared.
- Inside the container: `/job/in/<inputs>`, `/job/piece.json` (`job_id, piece_id, attempt_id, args`), `/job/out/` for results, `VERSUM_JOB_ID`, `VERSUM_PIECE_ID`, `VERSUM_JOB_DIR`. Nothing else from the host.
- A job that asks for more than the owner shares is released with `reason_code: capacity`, not run.
- When the container exits the node uploads every regular file under `/job/out` (symlinks skipped), reports `finish`, removes the container and the proxy, and deletes the directory. Always, including on failure.
