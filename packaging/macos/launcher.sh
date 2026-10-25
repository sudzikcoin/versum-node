#!/bin/bash
# versum-node — the executable inside "Versum Node Installer.app". No terminal: it runs installer/install-macos.sh
# (the one-liner's script) with its output in ~/.versum-node/state/install.log, talks through macOS dialogs,
# and the installer opens the node page http://127.0.0.1:3311/ at the end.
# The pairing key and the hub come from the .dmg's FILE NAME (found through hdiutil), so nothing is typed:
#   Versum-Node-llk_<32 chars>.dmg                          → key, hub = default (prod)
#   Versum-Node-llk_<32 chars>-hub-api.example.io~dev.dmg   → key + hub https://api.example.io/dev  (~ stands for /)
# No key → the node installs unpaired and its local page asks for the key.
set -u
APP_DIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
HOME_DIR="${VERSUM_NODE_HOME:-$HOME/.versum-node}"
mkdir -p "$HOME_DIR/state"; LOG="$HOME_DIR/state/install.log"
dialog() { osascript -e "display dialog \"$1\" with title \"Versum node\" buttons {\"OK\"} default button 1 giving up after ${2:-0}" >/dev/null 2>&1 || true; }
notify() { osascript -e "display notification \"$1\" with title \"Versum node\"" >/dev/null 2>&1 || true; }

# 1 — the key and the hub, from the name of the disk image this app runs from
MOUNT="$(printf '%s' "$APP_DIR" | awk -F/ '{ if ($2=="Volumes") print "/"$2"/"$3 }')"
IMAGE=""
if [ -n "$MOUNT" ]; then
  IMAGE="$(hdiutil info 2>/dev/null | awk -v m="$MOUNT" '/^image-path/ { sub(/^image-path[ \t]*:[ \t]*/, ""); p=$0 } index($0, m) && p { print p; exit }')"
fi
NAME="$(basename "${IMAGE:-}")"
KEY="$(printf '%s' "$NAME" | grep -oE 'llk_[0-9A-Za-z]{32}' | head -1 || true)"
HUB="$(printf '%s' "$NAME" | sed -nE 's/.*-hub-([A-Za-z0-9._~-]+)\.dmg$/\1/p' | tr '~' '/')"
{
  echo "== $(date) versum-node installer app"; echo "app: $APP_DIR"; echo "image: ${IMAGE:-none}"
  echo "key: ${KEY:+found}${KEY:-none}"; echo "hub: ${HUB:-default}"
} >>"$LOG"

# 2 — Docker Desktop / OrbStack: say it in a dialog instead of a terminal line, the installer waits either way
if ! (command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1) && [ ! -d /Applications/Docker.app ] && [ ! -d /Applications/OrbStack.app ]; then
  (dialog "The node needs Docker Desktop or OrbStack (either one — a Linux VM where jobs run isolated).\n\nThe download page opens now. Install one, start it, and this installer continues on its own." 0) &
fi
notify "Installing the node… the node page opens in your browser when it is ready."

# 3 — the same installer the one-liner runs, from the copy inside this app
export VERSUM_NODE_SOURCE_DIR="$APP_DIR" VERSUM_NODE_VERSION="$(cat "$APP_DIR/version.txt" 2>/dev/null || echo main)"
[ -n "$KEY" ] && export VERSUM_NODE_KEY="$KEY"
[ -n "$HUB" ] && export VERSUM_HUB="https://$HUB"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if /bin/sh "$APP_DIR/installer/install-macos.sh" >>"$LOG" 2>&1; then
  notify "Node installed${KEY:+ and paired}. Its page is open at http://127.0.0.1:3311/"
else
  dialog "The install did not finish. The log is at $LOG — the last lines say what is missing. Fix it and open this installer again." 0
  exit 1
fi
