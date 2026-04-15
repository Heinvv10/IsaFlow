#!/usr/bin/env bash
# CI guard: forbid `decodeToken` imports outside src/lib/auth/jwt.ts.
# `decodeToken` returns a JWT payload WITHOUT signature verification and is
# intended only for internal expiry checks inside jwt.ts itself.
# See docs/audits/2026-04-14/02-security-findings.md#S-007.
set -euo pipefail

OFFENDERS=$(grep -rn "import.*decodeToken" src/ pages/ 2>/dev/null | grep -v 'src/lib/auth/jwt\.ts' || true)
if [[ -n "$OFFENDERS" ]]; then
  echo "ERROR: decodeToken is internal-only. Do not import outside src/lib/auth/jwt.ts."
  echo "Verified JWT checks must use verifyToken() from the same module."
  echo
  echo "Offenders:"
  echo "$OFFENDERS"
  exit 1
fi

echo "OK: decodeToken imports scoped correctly."

echo
echo "=== BL-13: every gl_journal_lines query must scope by company_id ==="
# Match "FROM gl_journal_lines" or "JOIN gl_journal_lines"; require je.company_id or jl.company_id
# within 20 lines (either direction) of the match.
# customReportFieldDefs.ts contains a string-template FROM clause (not an executed query).
# Scoping is enforced in customReportRunner.ts which adds jl.company_id to whereParts.
VIOLATIONS=$(grep -rnE "FROM gl_journal_lines|JOIN gl_journal_lines" src/ pages/ --include='*.ts' 2>/dev/null | grep -v 'customReportFieldDefs\.ts' | while IFS=: read -r file line _; do
  ctx=$(awk -v start="$((line>20?line-20:1))" -v end="$((line+20))" 'NR>=start && NR<=end' "$file")
  if ! echo "$ctx" | grep -qE "(jl|je|gjl)\.company_id"; then
    echo "$file:$line"
  fi
done)

if [[ -n "$VIOLATIONS" ]]; then
  echo "ERROR: gl_journal_lines usage without company_id scoping:"
  echo "$VIOLATIONS"
  exit 1
fi
echo "OK: gl_journal_lines usage is tenant-scoped."
