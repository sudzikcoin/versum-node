#!/bin/sh
# versum-node installer — repo-root entry point, so this works on Linux and macOS:
#   curl -fsSL https://raw.githubusercontent.com/sudzikcoin/versum-node/main/install.sh | sh
#   curl -fsSL …/install.sh | VERSUM_HUB=https://launchloop.suverse.io VERSUM_NODE_KEY=llk_… sh    (paired, no typing after)
# Linux  → installer/install.sh        (root: system user + system service; user: user service + linger)
# macOS  → installer/install-macos.sh  (Docker Desktop / OrbStack + launchd agent)
# Windows: PowerShell →  irm https://raw.githubusercontent.com/sudzikcoin/versum-node/main/install.ps1 | iex
# Knobs: VERSUM_NODE_VERSION (ref, default main), VERSUM_NODE_REPO, VERSUM_NODE_HOME, VERSUM_NODE_NODEJS, VERSUM_HUB, VERSUM_NODE_KEY, VERSUM_NODE_NAME.
set -eu
REPO="${VERSUM_NODE_REPO:-https://github.com/sudzikcoin/versum-node}"
VERSION="${VERSUM_NODE_VERSION:-main}"
case "$(uname -s)" in Darwin) script=installer/install-macos.sh ;; Linux) script=installer/install.sh ;; *) printf 'versum-node install: %s is not Linux or macOS. Windows: open PowerShell and run  irm https://raw.githubusercontent.com/sudzikcoin/versum-node/main/install.ps1 | iex\n' "$(uname -s)" >&2; exit 1 ;; esac
here="$(dirname "$0" 2>/dev/null || echo .)"
if [ -f "$here/$script" ]; then exec sh "$here/$script" "$@"; fi
RAW="$(printf '%s' "$REPO" | sed 's|://github.com/|://raw.githubusercontent.com/|')/$VERSION/$script"
exec sh -c "$(curl -fsSL "$RAW")" versum-node-install "$@"
