#!/usr/bin/env bash
#
# A completeness claim that cannot fail is worse than none.
#
# `buildEnvelope` checks `rowsTotal + excludedCount === universeTotal`. If a
# report computes `universeTotal` FROM those same two quantities, the check
# cannot fail whatever the report did — and it reads to every caller as a
# passed verification. `docs/mcp/CONTRACTS.md` names the shape and its remedy:
# omit the claim rather than synthesize it.
#
# WHY A GATE RATHER THAN A REVIEW ITEM. This appeared FIVE times on 2026-09-03,
# in four different workstreams, and TWO of them were merged and deployed —
# including on the statutory VAT201, whose completeness assurance therefore
# proved nothing. Two blind reviewers read past the merged pair. Every instance
# was ultimately found by running a mutation or by grepping, never by reading.
# A defect that recurs five times in one day across independent authors is not
# an author problem; it is a shape that needs to be unshippable.
#
# WHAT IT MATCHES. A `universeTotal` assignment whose right-hand side adds two
# terms, at least one of which is a `.length` or a name containing `excluded`
# or `rowsTotal` — i.e. the universe being derived from its own parts. It does
# NOT match a universeTotal read from a query result (`Number(row.universe)`),
# a single `.length` over an independently-built candidate set, or a plain
# identifier, because those can be independently derived.
#
# FALSE POSITIVE? A universe genuinely assembled by concatenating two
# independent populations is conceivable. Add the file to the baseline with a
# comment saying which two populations and why neither is the checked quantity.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASELINE="$ROOT/scripts/ci/self-defining-universe.baseline"
cd "$ROOT"

# universeTotal: <something> + <something>, on one line.
PATTERN='universeTotal:[[:space:]]*[A-Za-z0-9_.()]+[[:space:]]*\+[[:space:]]*[A-Za-z0-9_.()]+'

hits=$(grep -rnE "$PATTERN" src/ --include='*.ts' 2>/dev/null || true)

fail=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  file="${line%%:*}"
  # Only flag where a term is a .length, or names excluded/rowsTotal — the
  # shapes that derive the universe from the quantities being checked.
  echo "$line" | grep -qE '\.length|excluded|rowsTotal' || continue
  if [ -f "$BASELINE" ] && grep -qxF "$file" "$BASELINE"; then continue; fi
  echo "  $line"
  fail=1
done <<< "$hits"

if [ "$fail" -eq 1 ]; then
  cat <<'MSG'

[self-defining-universe] A report derives universeTotal from the quantities
buildEnvelope checks it against, so its completeness identity cannot fail.

  Fix: omit universeTotal, or derive it from a SEPARATE query over the
  unfiltered candidate set. See docs/mcp/CONTRACTS.md.

  Note: a disclosure is not an exclusion. A row that was never in this
  company's universe (a cross-tenant orphan, a note about data) belongs
  outside the envelope entirely, not in excludedRows.
MSG
  exit 1
fi

echo "[self-defining-universe] OK — no report derives its own universe"
