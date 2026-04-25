#!/usr/bin/env bash
set -euo pipefail

HOOK_DIR="$(git rev-parse --git-path hooks)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_DIR="$REPO_ROOT/scripts/ci/hooks"

mkdir -p "$HOOK_DIR"
for hook in pre-push; do
  src="$SOURCE_DIR/$hook"
  dest="$HOOK_DIR/$hook"
  if [ ! -f "$src" ]; then
    echo "skipping: $src missing" >&2
    continue
  fi
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
    backup="$dest.bak.$(date +%s)"
    cp "$dest" "$backup"
    echo "backed up existing $dest -> $backup"
  fi
  cp "$src" "$dest"
  chmod +x "$dest"
  echo "installed: $dest"
done
