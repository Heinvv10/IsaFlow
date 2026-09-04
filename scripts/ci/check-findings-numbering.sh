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
# WHAT IT CHECKS. Every table row between the "## B." heading and the next
# "## " heading, whose first cell is meant to be a bare `B<number>` id —
# tolerant of the cell's surrounding whitespace (`|B60|`, `| B60 |`, and a
# trailing-space variant all parse the same way). Fails if any number
# appears twice, OR if a row's first cell is close to a B-id but does not
# parse as one cleanly (a typo, or a new row format nobody told this script
# about) — that case is refused rather than silently skipped, because a gate
# that can't fail on the malformed case reads as verification while proving
# nothing. The header row (`# `) and the markdown separator row (`---`) are
# the only first cells this script recognizes as not being findings.
#
# Ids are compared numerically, so `B01` collides with `B1` — but they are
# still compared as the SAME number, not as distinct strings that happen to
# render the same digit sequence. The register's convention is unpadded
# ids; nothing here validates that convention itself, only that whatever
# number a row claims isn't claimed twice.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FINDINGS="$ROOT/docs/mcp/FINDINGS.md"

if [ ! -f "$FINDINGS" ]; then
  echo "[findings-numbering] SKIP — $FINDINGS not found"
  exit 0
fi

output=$(awk '
  /^## B\./ { insection=1; next }
  /^## / { insection=0 }
  insection && /^\|/ {
    line = $0
    n = split(line, cells, "|")
    cell = cells[2]
    gsub(/^[ \t]+|[ \t]+$/, "", cell)
    if (cell == "#") next                 # header row
    if (cell ~ /^:?-+:?$/) next           # markdown separator row
    if (cell ~ /^B[0-9]+$/) {
      num = cell
      sub(/^B/, "", num)
      num = num + 0          # numeric key: B01 and B1 collide
      count[num]++
      if (count[num] == 1) { firstline[num] = line }
      else { print "DUP\t" cell "\t" line }
    } else {
      print "MALFORMED\t" cell "\t" line
    }
  }
' "$FINDINGS")

if [ -z "$output" ]; then
  echo "[findings-numbering] OK — no duplicate or malformed finding ids"
  exit 0
fi

fail=0
dup_lines=""
malformed_lines=""
while IFS=$'\t' read -r kind id line; do
  [ -z "$kind" ] && continue
  fail=1
  if [ "$kind" = "DUP" ]; then
    dup_lines="${dup_lines}  ${id}: ${line}\n"
  else
    malformed_lines="${malformed_lines}  ${line}\n"
  fi
done <<< "$output"

if [ -n "$dup_lines" ]; then
  echo "[findings-numbering] Duplicate finding id(s) in docs/mcp/FINDINGS.md:"
  printf '%b' "$dup_lines"
fi

if [ -n "$malformed_lines" ]; then
  echo "[findings-numbering] Row(s) in section B that do not parse as a bare B<number> id:"
  printf '%b' "$malformed_lines"
fi

cat <<'MSG'

  Fix a duplicate: renumber the later finding to the next unused B-number.
  Check master first — a finding merging around the same time as yours may
  have already taken the number you picked.

  Fix a malformed row: the first cell of a section-B table row must be
  exactly `B<number>` (whitespace around it is fine). If this is a
  deliberate new row shape, this script needs to learn it too — don't just
  reformat the row to dodge the check.
MSG

exit "$fail"
