#!/usr/bin/env bash
#
# `is_active` is a PICKER flag, not a balance filter.
#
# It controls whether an account appears in a dropdown. It says nothing about
# whether the account still holds money, and a deactivated account with a live
# balance is still on the balance sheet. `casewareExportService` filtered
# `ga.is_active = true` before summing and dropped a dormant account carrying
# R130,000, leaving the export out of balance by exactly that amount. Four
# inactive accounts on that company carry R137,317.39 between them, R6,550 of it
# cash.
#
# THE DISCRIMINATOR, because a rule that flags every use gets suppressed within
# a week: does this query COMPUTE A BALANCE, or does it POPULATE A LIST A HUMAN
# CHOOSES FROM? The first must never filter `is_active`; the second should. The
# proxy used here is a money `SUM(` within twenty lines of the predicate, which
# on this codebase gives 18 hits with 2 false positives — both `FROM users`,
# counting active user accounts, and both excluded below. Precision on the class
# that matters is 16/16.
#
# REPORT-ONLY, AGAINST A BASELINE. Sixteen sites exist today and another session
# is sweeping them; failing the build on all sixteen would block everyone for no
# gain. This fails only on a FILE that is not in the baseline — so the sweep can
# proceed while no new offender can be added. To make it blocking once the sweep
# lands, delete the baseline file.
#
# The baseline is by FILE, not by file:line, on purpose. A line-number baseline
# goes stale the moment anyone edits above the offending line, and the sweep is
# in flight right now. The cost is that a SECOND offence inside an
# already-listed file is not caught; that is the right trade while the list is
# shrinking, and it disappears with the baseline.
#
# NOT COVERED, deliberately: a predicate in a LEFT JOIN ON clause, which
# restricts nothing and lets unmatched rows survive to be summed anyway
# (kpiChartsService summed every bank transaction regardless of account this
# way). That is a data-flow property, not a syntactic one: the same shape is
# CORRECT in twenty other places here, e.g.
# `LEFT JOIN subscriptions s ON s.company_id = c.id AND s.status IN (...)`,
# where unmatched rows surviving is the entire point of the outer join. A grep
# for it cries wolf. It belongs in the review checklist.

set -uo pipefail
cd "$(dirname "$0")/../.."

BASELINE="scripts/ci/is-active-in-balances.baseline"

scan() {
  local f
  for f in $(grep -rl "is_active" src pages --include='*.ts' 2>/dev/null); do
    awk -v F="$f" '
      { a[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          ln = a[i]
          # Comments explain the rule; they do not break it.
          if (ln ~ /^[[:space:]]*(\*|\/\/)/) continue
          if (ln !~ /is_active[[:space:]]*=[[:space:]]*(true|TRUE)/) continue
          # Counting active USERS is not a balance. The only false-positive
          # class the scan produces, and it is excluded by name.
          if (ln ~ /FROM users/) continue
          lo = (i > 20 ? i - 20 : 1); hi = (i + 20 > NR ? NR : i + 20)
          ctx = ""
          for (j = lo; j <= hi; j++) ctx = ctx a[j]
          if (ctx ~ /SUM\(/) { print F; exit }
        }
      }' "$f"
  done | sort
}

echo "=== is_active must not filter a query that computes a balance ==="
FOUND=$(scan)

if [[ ! -f "$BASELINE" ]]; then
  if [[ -n "$FOUND" ]]; then
    echo "ERROR: is_active filters a balance query in:"
    echo "$FOUND"
    echo
    echo "is_active is a picker flag. A deactivated account with a live balance is"
    echo "still on the balance sheet — drop the filter, or report the row instead."
    exit 1
  fi
  echo "OK: no balance query filters on is_active."
  exit 0
fi

BASE=$(grep -vE "^\s*(#|$)" "$BASELINE" | sort)
NEW=$(comm -23 <(echo "$FOUND") <(echo "$BASE"))
if [[ -n "$NEW" ]]; then
  echo "ERROR: NEW file(s) filtering is_active in a balance query:"
  echo "$NEW"
  echo
  echo "is_active is a picker flag, not a balance filter. A deactivated account"
  echo "with a live balance is still on the balance sheet. Drop the filter, or"
  echo "report the row rather than dropping it."
  exit 1
fi

FIXED=$(comm -13 <(echo "$FOUND") <(echo "$BASE"))
echo "OK: no new files. $(echo "$FOUND" | grep -c . ) baselined file(s) remain."
if [[ -n "$FIXED" ]]; then
  echo "Baselined file(s) now clean — remove them from $BASELINE:"
  echo "$FIXED"
fi
