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
# that had run the controls suite. Tests always create companies, so an empty `companies` is a
# reliable "never used" signal, and it is cheaper than trying to tell test objects from real ones.
USED=$(docker exec "$NAME" psql -U postgres -d isaflow_schema_fixture -tAc "SELECT count(*) FROM companies")
[ "$USED" = 0 ] || { echo "REFUSED: $NAME has $USED companies — it has run tests. Dump from a fresh fixture-up.sh instead." >&2; exit 2; }

echo "[fixture-dump] verifying $NAME against ${SHA:0:9} before dumping"
bash "$HERE/fixture-verify.sh" "$PORT" "$SHA" > /tmp/fixture-dump-verify.$$ 2>&1 || {
  echo "REFUSED: schema-match did not pass — not dumping. Output:" >&2
  cat /tmp/fixture-dump-verify.$$ >&2; rm -f /tmp/fixture-dump-verify.$$; exit 2; }
grep -q '^MATCH:' /tmp/fixture-dump-verify.$$ || {
  echo "REFUSED: schema-match did not report MATCH — not dumping." >&2
  cat /tmp/fixture-dump-verify.$$ >&2; rm -f /tmp/fixture-dump-verify.$$; exit 2; }
rm -f /tmp/fixture-dump-verify.$$

LAST_MIGRATION=$(git -C "$REPO" ls-tree --name-only "$SHA" scripts/migrations/sql/ | sed 's|.*/||' | sort -V | tail -1)
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
} > "$OUT"

echo "[fixture-dump] wrote $OUT ($(wc -l < "$OUT") lines)"
for pattern in '^COPY ' '^INSERT INTO' 'SCRAM-SHA-256' 'ALTER ROLE' 'postgresql\?://'; do
  n=$(grep -cE "$pattern" "$OUT" || true)
  [ "$n" = 0 ] || { echo "REFUSED: $OUT contains $n line(s) matching /$pattern/" >&2; exit 2; }
done
echo "[fixture-dump] guardrails pass: no data rows, no role passwords, no connection strings"
