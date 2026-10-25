#!/bin/sh
# versum-node installer — repo-root entry point, so this works:
#   curl -fsSL https://raw.githubusercontent.com/sudzikcoin/versum-node/main/install.sh | sh
# The installer itself is installer/install.sh (read it first; it never asks for sudo and writes only under $HOME).
# Same knobs: VERSUM_NODE_VERSION (ref, default main), VERSUM_NODE_REPO, VERSUM_NODE_HOME, VERSUM_NODE_NODEJS.
set -eu
REPO="${VERSUM_NODE_REPO:-https://github.com/sudzikcoin/versum-node}"
VERSION="${VERSUM_NODE_VERSION:-main}"
here="$(dirname "$0" 2>/dev/null || echo .)"
if [ -f "$here/installer/install.sh" ]; then exec sh "$here/installer/install.sh" "$@"; fi
RAW="$(printf '%s' "$REPO" | sed 's|://github.com/|://raw.githubusercontent.com/|')/$VERSION/installer/install.sh"
exec sh -c "$(curl -fsSL "$RAW")" versum-node-install "$@"
