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

# SECURITY DEFINER drift, against fixture/definers.txt. Same shape as the 838 check above and for
# the same reason: schema-match compares function BODIES, and a lost definer bit is not a body
# change it can see. CREATE OR REPLACE FUNCTION resets prosecdef to INVOKER unless the replacement
# restates SECURITY DEFINER — owner survives, the definer bit does not, and the two are independent
# catalog fields. A definer reader that silently becomes an invoker fails OPEN.
echo "== SECURITY DEFINER functions (schema-match cannot check these either)"
MANIFEST=$HERE/fixture/definers.txt
if [ ! -s "$MANIFEST" ]; then
  echo "   no manifest yet — run fixture-dump.sh to create fixture/definers.txt"
else
  LIVE=$(docker exec "isaflow-forensic-$PORT" psql -U postgres -d isaflow_schema_fixture -tAc "
    SELECT p.oid::regprocedure::text||'|'||r.rolname
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','auth','app') AND p.prosecdef
    ORDER BY 1" | sed 's/^ *//' | grep -v '^$')
  LOST=$(comm -23 <(sort "$MANIFEST") <(echo "$LIVE" | sort) | cut -d'|' -f1)
  if [ -n "$LOST" ]; then
    echo "   LOST SECURITY DEFINER (or changed owner) since the manifest:"
    echo "$LOST" | sed 's/^/     /'
    echo "   a CREATE OR REPLACE that did not restate SECURITY DEFINER is the usual cause"
    STATUS=1
  else
    echo "   all $(wc -l < "$MANIFEST") manifest functions still SECURITY DEFINER with the same owner — OK"
  fi
  # An owner that can neither bypass RLS nor is superuser makes a definer function useless at best
  # and misleading at worst; check the live set regardless of the manifest.
  WEAK=$(docker exec "isaflow-forensic-$PORT" psql -U postgres -d isaflow_schema_fixture -tAc "
    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY 1)
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','auth','app') AND p.prosecdef
      AND NOT r.rolbypassrls AND NOT r.rolsuper")
  if [ -n "$WEAK" ]; then
    echo "   SECURITY DEFINER owned by a role that neither bypasses RLS nor is superuser: $WEAK"
    STATUS=1
  fi
fi
exit $STATUS
