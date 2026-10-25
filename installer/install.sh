#!/bin/sh
# versum-node installer — Linux.
#   curl -fsSL https://raw.githubusercontent.com/sudzikcoin/versum-node/main/install.sh | sh
#   (with the key from the site, so nothing is typed afterwards:)
#   curl -fsSL …/install.sh | VERSUM_HUB=https://launchloop.suverse.io VERSUM_NODE_KEY=llk_… sh
#
# What it does, in order, and says so:
#   1. checks the OS and architecture (Linux x86_64 / aarch64)
#   2. as root: creates the system user `versum` (no login shell) and installs under /var/lib/versum-node;
#      as a normal user: installs under ~/.versum-node — nothing outside your home and ~/.config/systemd/user
#   3. finds Node.js ≥ 20, or downloads an official build (sha256 checked)
#   4. finds a container runtime (podman preferred, docker accepted; a ROOTFUL docker daemon is not used
#      until you allow it once on the local page) and says how to install one if missing
#   5. downloads this repository at the pinned ref
#   6. installs a systemd unit (system-level as root, user-level with linger otherwise), STARTS it,
#      and opens the local page http://127.0.0.1:3311/ — pairing, what you share, your price, pause,
#      earnings and the log all live there. No terminal is needed after this script ends.
# Read it before you run it — that is the point.
set -eu

VERSION="${VERSUM_NODE_VERSION:-main}"
REPO="${VERSUM_NODE_REPO:-https://github.com/sudzikcoin/versum-node}"
NODE_MIN=20
NODE_VERSION="${VERSUM_NODE_NODEJS:-v22.11.0}"
PORT="${VERSUM_NODE_HEALTH_PORT:-3311}"

say() { printf '%s\n' "$*"; }
die() { printf 'versum-node install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# 1 — platform
os="$(uname -s)"; arch="$(uname -m)"
[ "$os" = "Linux" ] || die "this is the Linux installer (found $os); macOS: installer/install-macos.sh, Windows: installer/install.ps1 — the root install.sh picks the right one"
case "$arch" in x86_64) narch=x64 ;; aarch64|arm64) narch=arm64 ;; *) die "unsupported architecture $arch" ;; esac

# 2 — who installs, where
if [ "$(id -u)" -eq 0 ]; then
  MODE=system
  SVC_USER=versum
  HOME_DIR="${VERSUM_NODE_HOME:-/var/lib/versum-node}"
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    say "user     creating system user $SVC_USER (no login shell, home $HOME_DIR)"
    if have useradd; then useradd --system --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null || useradd --system --home-dir "$HOME_DIR" --create-home --shell /bin/false "$SVC_USER"
    elif have adduser; then adduser -S -D -H -h "$HOME_DIR" -s /sbin/nologin "$SVC_USER"
    else die "neither useradd nor adduser found"; fi
  else say "user     $SVC_USER exists"; fi
  mkdir -p "$HOME_DIR"; chown "$SVC_USER:$SVC_USER" "$HOME_DIR"
  as_user() { if have runuser; then runuser -u "$SVC_USER" -- "$@"; else su -s /bin/sh "$SVC_USER" -c "$(printf '%q ' "$@")"; fi; }
else
  MODE=user
  SVC_USER="$(id -un)"
  HOME_DIR="${VERSUM_NODE_HOME:-$HOME/.versum-node}"
  as_user() { "$@"; }
fi
say "mode     $MODE install as $SVC_USER → $HOME_DIR"
as_user mkdir -p "$HOME_DIR/bin" "$HOME_DIR/jobs" "$HOME_DIR/state"
as_user chmod 700 "$HOME_DIR" "$HOME_DIR/jobs" "$HOME_DIR/state"

# 3 — node.js
node_ok() { have "$1" && v="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" && [ "${v:-0}" -ge "$NODE_MIN" ]; }
NODE_BIN=""
if node_ok node; then NODE_BIN="$(command -v node)"; say "node.js  $(node -v) found"
elif [ -x "$HOME_DIR/node/bin/node" ] && node_ok "$HOME_DIR/node/bin/node"; then NODE_BIN="$HOME_DIR/node/bin/node"; say "node.js  $("$NODE_BIN" -v) (ours)"
else
  say "node.js  ≥ $NODE_MIN not found — downloading $NODE_VERSION into $HOME_DIR/node"
  have curl || die "curl is required"
  tmp="$(mktemp -d)"; tar="node-$NODE_VERSION-linux-$narch.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$tar" -o "$tmp/$tar"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $tar\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "node.js download failed its checksum"
  rm -rf "$HOME_DIR/node"; mkdir -p "$HOME_DIR/node"; tar -xJf "$tmp/$tar" -C "$HOME_DIR/node" --strip-components=1; rm -rf "$tmp"
  [ "$MODE" = system ] && chown -R "$SVC_USER:$SVC_USER" "$HOME_DIR/node"
  NODE_BIN="$HOME_DIR/node/bin/node"; say "node.js  $("$NODE_BIN" -v) installed (checksum verified)"
fi

