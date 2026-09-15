#!/usr/bin/env bash
# Regenerate fixture/schema.sql from a running, VERIFIED fixture — the only supported way to
# produce it, so its provenance header cannot drift from what it describes.
#
#   usage: bash scripts/forensic/fixture-dump.sh [port] [commit-ish]     (default 33150, HEAD)
#
# Refuses unless schema-match.ts reports MATCH for that commit first: a snapshot nobody can vouch
# for is worse than no fixture, because its failures are unattributable.
set -euo pipefail
PORT=${1:-33150}
COMMIT=${2:-HEAD}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
SHA=$(git -C "$REPO" rev-parse --verify "$COMMIT^{commit}")
NAME=isaflow-forensic-$PORT
OUT=$HERE/fixture/schema.sql

# Dump only from a fixture that has never run a test. A used fixture accumulates objects the
# suites create — this guard was added after a `synthetic_comparison_source_suppress()` trigger
# function, carrying two hardcoded UUIDs in its body, made it into a dump taken from a fixture
# that had run the controls suite.
#
# THREE INDEPENDENT SIGNALS, because any one of them can be missed by a suite that uses the
# fixture in a way this script did not anticipate:
#   * companies — every tenant-scoped suite provisions one (provisionForensicFixture always does)
#   * users beyond the single reserved gateway principal that reference-data.sql seeds
#   * any object named synthetic* — the convention the suites use for the objects they create,
#     and the one that actually leaked
# A suite that somehow trips none of these would still be caught by the content checks at the end
# (no COPY, no INSERT, no identifiers), but prefer adding a fourth signal here over relying on that.
USED=$(docker exec "$NAME" psql -U postgres -d isaflow_schema_fixture -tAc "
  SELECT (SELECT count(*) FROM companies)
       + (SELECT count(*) FROM users WHERE id <> '00000000-0000-4000-8000-000000000001')
       + (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname LIKE 'synthetic%')
       + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname LIKE 'synthetic%')")
[ "$USED" = 0 ] || { echo "REFUSED: $NAME shows $USED sign(s) of having run tests (companies, extra users, or synthetic* objects). Dump from a fresh fixture-up.sh instead." >&2; exit 2; }

echo "[fixture-dump] verifying $NAME against ${SHA:0:9} before dumping"
bash "$HERE/fixture-verify.sh" "$PORT" "$SHA" > /tmp/fixture-dump-verify.$$ 2>&1 || {
  echo "REFUSED: schema-match did not pass — not dumping. Output:" >&2
  cat /tmp/fixture-dump-verify.$$ >&2; rm -f /tmp/fixture-dump-verify.$$; exit 2; }
grep -q '^MATCH:' /tmp/fixture-dump-verify.$$ || {
  echo "REFUSED: schema-match did not report MATCH — not dumping." >&2
  cat /tmp/fixture-dump-verify.$$ >&2; rm -f /tmp/fixture-dump-verify.$$; exit 2; }
rm -f /tmp/fixture-dump-verify.$$

LAST_MIGRATION=$(git -C "$REPO" ls-tree --name-only "$SHA" scripts/migrations/sql/ | sed 's|.*/||' | sort -V | tail -1)

# Build into a temp file and only move it into place once every guardrail has passed. Writing the
# real artefact first and validating after leaves a REFUSED dump sitting on disk looking like the
# committed one, which is how a rejected dump gets committed by the next person to run `git add`.
TMP=$(mktemp "${TMPDIR:-/tmp}/isaflow-fixture-dump.XXXXXX")
trap 'rm -f "$TMP"' EXIT
{
  cat <<EOF
--
-- IsaFlow integration-test fixture schema. GENERATED — do not hand-edit.
--
-- Regenerate with:  bash scripts/forensic/fixture-dump.sh [port] [commit]
-- Restore with:     bash scripts/forensic/fixture-up.sh
-- Full procedure and limitations: scripts/forensic/fixture/README.md
--
-- PROVENANCE. This descends from the live application schema, NOT from replaying the migration
-- set. A from-scratch apply of the migrations does not reproduce this database (see the README:
-- 116 of 411 migrations fail on an empty database, and the live schema contains at least six
-- things no migration produces). The chain is: the forensic fixture container built from a
-- production-descended dump, plus the migrations it lacked applied forward, minus migrations
-- carried from branches this one does not have, reverted via fixture/reverts/.
--
-- VERIFIED. schema-match.ts reported MATCH for commit $SHA
--           (last migration at that commit: $LAST_MIGRATION)
--           at $(date -u +%Y-%m-%dT%H:%M:%SZ), which is what fixture-dump.sh requires before writing this file.
--           MATCH compares tables, ADD COLUMNs, triggers and function BODIES at or above the
--           floor, plus the revert detect queries. It does NOT compare grants, RLS policies, or
--           function SET clauses (proconfig) — see the README.
--
-- CONTAINS NO DATA. pg_dump -s only. Reference rows the migrations INSERT live separately in
-- fixture/reference-data.sql. No passwords, no connection strings, no tenant or person
-- identifiers: fixture/roles.sql is hand-written precisely because pg_dumpall emits role
-- password hashes.
--
EOF
  docker exec "$NAME" pg_dump -U postgres -s isaflow_schema_fixture | grep -v '^\\restrict \|^\\unrestrict '
} > "$TMP"

