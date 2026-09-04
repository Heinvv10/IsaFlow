#!/usr/bin/env bash
#
# A duplicate finding ID is worse than a missing one.
#
# `docs/mcp/FINDINGS.md` section B is a register: each row's `#` column is a
# permanent id (B1, B2, ...) that gets cited elsewhere — in commits, in PR
# descriptions, in conversation. Two parallel workstreams each picked the next
# free number on the same day and both claimed it, so B-numbers collided
# twice in one day. A collision is silent: nothing renders wrong, nothing
# fails a build, and the two findings merge into one citation that means
# either of two different defects depending on who you ask.
#
# WHAT IT CHECKS. Every table row in FINDINGS.md whose first column is a bare
# `B<number>` id. Fails if any number appears twice.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FINDINGS="$ROOT/docs/mcp/FINDINGS.md"

if [ ! -f "$FINDINGS" ]; then
  echo "[findings-numbering] SKIP — $FINDINGS not found"
  exit 0
fi

dupes=$(grep -oE '^\| B[0-9]+ \|' "$FINDINGS" \
  | sed -E 's/^\| (B[0-9]+) \|$/\1/' \
  | sort \
  | uniq -d)

if [ -n "$dupes" ]; then
  echo "[findings-numbering] Duplicate finding id(s) in docs/mcp/FINDINGS.md:"
  echo "$dupes" | sed 's/^/  /'
  cat <<'MSG'

  Fix: renumber the later finding to the next unused B-number. Check
  master first — a finding merging around the same time as yours may have
  already taken the number you picked.
MSG
  exit 1
fi

echo "[findings-numbering] OK — no duplicate finding ids"
