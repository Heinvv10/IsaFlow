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
# BL-13: every gl_journal_lines query must scope by company_id. Detection
# logic lives in glJournalLinesScopeRule.ts (unit-tested in
# tests/unit/ci/glJournalLinesScopeRule.test.ts) rather than here, because a
# line-proximity `awk` check here could be — and was — satisfied by a
# `company_id` mention anywhere within 20 lines, including inside an
# unrelated comment. See docs/mcp/CONTRACTS.md and FINDINGS.md B64.
bun scripts/ci/check-gl-journal-lines-scope.ts || exit 1

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
# secret with a suffix to fake a per-purpose secret. A line whose own text
# (after leading whitespace) starts with // or * is a genuine comment line
# and is excluded.
#
# The previous exclusion, `grep -vE ':\s*//|:\s*\*'`, matched that substring
# ANYWHERE in the "file:line:content" string — not anchored to the start of
# the line's own content. A real violation sharing a line with a URL
# (":\/\/" inside a string literal, e.g. `JWT_SECRET + 'https://...-portal'`)
# contains ":\s*//" too, so the "comment" exclusion silently swallowed a real
# violation. Re-reading the exact source line and testing ITS OWN leading
# characters, rather than pattern-matching the composed grep output, closes
# that. See FINDINGS.md B64.
SECRET_OFFENDERS=""
while IFS=: read -r file lineno _rest; do
  [[ -z "$file" ]] && continue
  content=$(sed -n "${lineno}p" "$file")
  trimmed="${content#"${content%%[![:space:]]*}"}"
  case "$trimmed" in
    //*|'*'*) continue ;;
  esac
  SECRET_OFFENDERS="${SECRET_OFFENDERS}${file}:${lineno}:${content}"$'\n'
done < <(grep -rnE "JWT_SECRET\s*\+\s*['\"]" src/ pages/ --include='*.ts' 2>/dev/null || true)

if [[ -n "$SECRET_OFFENDERS" ]]; then
  echo "ERROR: JWT_SECRET concatenation detected. Add a dedicated *_JWT_SECRET env var instead."
  printf '%s' "$SECRET_OFFENDERS"
  exit 1
fi
echo "OK: no JWT_SECRET derivations."
