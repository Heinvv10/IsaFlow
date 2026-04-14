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
