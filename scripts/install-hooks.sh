#!/usr/bin/env bash
# Installs project git hooks into .git/hooks/.
# Run once after cloning the repository.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/scripts/hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_SRC" ]; then
  echo "ERROR: $HOOKS_SRC does not exist." >&2
  exit 1
fi

for hook in "$HOOKS_SRC"/*; do
  name="$(basename "$hook")"
  dest="$HOOKS_DST/$name"

  cp "$hook" "$dest"
  chmod +x "$dest"
  echo "Installed: $dest"
done

echo "All hooks installed."