# 4 — container runtime
RUNTIME=none
if have podman; then RUNTIME=podman; say "runtime  podman $(podman --version | awk '{print $NF}')"
elif have docker; then
  RUNTIME=docker
  say "runtime  docker $(docker --version | awk '{print $3}' | tr -d ,)"
  if [ "$MODE" = system ] && getent group docker >/dev/null 2>&1; then
    # membership lets the node TALK to the daemon; the node still refuses a rootful daemon until you allow it on the local page
    usermod -aG docker "$SVC_USER" 2>/dev/null && say "         $SVC_USER added to the docker group — a ROOTFUL daemon is used only after your one-time consent on the local page"
  fi
else
  say "runtime  none found. The node starts anyway and shows this on its page; install rootless Podman, then restart it:"
  if have apt-get; then say "         sudo apt-get install -y podman uidmap slirp4netns"
  elif have dnf; then say "         sudo dnf install -y podman"
  elif have pacman; then say "         sudo pacman -S podman"
  else say "         https://podman.io/docs/installation"; fi
fi

# 5 — the program
say "program  $REPO @ $VERSION → $HOME_DIR/app"
have curl || die "curl is required"
tmp="$(mktemp -d)"
curl -fsSL "$REPO/archive/$VERSION.tar.gz" -o "$tmp/app.tar.gz"
rm -rf "$HOME_DIR/app.new"; mkdir -p "$HOME_DIR/app.new"; tar -xzf "$tmp/app.tar.gz" -C "$HOME_DIR/app.new" --strip-components=1; rm -rf "$tmp"
rm -rf "$HOME_DIR/app.prev"; [ -d "$HOME_DIR/app" ] && mv "$HOME_DIR/app" "$HOME_DIR/app.prev"; mv "$HOME_DIR/app.new" "$HOME_DIR/app"
cat > "$HOME_DIR/bin/versum-node" <<EOS
#!/bin/sh
export VERSUM_NODE_HOME="\${VERSUM_NODE_HOME:-$HOME_DIR}"
exec "$NODE_BIN" "$HOME_DIR/app/bin/versum-node.mjs" "\$@"
EOS
chmod 755 "$HOME_DIR/bin/versum-node"
[ "$MODE" = system ] && chown -R "$SVC_USER:$SVC_USER" "$HOME_DIR/app" "$HOME_DIR/bin"

# the key from the site, when the one-liner carried it: paired before the first start, so the page opens ready
if [ -n "${VERSUM_NODE_KEY:-}" ]; then
  if as_user env VERSUM_NODE_HOME="$HOME_DIR" "$HOME_DIR/bin/versum-node" pair "$VERSUM_NODE_KEY" ${VERSUM_HUB:+--hub="$VERSUM_HUB"} ${VERSUM_NODE_NAME:+--name="$VERSUM_NODE_NAME"} >/dev/null 2>&1; then
    say "paired   with the key from the site"
  else say "pairing  the key was not accepted by the hub — paste it on the local page instead"; fi
fi

# 6 — the service: started, and the page opened
if [ "$MODE" = system ]; then
  ln -sf "$HOME_DIR/bin/versum-node" /usr/local/bin/versum-node
  sed "s|/var/lib/versum-node|$HOME_DIR|g; s|User=versum|User=$SVC_USER|; s|Group=versum|Group=$SVC_USER|" "$HOME_DIR/app/installer/versum-node-system.service" > /etc/systemd/system/versum-node.service
  if have systemctl; then
    systemctl daemon-reload
    systemctl enable --now versum-node && say "service  versum-node (system) enabled and started"
  else say "service  no systemd here: run  $HOME_DIR/bin/versum-node start  under $SVC_USER with your supervisor"; fi
  STATUS_CMD="systemctl status versum-node · journalctl -u versum-node -f"
else
  mkdir -p "$HOME/.local/bin"; ln -sf "$HOME_DIR/bin/versum-node" "$HOME/.local/bin/versum-node"
  mkdir -p "$HOME/.config/systemd/user"
  sed "s|%h/.versum-node|$HOME_DIR|g" "$HOME_DIR/app/installer/versum-node.service" > "$HOME/.config/systemd/user/versum-node.service"
  if have systemctl && systemctl --user daemon-reload 2>/dev/null; then
    systemctl --user enable --now versum-node && say "service  versum-node (user) enabled and started"
    if have loginctl; then loginctl enable-linger "$SVC_USER" 2>/dev/null && say "linger   enabled — the node keeps running when you log out" || say "linger   could not be enabled (run: loginctl enable-linger $SVC_USER) — the node stops when you log out"; fi
  else
    say "service  no user systemd here — starting the node in the background instead"
    nohup "$HOME_DIR/bin/versum-node" start >> "$HOME_DIR/state/node.log" 2>&1 &
  fi
  STATUS_CMD="systemctl --user status versum-node · journalctl --user -u versum-node -f"
fi

URL="http://127.0.0.1:$PORT/"
say ""
say "installed. What this machine has:"
as_user env VERSUM_NODE_HOME="$HOME_DIR" "$HOME_DIR/bin/versum-node" scan 2>/dev/null || true
say ""
say "the node is running. Everything else happens on its local page:"
say "  $URL"
say "  pair with your key · choose what to share · set your price · pause · earnings · log"
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && [ "$MODE" = user ] && have xdg-open; then (xdg-open "$URL" >/dev/null 2>&1 &) ; say "  (opening it in your browser)"
elif [ "$MODE" = system ]; then say "  on a server without a browser: ssh -L $PORT:127.0.0.1:$PORT $(hostname)  then open the URL on your own machine"; fi
say "status: $STATUS_CMD"
