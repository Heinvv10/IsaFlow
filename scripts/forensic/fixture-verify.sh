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

# --apply MUTATES the fixture (it reverts ahead migrations and rewrites function bodies). That is
# the regeneration flow and is fine on a fresh fixture, but silently rewriting one a suite is
# running against turns their failures into nonsense. Same "has this been used" signal as the dump.
case " $* " in *" --apply "*)
  USED=$(docker exec "isaflow-forensic-$PORT" psql -U postgres -d isaflow_schema_fixture -tAc "
    SELECT (SELECT count(*) FROM companies)
         + (SELECT count(*) FROM users WHERE id <> '00000000-0000-4000-8000-000000000001')")
  [ "$USED" = 0 ] || { echo "REFUSED: --apply would mutate isaflow-forensic-$PORT, which has run tests ($USED rows). Use a fresh fixture-up.sh." >&2; exit 2; }
esac
# `|| STATUS=$?` rather than a bare call: under `set -e` a MISMATCH exits the script here, which
# SKIPPED every assertion below — exactly when the fixture is known wrong and you most want to know
# WHICH invariant broke. A command on the left of `||` does not trip errexit, so the run continues
# and the exit code is carried to the end.
STATUS=0
bun "$HERE/schema-match.ts" --repo "$REPO" --commit "$SHA" \
  --db "$ISAFLOW_FORENSIC_FIXTURE_URL" --node-base "$REPO" \
  --reverts "$HERE/fixture/reverts" --floor "${ISAFLOW_FIXTURE_FLOOR:-600}" "$@" || STATUS=$?

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

# Reference ROWS the migrations INSERT, which `pg_dump -s` drops and nothing regenerates.
#
# reference-data.sql is maintained BY HAND, and this check is why that is survivable. It was
# missing all 13 business modules from 270_granular_permissions.sql — the ancestor fixture holds
# only the 10 forensic-control ones — so granting a permission on banking, reports, vat or payroll
# answered "400 Unknown moduleKey" (permissions.ts validates against this table). The same class
# of gap as the `audit` module, found the same way: by a test failing for a structural reason.
#
# permission_modules only, because it is the one whose absence the routes reject on. feature_flags
# and asset_categories are read, not validated against, so a missing row degrades rather than
# refuses — worth adding here if that ever changes.
echo "== reference rows the migrations INSERT (pg_dump -s drops these)"
EXPECTED=$(awk '/INSERT INTO permission_modules/{inblock=1} inblock{if(match($0,/\x27[a-z_]+\x27/)){print substr($0,RSTART+1,RLENGTH-2)}} /;[[:space:]]*$/{inblock=0}' \
  "$REPO"/scripts/migrations/sql/*.sql | sort -u)
LIVEKEYS=$(docker exec "isaflow-forensic-$PORT" psql -U postgres -d isaflow_schema_fixture -tAc \
  "SELECT module_key FROM permission_modules" | sed 's/^ *//' | grep -v '^$' | sort -u)
MISSINGKEYS=$(comm -23 <(echo "$EXPECTED") <(echo "$LIVEKEYS") | tr '\n' ' ')
if [ -n "${MISSINGKEYS// /}" ]; then
  echo "   MISSING permission_modules the migrations insert: $MISSINGKEYS"
  echo "   fix: add them to scripts/forensic/fixture/reference-data.sql, sourced from the migration"
  STATUS=1
else
  echo "   all $(echo "$EXPECTED" | wc -l) permission_modules keys the migrations insert are present — OK"
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
