#!/usr/bin/env bash
set -euo pipefail

HOOK_DIR="$(git rev-parse --git-path hooks)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_DIR="$REPO_ROOT/scripts/ci/hooks"

mkdir -p "$HOOK_DIR"
for hook in pre-push pre-commit; do
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
  # Never rewrite the hook in place: bash reads a script as it runs it, so a push whose hook is still in its `bun run ci`
  # would read the new file from the old offset and fail (every `bun install` runs this, as `prepare`). A new file
  # renamed over the old one is atomic: a running hook keeps reading its own copy.
  tmp="$dest.tmp.$$"
  cp "$src" "$tmp"
  chmod +x "$tmp"
  mv -f "$tmp" "$dest"
  echo "installed: $dest"
done
