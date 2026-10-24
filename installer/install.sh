#!/bin/sh
# versum-node installer — Linux, rootless, nothing outside ~/.versum-node and ~/.config/systemd/user.
#   curl -fsSL https://versum.suverse.io/install.sh | sh
# What it does, in order, and says so:
#   1. checks the OS and architecture (Linux x86_64 / aarch64)
#   2. finds Node.js ≥ 20, or downloads an official build into ~/.versum-node/node (sha256 checked)
#   3. finds a container runtime (podman preferred, docker accepted) and tells you how to install one if missing
#   4. downloads this repository at the pinned ref into ~/.versum-node/app
#   5. installs a user systemd unit (not started) and prints the two commands that pair and start the node
# It never asks for sudo and never writes outside your home. Read it before you run it — that is the point.
set -eu

VERSION="${VERSUM_NODE_VERSION:-main}"
REPO="${VERSUM_NODE_REPO:-https://github.com/sudzikcoin/versum-node}"
HOME_DIR="${VERSUM_NODE_HOME:-$HOME/.versum-node}"
NODE_MIN=20
NODE_VERSION="${VERSUM_NODE_NODEJS:-v22.11.0}"

say() { printf '%s\n' "$*"; }
die() { printf 'versum-node install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# 1 — platform
os="$(uname -s)"; arch="$(uname -m)"
[ "$os" = "Linux" ] || die "v1 runs on Linux only (found $os). macOS and Windows come with Docker Desktop support later."
case "$arch" in x86_64) narch=x64 ;; aarch64|arm64) narch=arm64 ;; *) die "unsupported architecture $arch" ;; esac
[ "$(id -u)" -ne 0 ] || die "run as your normal user, not root: the node is rootless by design"
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/jobs" "$HOME_DIR/state"; chmod 700 "$HOME_DIR" "$HOME_DIR/jobs" "$HOME_DIR/state"

# 2 — node.js
node_ok() { have "$1" && v="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" && [ "${v:-0}" -ge "$NODE_MIN" ]; }
NODE_BIN=""
if node_ok node; then NODE_BIN="$(command -v node)"; say "node.js  $(node -v) found"
elif node_ok "$HOME_DIR/node/bin/node"; then NODE_BIN="$HOME_DIR/node/bin/node"; say "node.js  $("$NODE_BIN" -v) (ours)"
else
  say "node.js  ≥ $NODE_MIN not found — downloading $NODE_VERSION into $HOME_DIR/node"
  have curl || die "curl is required"
  tmp="$(mktemp -d)"; tar="node-$NODE_VERSION-linux-$narch.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$tar" -o "$tmp/$tar"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $tar\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "node.js download failed its checksum"
  rm -rf "$HOME_DIR/node"; mkdir -p "$HOME_DIR/node"; tar -xJf "$tmp/$tar" -C "$HOME_DIR/node" --strip-components=1; rm -rf "$tmp"
  NODE_BIN="$HOME_DIR/node/bin/node"; say "node.js  $("$NODE_BIN" -v) installed (checksum verified)"
fi

# 3 — container runtime
if have podman; then say "runtime  podman $(podman --version | awk '{print $NF}')"
elif have docker; then say "runtime  docker $(docker --version | awk '{print $3}' | tr -d ,) — rootless Docker is required; rootful Docker is refused unless VERSUM_NODE_ALLOW_ROOTFUL=1"
else
  say "runtime  none found. Install rootless Podman, then run this installer again:"
  if have apt-get; then say "         sudo apt-get install -y podman uidmap slirp4netns"
  elif have dnf; then say "         sudo dnf install -y podman"
  elif have pacman; then say "         sudo pacman -S podman"
  else say "         https://podman.io/docs/installation"; fi
fi

# 4 — the program
say "program  $REPO @ $VERSION → $HOME_DIR/app"
have curl || die "curl is required"
tmp="$(mktemp -d)"
curl -fsSL "$REPO/archive/$VERSION.tar.gz" -o "$tmp/app.tar.gz"
rm -rf "$HOME_DIR/app.new"; mkdir -p "$HOME_DIR/app.new"; tar -xzf "$tmp/app.tar.gz" -C "$HOME_DIR/app.new" --strip-components=1; rm -rf "$tmp"
rm -rf "$HOME_DIR/app.prev"; [ -d "$HOME_DIR/app" ] && mv "$HOME_DIR/app" "$HOME_DIR/app.prev"; mv "$HOME_DIR/app.new" "$HOME_DIR/app"
cat > "$HOME_DIR/bin/versum-node" <<EOF
#!/bin/sh
export VERSUM_NODE_HOME="\${VERSUM_NODE_HOME:-$HOME_DIR}"
exec "$NODE_BIN" "$HOME_DIR/app/bin/versum-node.mjs" "\$@"
EOF
chmod 755 "$HOME_DIR/bin/versum-node"
mkdir -p "$HOME/.local/bin"; ln -sf "$HOME_DIR/bin/versum-node" "$HOME/.local/bin/versum-node"

# 5 — the unit (installed, not started)
mkdir -p "$HOME/.config/systemd/user"
sed "s|%h/.versum-node|$HOME_DIR|g" "$HOME_DIR/app/installer/versum-node.service" > "$HOME/.config/systemd/user/versum-node.service"
if have systemctl; then systemctl --user daemon-reload 2>/dev/null || true; fi

say ""
say "installed. What this machine has:"
"$HOME_DIR/bin/versum-node" scan || true
say ""
say "next:"
say "  1. get a node key on the site (connect your computer) and pair:   versum-node pair llk_…"
say "  2. choose what to share and your price:                            versum-node offer --cpu=4 --ram-gb=8 --price=0.02"
say "  3. start:   systemctl --user enable --now versum-node   (and: loginctl enable-linger \$USER)"
say "status: versum-node status · http://127.0.0.1:3311/ · journalctl --user -u versum-node -f"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "note: add \$HOME/.local/bin to your PATH, or call $HOME_DIR/bin/versum-node" ;; esac
