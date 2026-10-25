# Self-update (0.4.3)

Nobody reinstalls a node by hand. From 0.4.3 on, an installed Windows or macOS node updates itself.

## How the node hears about a release

The hub answers every heartbeat (`POST /api/agent/v1/me/heartbeat`, which now carries `platform`) with

```json
"release": { "version": "0.4.4", "published_at": "…", "asset": { "url": "https://github.com/sudzikcoin/versum-node/releases/download/v0.4.4/versum-node-update-win32-x64.tar.gz", "sha256": "…", "size": 39000000 } }
```

The hub reads the node repo's latest GitHub Release through the GitHub API; each asset there carries its sha256
(`digest`), so the hub downloads nothing and the node trusts no URL without a hash. Update bundles are named
`versum-node-update-<win32-x64 | darwin-arm64 | darwin-x64>.tar.gz` and hold exactly what the installer lays down
(the binary, the sandbox helper on Windows, the embedded Python, `probe/`, `pylib-lock.json`, `version.txt`).

## What the node does (`lib/update.mjs`)

1. **decide** — `wantsUpdate`: the version is newer (semver), there is a bundle for this platform with a 64-hex sha256,
   and the URL is our release page (or what GitHub redirects to; loopback only for the e2e). A dev or rc build
   (a version with a `-`) follows an explicit override only, never the public release.
2. **download** — into `<home>/state/update/`, streamed, sha256 and size checked. The page says
   `updating to v0.4.4 — downloading 12 of 39 MB`.
3. **unpack + smoke** — the system `tar` (Windows 10+ and macOS ship bsdtar) unpacks the bundle; the new binary is
   started once with `version` and must print the version promised. Nothing of the install is touched before this.
4. **wait** — no new lease is taken; the swap waits until no job runs.
5. **swap** —
   * Windows: every entry of `%LOCALAPPDATA%\versum-node` that the bundle holds (`versum-node.exe`,
     `versum-sandbox.exe`, `launch.vbs`, `python\`, `probe\`, …) is renamed to `<name>.prev` and the new one moved in
     (Windows allows renaming a running .exe). `home\` (config, state, jobs, pylib, the log) is never in the plan. The
     local page is closed, `wscript //B launch.vbs` — the Startup entry's own script — is started hidden, and the old
     process exits; `launch.vbs` finds no page and starts the new binary.
   * macOS: `~/.versum-node/app` → `app.prev`, the new tree → `app` (`uninstall.sh` copied over), the process exits
     and launchd (`KeepAlive`) starts `~/.versum-node/app/versum-node` — the same path, now the new binary.
6. **verify** — the new process finds `<home>/state/update.json` (`from`, `to`, `starts`). A version other than the one
   promised, or a fourth start without ever reaching the hub, puts the `.prev` entries back and exits; the service
   starts the previous binary again (`rolled back` on the page, with the reason). Otherwise the first good heartbeat
   removes the `.prev` entries and the page says `updated to v0.4.4 from v0.4.3`.
7. **packages** — `lib/pylib.mjs` keys its marker on the lock; a changed `pylib-lock.json` is re-downloaded on the first
   start and `python_packages` goes `pending → ok` on the heartbeat as on a fresh install. The AppContainer grant on the
   Python tree is re-done when the tree changed (the marker carries `python.exe`'s mtime).

What stays: `config.json` (key, hub, name, price, share, windows, pause), `state/pylib`, the grants, the jobs directory,
the log. A failed download or hash never changes anything; one retry per version per hour.

## The version the node reports

`version.txt` beside the binary (written by `release.yml`) is the node's version; `scan.mjs`'s constant is the fallback
for a source checkout. The hub stores it in `node_resources.node_version` on every full scan and shows it on `/nodes`.

## How the release pipeline proves it

`release.yml` builds, beside the real installer, the update bundle for each platform and a second copy of the stage
directory whose `version.txt` says the next patch version with `-rc.<run number>`. After the installed node has
completed a job, `test/e2e/update-e2e.mjs` serves that rc bundle from the runner's loopback, pins it for this one
executor through the hub's gated `/test/e2e-release` door, and watches the node download it, swap, come back as the rc
version with the same key, hub, name, price and share, report `python_packages: ok` again, and be recorded on the hub
with the new `node_version` and `app` string. The override is cleared afterwards. A release ships only when both
runners passed this.

## Nodes older than 0.4.3

0.4.0–0.4.2 ignore the heartbeat answer and read nothing else from the hub that could carry code; their jobs run inside
the sandbox, which cannot write to the install directory. They cannot be updated from the hub — the next install is the
last one done by hand.
