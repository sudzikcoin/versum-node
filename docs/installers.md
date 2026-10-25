# Installers without a terminal (Windows .exe, macOS .dmg) — v0.4.0: one click

Built by `.github/workflows/release.yml` on every `v*` tag (and on every push to `main`, without the release),
attached to that tag's GitHub Release. Each carries a **single binary** (Node.js single executable application,
`scripts/build-sea.mjs`) and an **embedded Python 3.12** (python-build-standalone, pinned by sha256 in
`packaging/versions.json`). Nothing has to be installed first: no Docker, no WSL, no Node.js, no administrator.

## Key handoff — the file name
The site serves the release asset renamed with the pairing key inside the file name:

    versum-node-setup-llk_<32 chars>.exe                              key, hub = default (prod)
    versum-node-setup-llk_<32 chars>-hub-api.example.io~dev.exe       key + hub https://api.example.io/dev   (~ = /)
    Versum-Node-arm64-llk_<32 chars>[-hub-…].dmg                      the same for macOS (Apple silicon)
    Versum-Node-x64-llk_<32 chars>[-hub-…].dmg                        Intel Macs

* Windows: Inno passes `{srcexe}` to `packaging/windows/launch.vbs`, which strips the extension and a browser's
  " (1)" suffix, reads the key and the hub, and exports `VERSUM_NODE_KEY` / `VERSUM_HUB` to the node's first start.
* macOS: `packaging/macos/launcher.sh` finds the mounted image's path with `hdiutil info` and parses it the same way.
  If the app was copied out of the dmg, there is no name to read: the node installs unpaired.
* No key in the name → the local page http://127.0.0.1:3311/ asks for it.

## What each installer does
* **Windows** (`packaging/windows/versum-node.iss`, Inno Setup, `PrivilegesRequired=lowest`): copies
  `versum-node.exe`, `versum-sandbox.exe`, `python\`, `probe\`, `launch.vbs` under `%LOCALAPPDATA%\versum-node`;
  a Startup-folder shortcut (`wscript.exe launch.vbs`) starts the node hidden at every sign-in; the installer runs
  `launch.vbs --open --source <itself>` once: the node starts, pairs from the file name, the browser opens the page.
  Nothing is shown but the Inno progress bar. Settings → Apps → *Versum node* → Uninstall stops the node, deletes
  the AppContainer profiles it created, removes everything under `%LOCALAPPDATA%\versum-node` (config and key
  included) and the Startup shortcut. Logs: `%LOCALAPPDATA%\versum-node\home\state\{launch,node}.log`.
* **macOS** (`packaging/macos/build-app.sh`): a `Versum Node Installer.app` with no window (`LSUIElement`) in a
  dmg per architecture. It runs `installer/install-macos.sh` with the bundle as the source: copies the binary,
  the Python tree and the probe to `~/.versum-node/app` (quarantine cleared), pairs, registers the launchd agent
  `io.suverse.versum-node` (RunAtLoad, KeepAlive), waits for the page and opens it. Log:
  `~/.versum-node/state/install.log`. Remove: `~/.versum-node/app/uninstall.sh`.
* **Linux**: unchanged — `install.sh` (Podman/Docker). The only kind of node that runs container, GPU and
  network jobs.

## Unsigned — what the person sees
* **Windows SmartScreen**: "Windows protected your PC" → *More info* → *Run anyway*. No administrator prompt ever.
* **macOS Gatekeeper**: right-click (Control-click) *Versum Node Installer* → *Open* → *Open*. On macOS 15 Sequoia
  the first double-click says "not opened"; then System Settings → Privacy & Security → *Open Anyway*.
  The bundle is ad-hoc signed (`codesign -s -`), not notarized.

## Tested on every release, on the real runners
`release.yml` installs the freshly built `.exe` silently on `windows-latest` and runs the `.dmg`'s installer app on
`macos-latest`, each under a file name that carries a dev-hub key; the node pairs, sets an offer from its own
page, a python job created on the dev hub is leased, run inside the sandbox and completed, and the job's output
(the sandbox probe) must say that no door was open — see `test/e2e/hub-e2e.mjs`. Then the uninstaller runs and
must leave nothing. The Intel build is smoke-tested under Rosetta on the Apple-silicon runner. What CI does not
prove: a real person's laptop (SmartScreen/Gatekeeper clicks, antivirus, a locked-down corporate policy),
Windows on ARM, an Intel Mac proper.

## Advanced: Docker on Windows/macOS
Docker Desktop / OrbStack still work (`runtime: docker` in `config.json` or `VERSUM_NODE_RUNTIME=docker`) and are
the only way a Windows/macOS node will take container or GPU jobs; `installer/install-wsl.ps1` is the old WSL2 +
Docker Desktop installer, kept for that path. Not what the .exe does.
