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
bun "$HERE/schema-match.ts" --repo "$REPO" --commit "$SHA" \
  --db "$ISAFLOW_FORENSIC_FIXTURE_URL" --node-base "$REPO" \
  --reverts "$HERE/fixture/reverts" --floor "${ISAFLOW_FIXTURE_FLOOR:-600}" "$@"
STATUS=$?

# schema-match compares function BODIES, never proconfig, so it reports MATCH on a schema whose
# functions have silently lost their SET clauses. That is not hypothetical: CREATE OR REPLACE
# FUNCTION resets proconfig, and in this schema it has eaten the same setting three times — in the
# revert step that built the first cut of this snapshot, in the legacy fixture where the Sage
# branch re-created the function after the bound was set, and originally, which is why
# 838_control_authority_lock_timeout.sql exists at all and does nothing but re-assert it.
#
# So assert 838's own invariant directly. It is the one settings-only migration today; a second
# one needs its check added here, because nothing else in the pipeline can see it.
echo "== function SET clauses (schema-match cannot check these)"
UNBOUND=$(docker exec "isaflow-forensic-$PORT" psql -U postgres -d isaflow_schema_fixture -tAc "
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY 1) FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace
    AND (p.prosrc ~ 'control-authority' OR pg_get_function_sqlbody(p.oid) ~ 'control-authority')
    AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}')) c WHERE c = 'lock_timeout=5s')")
if [ -n "$UNBOUND" ]; then
  echo "   MISSING lock_timeout=5s (migration 838): $UNBOUND"
  echo "   fix: re-apply scripts/migrations/sql/838_control_authority_lock_timeout.sql, then re-dump"
  STATUS=1
else
  echo "   every control-authority lock holder carries lock_timeout=5s (838) — OK"
fi
exit $STATUS
