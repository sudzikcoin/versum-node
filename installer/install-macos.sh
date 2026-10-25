#!/bin/sh
# versum-node installer — macOS (Apple silicon and Intel).
#   curl -fsSL https://raw.githubusercontent.com/sudzikcoin/versum-node/main/install.sh | sh
# What it does:
#   1. finds Docker Desktop or OrbStack (either gives a VM-isolated Docker, which is what the node needs);
#      if neither is installed it shows the download links and WAITS until one is running
#   2. finds Node.js ≥ 20, or downloads an official macOS build into ~/.versum-node/node (sha256 checked)
#   3. downloads this repository into ~/.versum-node/app
#   4. installs a launchd agent (~/Library/LaunchAgents/io.suverse.versum-node.plist), starts it, and
#      opens the local page http://127.0.0.1:3311/ — everything else happens there
# Writes only under your home. Never asks for sudo.
set -eu
VERSION="${VERSUM_NODE_VERSION:-main}"
REPO="${VERSUM_NODE_REPO:-https://github.com/sudzikcoin/versum-node}"
HOME_DIR="${VERSUM_NODE_HOME:-$HOME/.versum-node}"
NODE_MIN=20
NODE_VERSION="${VERSUM_NODE_NODEJS:-v22.11.0}"
PORT="${VERSUM_NODE_HEALTH_PORT:-3311}"
LABEL=io.suverse.versum-node
say() { printf '%s\n' "$*"; }
die() { printf 'versum-node install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Darwin" ] || die "this is the macOS installer"
[ "$(id -u)" -ne 0 ] || die "run as your normal user, not with sudo"
case "$(uname -m)" in arm64) narch=arm64 ;; x86_64) narch=x64 ;; *) die "unsupported architecture $(uname -m)" ;; esac
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/jobs" "$HOME_DIR/state"; chmod 700 "$HOME_DIR" "$HOME_DIR/jobs" "$HOME_DIR/state"

# 1 — Docker Desktop or OrbStack
docker_ready() { have docker && docker info >/dev/null 2>&1; }
if docker_ready; then
  if [ -d /Applications/OrbStack.app ] || docker info 2>/dev/null | grep -qi orbstack; then say "runtime  OrbStack (Docker in a VM) ✓"; else say "runtime  Docker Desktop (Docker in a VM) ✓"; fi
else
  if [ -d /Applications/Docker.app ]; then say "runtime  Docker Desktop is installed but not running — starting it"; open -a Docker || true
  elif [ -d /Applications/OrbStack.app ]; then say "runtime  OrbStack is installed but not running — starting it"; open -a OrbStack || true
  else
    say "runtime  neither Docker Desktop nor OrbStack is installed. Install one (either works):"
    say "         OrbStack        https://orbstack.dev/download        (lighter, faster)"
    say "         Docker Desktop  https://www.docker.com/products/docker-desktop/"
    if have brew; then say "         or:  brew install --cask orbstack   /   brew install --cask docker"; fi
    say "         This installer waits here until Docker answers, then continues on its own."
    open "https://orbstack.dev/download" 2>/dev/null || true
  fi
  i=0
  until docker_ready; do i=$((i+1)); [ $i -eq 1 ] && printf '         waiting for Docker'; printf '.'; sleep 5; [ $i -gt 720 ] && die "gave up after an hour — run this installer again once Docker is running"; done
  say ""; say "runtime  Docker is answering ✓"
fi

