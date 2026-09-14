#!/usr/bin/env bash
# Prove the running fixture's schema matches a commit's migrations. Read-only by default.
#
#   usage: bash scripts/forensic/fixture-verify.sh [port] [commit-ish]     (default HEAD)
#          bash scripts/forensic/fixture-verify.sh 33150 HEAD --apply      (regeneration only)
#
# Exit 0 = MATCH. This is the check that stops fixture/schema.sql silently rotting as migrations
# land: a snapshot whose fidelity nobody can vouch for is worse than no fixture, because its
# failures are unattributable. Run it before trusting an integration result.
#
# Limitation inherited from schema-match.ts: it compares tables, ADD COLUMNs, triggers and function
# bodies for objects last touched at or after --floor, plus revert "detect" queries. Privilege-only
# and RLS-policy-only changes are NOT compared except through those detect queries.
set -euo pipefail
PORT=${1:-33150}
COMMIT=${2:-HEAD}
shift $(( $# > 2 ? 2 : $# )) || true
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
SHA=$(git -C "$REPO" rev-parse --verify "$COMMIT^{commit}")
eval "$(bash "$HERE/fixture-env.sh" "$PORT")"
exec bun "$HERE/schema-match.ts" --repo "$REPO" --commit "$SHA" \
  --db "$ISAFLOW_FORENSIC_FIXTURE_URL" --node-base "$REPO" \
  --reverts "$HERE/fixture/reverts" --floor "${ISAFLOW_FIXTURE_FLOOR:-600}" "$@"
