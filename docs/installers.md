# Installers without a terminal (Windows .exe, macOS .dmg)

Built by `.github/workflows/release.yml` on every `v*` tag, attached to that tag's GitHub Release. Both wrap
the same scripts the one-liner runs — `install.ps1` on Windows, `installer/install-macos.sh` on macOS — and
carry this repository inside themselves (`version.txt` = the tag).

## Key handoff — the file name
The site serves the release asset renamed with the pairing key inside the file name:

    versum-node-setup-llk_<32 chars>.exe                           key, hub = default (prod)
    versum-node-setup-llk_<32 chars>-hub-api.example.io~dev.exe    key + hub https://api.example.io/dev   (~ = /)
    Versum-Node-llk_<32 chars>[-hub-…].dmg                         the same for macOS

* Windows: Inno passes `{srcexe}` to `packaging/windows/setup.ps1`, which parses the name and exports
  `VERSUM_NODE_KEY` / `VERSUM_HUB` before running `install.ps1`.
* macOS: `packaging/macos/launcher.sh` finds the mounted image's path with `hdiutil info` and parses it.
  If the app was copied out of the dmg, there is no name to read: the node installs unpaired.
* No key in the name → the local page http://127.0.0.1:3311/ asks for it.

## Unsigned — what the person sees
* **Windows SmartScreen**: "Windows protected your PC" → *More info* → *Run anyway*. The installer needs
  no administrator rights (it installs under `%LOCALAPPDATA%\versum-node`); only `wsl --install` asks, by itself.
* **macOS Gatekeeper**: right-click (Control-click) *Versum Node Installer* → *Open* → *Open*. On macOS 15
  Sequoia the first double-click says "not opened"; then System Settings → Privacy & Security → *Open Anyway*.
  The bundle is ad-hoc signed (`codesign -s -`), not notarized.

## What each installer does
* Windows: copies the program, runs `setup.ps1` in a PowerShell progress window → WSL2 (installs it,
  reboot, Start menu → "Versum node setup (run again)"), Docker Desktop (winget or download, waits),
  the node inside Ubuntu via `install.sh` at the tag, scheduled task "Versum node" at logon, opens the page.
  Uninstall (Settings → Apps) removes the task and the node inside WSL; the distro and Docker stay.
* macOS: the app has no window (`LSUIElement`); it notifies, waits for Docker Desktop / OrbStack with a
  dialog if neither exists, runs `install-macos.sh` with the bundled copy (`VERSUM_NODE_SOURCE_DIR`), log in
  `~/.versum-node/state/install.log`; the installer registers `io.suverse.versum-node` and opens the page.
* Linux: unchanged — `install.sh`.

## Not yet verified on real machines
CI proves the artifacts build, the macOS bundle launches its resources and `scan` runs; neither installer
has been run on a real Windows or macOS machine yet (see the release notes of each tag).
