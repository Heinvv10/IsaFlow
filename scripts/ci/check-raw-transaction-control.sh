#!/usr/bin/env bash
#
# Raw BEGIN / COMMIT / ROLLBACK through the `sql` tagged template is forbidden.
#
# WHY. `sql` routes onto the AsyncLocalStorage request client when one is in
# flight (`src/lib/neon.ts`, `LazyQuery.run`), and `withAuth` opens a
# transaction for EVERY request. So `await sql\`COMMIT\`` does not commit the
# block a service wrapped — it commits the WHOLE REQUEST. Every earlier write
# becomes durable and any enclosing savepoint ceases to exist.
#
# WHAT THAT COST. `calculatePayrollRun` did this. On the MCP path it destroyed
# the registry's per-tool savepoint, and the `RELEASE SAVEPOINT` that followed
# then errored into a GENERIC_FAILURE over payroll run lines that had ALREADY
# committed: the agent is told "the operation failed, please try again",
# retries, and recosts a run it was never told it had written. The same early
# commit was live on the REST/UI path, where it silently made every prior write
# in the request durable. Five services carried the pattern; all five are fixed
# (2026-09-05).
#
# THE REMEDY is `withTransaction` from `@/lib/neon`, which nests a SAVEPOINT
# when a request transaction is in flight and opens a real transaction only when
# there is none. It is correct under both callers, which raw BEGIN never is.
#
# BLOCKING, not baselined. The sweep is complete — there are zero offenders — so
# there is nothing to grandfather and a baseline would only be a place for the
# next one to hide.
#
# Scope note: this checks the `sql` TEMPLATE only. `client.query('BEGIN')` on a
# pool client you own is how `withTransaction` itself opens a real transaction,
# and is correct; it is not matched here.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Match `sql`BEGIN``, `sql`COMMIT``, `sql`ROLLBACK`` and the tx-alias forms a
# copy-paste would produce. Comments and this script itself are excluded.
HITS=$(grep -rnE 'await[[:space:]]+sql`[[:space:]]*(BEGIN|COMMIT|ROLLBACK)' \
         src/ pages/ --include='*.ts' --include='*.tsx' 2>/dev/null \
       | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)' || true)

if [ -n "$HITS" ]; then
  echo "FAIL: raw transaction control through the \`sql\` template."
  echo
  echo "$HITS"
  echo
  echo "\`sql\` routes onto the request's ALS client, so a raw COMMIT commits the"
  echo "WHOLE request and destroys any enclosing savepoint — including the MCP"
  echo "registry's per-tool savepoint."
  echo
  echo "Use withTransaction from '@/lib/neon' instead:"
  echo
  echo "    await withTransaction(async (tx) => {"
  echo "      await tx\`UPDATE ...\`;"
  echo "    });"
  echo
  echo "It nests a SAVEPOINT when a request transaction is in flight and opens a"
  echo "real one when there is none. See scripts/ci/check-raw-transaction-control.sh."
  exit 1
fi

echo "OK: no raw BEGIN/COMMIT/ROLLBACK through the sql template."
