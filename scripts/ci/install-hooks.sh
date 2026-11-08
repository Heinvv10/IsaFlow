#!/usr/bin/env bash
set -euo pipefail

HOOK_DIR="$(git rev-parse --git-path hooks)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_DIR="$REPO_ROOT/scripts/ci/hooks"

# A copy that fails half way (cp, chmod or mv) leaves no temporary file behind.
tmp=""
trap 'if [ -n "$tmp" ]; then rm -f "$tmp"; fi' EXIT

mkdir -p "$HOOK_DIR"
for hook in pre-push pre-commit; do
  src="$SOURCE_DIR/$hook"
  dest="$HOOK_DIR/$hook"
  if [ ! -f "$src" ]; then
    echo "skipping: $src missing" >&2
    continue
  fi
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
    # The second's timestamp and this process: two installs in one second never write the same backup.
    backup="$dest.bak.$(date +%s).$$"
    cp "$dest" "$backup"
    echo "backed up existing $dest -> $backup"
  fi
  # Never rewrite the hook in place: bash reads a script as it runs it, so a push whose hook is still in its `bun run ci`
  # would read the new file from the old offset and fail (every `bun install` runs this, as `prepare`). A new file
  # renamed over the old one is atomic: a running hook keeps reading its own copy. A hook that is a SYMLINK is replaced
  # by a regular copy of the source (the rename replaces the link, never the file it points at).
  tmp="$dest.tmp.$$"
  cp "$src" "$tmp"
  chmod +x "$tmp"
  mv -f "$tmp" "$dest"
  tmp=""
  echo "installed: $dest"
done
