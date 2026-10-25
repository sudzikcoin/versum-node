#!/bin/bash
# versum-node — the executable inside "Versum Node Installer.app" (v0.4.0). No terminal, no Docker: it runs
# installer/install-macos.sh with the binary and the embedded Python carried inside this bundle, keeps the log in
# ~/.versum-node/state/install.log, talks through notifications, and the installer opens the node page.
# The pairing key and the hub come from the .dmg's FILE NAME (found through hdiutil), so nothing is typed:
#   Versum-Node-arm64-llk_<32 chars>.dmg                          → key, hub = default (prod)
#   Versum-Node-arm64-llk_<32 chars>-hub-api.example.io~dev.dmg   → key + hub https://api.example.io/dev  (~ stands for /)
# No key → the node installs unpaired and its local page asks for the key.
set -u
APP_DIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
HOME_DIR="${VERSUM_NODE_HOME:-$HOME/.versum-node}"
mkdir -p "$HOME_DIR/state"; LOG="$HOME_DIR/state/install.log"
dialog() { osascript -e "display dialog \"$1\" with title \"Versum node\" buttons {\"OK\"} default button 1" >/dev/null 2>&1 || true; }
notify() { osascript -e "display notification \"$1\" with title \"Versum node\"" >/dev/null 2>&1 || true; }

# 1 — the key and the hub, from the name of the disk image this app runs from. The mount point is wherever the
# .dmg was attached (/Volumes/Versum Node for a user, but CI may use another path), found with df, not assumed.
MOUNT="$(df "$APP_DIR" 2>/dev/null | awk 'NR==2 { for (i=9;i<=NF;i++) printf "%s%s", (i>9?" ":""), $i }')"
IMAGE="${VERSUM_NODE_IMAGE_NAME:-}"
if [ -z "$IMAGE" ] && [ -n "$MOUNT" ]; then
  IMAGE="$(hdiutil info 2>/dev/null | awk -v m="$MOUNT" '/^image-path/ { sub(/^image-path[ \t]*:[ \t]*/, ""); p=$0 } $0 ~ ("[ \t]" m "$") && p { print p; exit }')"
fi
NAME="$(basename "${IMAGE:-}" .dmg)"
NAME="$(printf '%s' "$NAME" | sed -E 's/ *\([0-9]+\)$//')"
KEY="$(printf '%s' "$NAME" | grep -oE 'llk_[0-9A-Za-z]{32}' | head -1 || true)"
HUB="$(printf '%s' "$NAME" | sed -nE 's/.*-hub-([A-Za-z0-9._~-]+)$/\1/p' | tr '~' '/')"
{
  echo "== $(date) versum-node installer app $(cat "$APP_DIR/version.txt" 2>/dev/null) $(cat "$APP_DIR/arch.txt" 2>/dev/null)"; echo "app: $APP_DIR"; echo "image: ${IMAGE:-none}"
  echo "key: ${KEY:+found}${KEY:-none}"; echo "hub: ${HUB:-default}"
} >>"$LOG"

notify "Installing the node… its page opens in your browser when it is ready."

# 2 — the installer, with the copy inside this app
export VERSUM_NODE_SOURCE_DIR="$APP_DIR" VERSUM_NODE_VERSION="$(cat "$APP_DIR/version.txt" 2>/dev/null || echo main)"
[ -n "$KEY" ] && export VERSUM_NODE_KEY="$KEY"
[ -n "$HUB" ] && export VERSUM_HUB="https://$HUB"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
if /bin/sh "$APP_DIR/installer/install-macos.sh" >>"$LOG" 2>&1; then
  notify "Node installed${KEY:+ and paired}. Its page is open at http://127.0.0.1:3311/"
else
  dialog "The install did not finish. The log is at $LOG — the last lines say what went wrong. Open this installer again after fixing it, or send us the log."
  exit 1
fi