echo "[fixture-dump] built $(wc -l < "$TMP") lines; checking guardrails before writing $OUT"

# STATEMENT-SHAPED leaks: data and credentials that arrive as their own statements.
for pattern in '^COPY ' '^INSERT INTO' 'SCRAM-SHA-256' 'ALTER ROLE' 'postgresql\?://'; do
  n=$(grep -cE "$pattern" "$TMP" || true)
  [ "$n" = 0 ] || { echo "REFUSED: dump contains $n line(s) matching /$pattern/" >&2; exit 2; }
done

# CONTENT-SHAPED leaks: identifiers ANYWHERE, including inside function bodies — which is where the
# real leak was. `synthetic_comparison_source_suppress()` carried two tenant UUIDs in its plpgsql
# body; every statement-shaped check above passes it, because a trigger function is schema, not
# data. The "has this fixture been used?" signals are proxies and can all be wrong (a suite that
# tears down cleanly leaves no companies; a test object named something other than synthetic* is
# invisible). This check is not a proxy: it asks whether the artefact contains a thing that must
# never be in it, wherever that thing lives.
#
# schema.sql ONLY. reference-data.sql legitimately carries the reserved gateway principal's UUID
# and its @-address, which is why that row is hand-added and reviewed rather than dumped.
#
# The live schema has zero of either (verified across all 36,538 lines), so this is a hard refusal
# rather than a threshold. If a migration ever adds a legitimate UUID DEFAULT or CHECK, this fails
# closed and wants an explicit allowlist here — that is the correct direction to fail.
UUIDS=$(grep -oEc "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" "$TMP" || true)
[ "${UUIDS:-0}" = 0 ] || { echo "REFUSED: dump contains $UUIDS UUID-shaped literal(s) — a tenant or person identifier may have leaked, possibly inside a function body:" >&2
  grep -nEo ".{0,60}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.{0,20}" "$TMP" | head -5 >&2; exit 2; }
MAILS=$(grep -cE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" "$TMP" || true)
[ "${MAILS:-0}" = 0 ] || { echo "REFUSED: dump contains $MAILS email-shaped literal(s):" >&2
  grep -nEo ".{0,40}[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}.{0,20}" "$TMP" | head -5 >&2; exit 2; }

mv "$TMP" "$OUT"
echo "[fixture-dump] wrote $OUT"
echo "[fixture-dump] guardrails pass: no data rows, no role passwords, no connection strings,"
echo "[fixture-dump]                  no UUID- or email-shaped literals anywhere (function bodies included)"

# The SECURITY DEFINER manifest that fixture-verify.sh checks the live fixture against.
#
# `pg_dump` records prosecdef in the CREATE FUNCTION text, so schema.sql already carries it — but
# nothing COMPARES it, and a definer bit is lost silently: CREATE OR REPLACE FUNCTION resets
# prosecdef to the default (INVOKER) unless the replacement restates SECURITY DEFINER, exactly as
# it resets proconfig. Owner survives that; the definer bit does not. A reader that loses its
# definer bit or its BYPASSRLS owner fails OPEN, which is the failure mode this programme spent
# six review rounds closing, so it gets a manifest rather than a note.
#
# Written from the same fixture being dumped, so verify compares the NEXT build against this one —
# which is what catches a migration applied forward during regeneration quietly dropping a bit.
docker exec "$NAME" psql -U postgres -d isaflow_schema_fixture -tAc "
  SELECT p.oid::regprocedure::text||'|'||r.rolname
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','auth','app') AND p.prosecdef
  ORDER BY 1" | sed 's/^ *//' | grep -v '^$' > "$HERE/fixture/definers.txt"
echo "[fixture-dump] wrote fixture/definers.txt ($(wc -l < "$HERE/fixture/definers.txt") SECURITY DEFINER functions)"
