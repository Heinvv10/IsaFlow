/**
 * plan — prints the integration gate's work list, one suite per line:
 *   <shard>\t<database>\t<file>
 * Every tests/integration/**\/*.int.test.ts, routed by ./suiteRoute.ts and
 * dealt to <shards> shards longest-first (assignShards), so one shard does not
 * collect the slow suites and finish minutes after the rest.
 * Exits 1, naming the files, when a suite's guards cannot pass on either database.
 *
 * Run: bun scripts/ci/integration/plan.ts <shards>
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assignShards, routeSuite } from './suiteRoute';

/**
 * Seconds each suite of 20 s or more took in the gate, measured 2026-10-22 at
 * load ~25-60 (vitest's per-file time plus ~0.5 s of imports; every other suite
 * counts 3 s, and the median one takes ~1 s). Only the deal uses these: a stale
 * or missing entry costs wall time, never correctness. The 2026-10-12 table
 * missed the seven audit-snapshots suites (~1,300 s together), which counted 3 s
 * each and left one shard ~980 s against ~350 s for the lightest. Re-measure from
 * the per-file times in .ci-integration-logs/ when one shard finishes well after
 * the rest (report.sh prints each shard's seconds).
 */
const SLOW: Record<string, number> = {
  'tests/integration/audit-snapshots-auto.int.test.ts': 396,
  'tests/integration/audit-snapshots-service.int.test.ts': 333,
  'tests/integration/d10-bank-reversal-interleave.int.test.ts': 234,
  'tests/integration/audit-snapshots-compare.int.test.ts': 154,
  'tests/integration/audit-snapshots-versions.int.test.ts': 150,
  'tests/integration/audit-snapshots-routes.int.test.ts': 110,
  'tests/integration/audit-snapshots-pack.int.test.ts': 89,
  'tests/integration/d8-r16-posting-wait.int.test.ts': 86,
  'tests/integration/d10-mcp-void.int.test.ts': 62,
  'tests/integration/w2-28-system-role-round10.int.test.ts': 59,
  'tests/integration/audit-snapshots-followups.int.test.ts': 54,
  'tests/integration/d11-held-row-routes.int.test.ts': 46,
  'tests/integration/d8-r9-lock-budget.int.test.ts': 37,
  'tests/integration/w2-28-brk593p3-new.int.test.ts': 36,
  'tests/integration/d12-completed-races.int.test.ts': 34,
  'tests/integration/w2-28-system-role-round12.int.test.ts': 29,
  'tests/integration/brkr-c5-locks.int.test.ts': 29,
  'tests/integration/d11-r4-automatch.int.test.ts': 26,
  'tests/integration/ap01-netcash-durable-answer.int.test.ts': 26,
  'tests/integration/r058-capture-post-double-post.int.test.ts': 23,
  'tests/integration/r193-replay-waits-for-cancel.int.test.ts': 22,
  'tests/integration/docnum-lock-timeout.int.test.ts': 22,
  'tests/integration/ap01-netcash-settle-bounds.int.test.ts': 22,
  'tests/integration/ap01-netcash-late-settler.int.test.ts': 22,
  'tests/integration/k071-rule-sweep-undo-contention.int.test.ts': 21,
};

const shards = Number(process.argv[2]);
if (!Number.isInteger(shards) || shards < 1) {
  process.stderr.write('usage: bun scripts/ci/integration/plan.ts <shards>\n');
  process.exit(2);
}

const read = (path: string): string | undefined =>
  existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;

const suites = readdirSync('tests/integration', { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.int.test.ts'))
  .map((f) => join('tests/integration', f))
  .sort();

const routes = suites.map((file) => routeSuite(file, read));
const conflicts = routes.filter((r) => r.db === 'conflict');
if (conflicts.length > 0) {
  process.stderr.write('[integration] these suites call assertNotProductionDb (isaflow_test only) AND reach a '
    + "guard allowing only isaflow_schema_fixture, so they cannot pass on either database:\n");
  for (const c of conflicts) process.stderr.write(`  ${c.file}\n`);
  process.exit(1);
}

for (const { shard, db, file } of assignShards(routes, shards, SLOW, 3)) {
  process.stdout.write(`${shard}\t${db}\t${file}\n`);
}
