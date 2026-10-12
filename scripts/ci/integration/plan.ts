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
 * Seconds each of the slowest suites took in the gate, measured 2026-10-12 at
 * load ~110 (every other suite counts 3 s, about what one takes with its imports). Only the deal uses these: a stale
 * or missing entry costs wall time, never correctness. Re-measure from the
 * gate log's per-file times when one suite starts holding a shard back.
 */
const SLOW: Record<string, number> = {
  'tests/integration/d10-bank-reversal-interleave.int.test.ts': 477,
  'tests/integration/d10-mcp-void.int.test.ts': 172,
  'tests/integration/d8-r16-posting-wait.int.test.ts': 89,
  'tests/integration/w2-28-system-role-round10.int.test.ts': 57,
  'tests/integration/d11-held-row-routes.int.test.ts': 46,
  'tests/integration/d8-r9-lock-budget.int.test.ts': 38,
  'tests/integration/w2-28-brk593p3-new.int.test.ts': 37,
  'tests/integration/d12-completed-races.int.test.ts': 35,
  'tests/integration/brkr-c5-locks.int.test.ts': 33,
  'tests/integration/w2-28-system-role-round12.int.test.ts': 31,
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
