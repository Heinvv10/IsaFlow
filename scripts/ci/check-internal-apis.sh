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

echo
echo "=== posted_through: no fabricated 1970-01-01 sentinel, per docs/mcp/CONTRACTS.md ==="
# posted_through is string | null; null, not a sentinel timestamp, is correct
# when a report consumed no ledger row (docs/mcp/CONTRACTS.md, FINDINGS.md
# B68). The spread mechanism is copy-paste of the LITERAL string, not import
# of NO_LEDGER_READ — none of the nine known sites import it — so this gates
# the literal, not the constant name; deprecating the constant reaches
# nothing a fresh copy-paste would use. postedThroughService.ts is excluded
# by filename: it is the deprecated constant's own definition, the one place
# the literal is meant to exist, not a fabricating call site.
#
# Report-only against a baseline, same mechanism as migration-rls.baseline —
# but these entries are KNOWN DEFECTS on a scheduled sweep, not blind spots
# the gate cannot see; they should shrink to zero, unlike that baseline. No
# self-cleaning check here (unlike migration-rls.baseline): fixing a site is
# enough to pass on its own, deleting the now-unneeded baseline line is a
# separate, later tidy-up — the sweep PR's job, not this gate's.
SENTINEL_BASELINE="scripts/ci/posted-through-sentinel.baseline"
SENTINEL_HITS=$(grep -rl "1970-01-01T00:00:00" src/lib/mcp/tools/ src/modules/ --include='*.ts' 2>/dev/null \
  | grep -v 'src/modules/accounting/services/reports/postedThroughService\.ts' || true)

SENTINEL_NEW=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ -f "$SENTINEL_BASELINE" ]] && grep -qxF "$f" "$SENTINEL_BASELINE"; then
    continue
  fi
  SENTINEL_NEW="${SENTINEL_NEW}${f}"$'\n'
done <<< "$SENTINEL_HITS"

if [[ -n "$SENTINEL_NEW" ]]; then
  echo "ERROR: 1970-01-01T00:00:00 sentinel found outside the baseline:"
  printf '%s' "$SENTINEL_NEW"
  echo "Fix: return the real string | null and let the caller decide, per"
  echo "docs/mcp/CONTRACTS.md's posted_through section. Do NOT add this file"
  echo "to $SENTINEL_BASELINE instead — it is for the nine known, scheduled"
  echo "sites, not new ones."
  exit 1
fi
echo "OK: no posted_through sentinel outside the known, scheduled sites."