# 2 — node.js
node_ok() { have "$1" && v="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" && [ "${v:-0}" -ge "$NODE_MIN" ]; }
NODE_BIN=""
if node_ok node; then NODE_BIN="$(command -v node)"; say "node.js  $(node -v) found"
elif [ -x "$HOME_DIR/node/bin/node" ] && node_ok "$HOME_DIR/node/bin/node"; then NODE_BIN="$HOME_DIR/node/bin/node"; say "node.js  $("$NODE_BIN" -v) (ours)"
else
  say "node.js  ≥ $NODE_MIN not found — downloading $NODE_VERSION into $HOME_DIR/node"
  tmp="$(mktemp -d)"; tar="node-$NODE_VERSION-darwin-$narch.tar.gz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$tar" -o "$tmp/$tar"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $tar\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || die "node.js download failed its checksum"
  rm -rf "$HOME_DIR/node"; mkdir -p "$HOME_DIR/node"; tar -xzf "$tmp/$tar" -C "$HOME_DIR/node" --strip-components=1; rm -rf "$tmp"
  NODE_BIN="$HOME_DIR/node/bin/node"; say "node.js  $("$NODE_BIN" -v) installed (checksum verified)"
fi

# 3 — the program
rm -rf "$HOME_DIR/app.new"; mkdir -p "$HOME_DIR/app.new"
if [ -n "${VERSUM_NODE_SOURCE_DIR:-}" ] && [ -f "$VERSUM_NODE_SOURCE_DIR/bin/versum-node.mjs" ]; then
  # the .app installer carries the program inside itself (the same files a tag archive has)
  say "program  $VERSION from $VERSUM_NODE_SOURCE_DIR → $HOME_DIR/app"
  cp -R "$VERSUM_NODE_SOURCE_DIR/." "$HOME_DIR/app.new/"
else
  say "program  $REPO @ $VERSION → $HOME_DIR/app"
  tmp="$(mktemp -d)"
  curl -fsSL "$REPO/archive/$VERSION.tar.gz" -o "$tmp/app.tar.gz"
  tar -xzf "$tmp/app.tar.gz" -C "$HOME_DIR/app.new" --strip-components=1; rm -rf "$tmp"
fi
rm -rf "$HOME_DIR/app.prev"; [ -d "$HOME_DIR/app" ] && mv "$HOME_DIR/app" "$HOME_DIR/app.prev"; mv "$HOME_DIR/app.new" "$HOME_DIR/app"
cat > "$HOME_DIR/bin/versum-node" <<EOS
#!/bin/sh
export VERSUM_NODE_HOME="\${VERSUM_NODE_HOME:-$HOME_DIR}"
export PATH="/usr/local/bin:/opt/homebrew/bin:\$HOME/.orbstack/bin:\$PATH"
exec "$NODE_BIN" "$HOME_DIR/app/bin/versum-node.mjs" "\$@"
EOS
chmod 755 "$HOME_DIR/bin/versum-node"
mkdir -p "$HOME/.local/bin"; ln -sf "$HOME_DIR/bin/versum-node" "$HOME/.local/bin/versum-node"

if [ -n "${VERSUM_NODE_KEY:-}" ]; then
  if "$HOME_DIR/bin/versum-node" pair "$VERSUM_NODE_KEY" ${VERSUM_HUB:+--hub="$VERSUM_HUB"} ${VERSUM_NODE_NAME:+--name="$VERSUM_NODE_NAME"} >/dev/null 2>&1; then say "paired   with the key from the site"
  else say "pairing  the key was not accepted by the hub — paste it on the local page instead"; fi
fi

# 4 — launchd agent: starts now and at every login
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cat > "$PLIST" <<EOS
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$HOME_DIR/bin/versum-node</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>VERSUM_NODE_HOME</key><string>$HOME_DIR</string><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>3600</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/state/node.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/state/node.log</string>
</dict></plist>
EOS
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
say "service  launchd agent $LABEL loaded — starts at login, restarts if it stops"

URL="http://127.0.0.1:$PORT/"
say ""
say "installed. What this Mac has:"
"$HOME_DIR/bin/versum-node" scan 2>/dev/null || true
say ""
say "the node is running. Everything else happens on its local page:"
say "  $URL"
say "  pair with your key · choose what to share · set your price · pause · earnings · log"
sleep 2; open "$URL" 2>/dev/null || true
say "log: $HOME_DIR/state/node.log · stop: launchctl bootout gui/$(id -u)/$LABEL"
