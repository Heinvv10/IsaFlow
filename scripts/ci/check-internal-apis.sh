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

echo
echo "=== Pentest H7: client IP must come from getClientIp(), never x-forwarded-for[0] ==="
# The first entry in X-Forwarded-For is client-supplied and therefore spoofable.
# getClientIp() in src/lib/rateLimit.ts takes the last (proxy-appended) entry.
IP_OFFENDERS=$(grep -rnE "x-forwarded-for['\"]?\s*\]\s*(as string\s*)?\)?\s*\??\.\s*split" src/ pages/ --include='*.ts' 2>/dev/null || true)
if [[ -n "$IP_OFFENDERS" ]]; then
  echo "ERROR: raw x-forwarded-for split detected. Use getClientIp() from @/lib/rateLimit instead."
  echo "$IP_OFFENDERS"
  exit 1
fi
echo "OK: client-IP extraction goes through getClientIp()."

echo
echo "=== Pentest H1: portal / impersonation JWT secrets must not be derived from JWT_SECRET ==="
# Match expressions like `JWT_SECRET + '-portal'` that concatenate the staff
# secret with a suffix to fake a per-purpose secret. Comments are excluded
# (lines starting with // or *).
SECRET_OFFENDERS=$(grep -rnE "JWT_SECRET\s*\+\s*['\"]" src/ pages/ --include='*.ts' 2>/dev/null \
  | grep -vE ':\s*//|:\s*\*' || true)
if [[ -n "$SECRET_OFFENDERS" ]]; then
  echo "ERROR: JWT_SECRET concatenation detected. Add a dedicated *_JWT_SECRET env var instead."
  echo "$SECRET_OFFENDERS"
  exit 1
fi
echo "OK: no JWT_SECRET derivations."
