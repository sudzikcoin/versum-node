#!/bin/sh
# versum-node installer — macOS (v0.4.0, Apple silicon and Intel). Nothing to install first: no Docker, no
# Node.js, no admin password. The disk image carries a single `versum-node` binary and an embedded Python; jobs
# run under macOS's own sandbox (sandbox-exec). This script is what "Versum Node Installer.app" runs
# (packaging/macos/launcher.sh) with VERSUM_NODE_SOURCE_DIR pointing inside the bundle.
#   1. copies <source>/versum-node, <source>/python, <source>/probe, pylib-lock.json into ~/.versum-node/app (quarantine cleared)
#   2. pairs with VERSUM_NODE_KEY / VERSUM_HUB when the launcher found them in the image's file name
#   3. installs a launchd agent (~/Library/LaunchAgents/io.suverse.versum-node.plist), starts it, waits for the
#      local page http://127.0.0.1:3311/ and opens it
# Writes only under your home. Never asks for sudo.
set -eu
VERSION="${VERSUM_NODE_VERSION:-main}"
HOME_DIR="${VERSUM_NODE_HOME:-$HOME/.versum-node}"
PORT="${VERSUM_NODE_HEALTH_PORT:-3311}"
LABEL=io.suverse.versum-node
SRC="${VERSUM_NODE_SOURCE_DIR:-}"
say() { printf '%s\n' "$*"; }
die() { printf 'versum-node install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this is the macOS installer"
[ "$(id -u)" -ne 0 ] || die "run as your normal user, not with sudo"
[ -n "$SRC" ] && [ -x "$SRC/versum-node" ] || die "no program to install: VERSUM_NODE_SOURCE_DIR must hold versum-node (open the installer from the disk image)"
case "$(uname -m)" in
  arm64) want=arm64 ;; x86_64) want=x86_64 ;; *) die "unsupported architecture $(uname -m)" ;;
esac
have="$(cat "$SRC/arch.txt" 2>/dev/null || echo unknown)"
if [ "$have" != "$want" ] && [ "$have" != "unknown" ]; then
  if [ "$want" = "arm64" ] && [ "$have" = "x86_64" ]; then say "note     this is the Intel build on an Apple silicon Mac; it runs under Rosetta — the Apple silicon build is faster"
  else die "this disk image is for $have Macs and this Mac is $want — download the other one from the site"; fi
fi
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/jobs" "$HOME_DIR/state"; chmod 700 "$HOME_DIR" "$HOME_DIR/jobs" "$HOME_DIR/state"

# 1 — the program: binary + python + probe, atomically swapped into place
say "program  versum-node $VERSION ($have) from $SRC → $HOME_DIR/app"
rm -rf "$HOME_DIR/app.new"; mkdir -p "$HOME_DIR/app.new"
cp "$SRC/versum-node" "$HOME_DIR/app.new/versum-node"; chmod 755 "$HOME_DIR/app.new/versum-node"
cp -R "$SRC/python" "$HOME_DIR/app.new/python"
cp -R "$SRC/probe" "$HOME_DIR/app.new/probe"
for f in version.txt arch.txt pylib-lock.json README.md LICENSE; do [ -f "$SRC/$f" ] && cp "$SRC/$f" "$HOME_DIR/app.new/$f"; done   # 0.4.2: the wheel lock rides along
xattr -dr com.apple.quarantine "$HOME_DIR/app.new" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -rf "$HOME_DIR/app.prev"; [ -d "$HOME_DIR/app" ] && mv "$HOME_DIR/app" "$HOME_DIR/app.prev"; mv "$HOME_DIR/app.new" "$HOME_DIR/app"
cat > "$HOME_DIR/bin/versum-node" <<EOS
#!/bin/sh
export VERSUM_NODE_HOME="\${VERSUM_NODE_HOME:-$HOME_DIR}"
exec "$HOME_DIR/app/versum-node" "\$@"
EOS
chmod 755 "$HOME_DIR/bin/versum-node"
mkdir -p "$HOME/.local/bin"; ln -sf "$HOME_DIR/bin/versum-node" "$HOME/.local/bin/versum-node"
"$HOME_DIR/bin/versum-node" version >/dev/null 2>&1 || die "the binary does not start on this Mac ($(uname -m))"

# 2 — pairing from the image's file name
if [ -n "${VERSUM_NODE_KEY:-}" ]; then
  if "$HOME_DIR/bin/versum-node" pair "$VERSUM_NODE_KEY" ${VERSUM_HUB:+--hub="$VERSUM_HUB"} ${VERSUM_NODE_NAME:+--name="$VERSUM_NODE_NAME"} >/dev/null 2>&1; then say "paired   with the key from the site"
  else say "pairing  the key was not accepted by the hub — paste it on the local page instead"; fi
fi

# 3 — launchd agent: starts now and at every login
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOS
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$HOME_DIR/app/versum-node</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>VERSUM_NODE_HOME</key><string>$HOME_DIR</string>${VERSUM_NODE_HEARTBEAT_SECONDS:+<key>VERSUM_NODE_HEARTBEAT_SECONDS</key><string>$VERSUM_NODE_HEARTBEAT_SECONDS</string>}<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ExitTimeOut</key><integer>3600</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/state/node.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/state/node.log</string>
</dict></plist>
EOS
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
say "service  launchd agent $LABEL loaded — starts at login, restarts if it stops"

URL="http://127.0.0.1:$PORT/"
i=0; until curl -fsS -m 2 "${URL}api/state" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && break; sleep 1; done
say ""
say "installed. What this Mac has:"
"$HOME_DIR/bin/versum-node" scan 2>/dev/null || true
say ""
say "the node is running. Everything else happens on its local page:"
say "  $URL"
open "$URL" 2>/dev/null || true
say "log: $HOME_DIR/state/node.log · stop: launchctl bootout gui/$(id -u)/$LABEL · remove: $HOME_DIR/app/uninstall.sh"
cat > "$HOME_DIR/app/uninstall.sh" <<EOS
#!/bin/sh
# removes the Versum node from this Mac: the agent, the program, the config (your key) and the jobs directory
launchctl bootout "gui/\$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST" "$HOME/.local/bin/versum-node"
rm -rf "$HOME_DIR"
echo "Versum node removed."
EOS
chmod 755 "$HOME_DIR/app/uninstall.sh"
