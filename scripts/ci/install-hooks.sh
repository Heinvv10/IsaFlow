#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_DIR="$REPO_ROOT/.git/hooks"
SOURCE_DIR="$REPO_ROOT/scripts/ci/hooks"

mkdir -p "$HOOK_DIR"
for hook in pre-push pre-commit; do
  src="$SOURCE_DIR/$hook"
  dest="$HOOK_DIR/$hook"
  if [ -f "$src" ]; then
    cp "$src" "$dest"
    chmod +x "$dest"
    echo "installed: $dest"
  fi
done
