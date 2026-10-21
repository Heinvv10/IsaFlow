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
 * Seconds each suite of 3 s or more took (suite-seconds.json, the median over
 * local gate runs, written by measure-suites.ts); every other suite counts
 * FALLBACK_SECONDS. Only the deal uses these: a stale or missing entry costs
 * wall time, never correctness. A hand-kept list of ten went stale within a
 * day (the audit-snapshots suites, ~1,100 s, all counted 3 s and landed on one
 * shard, which then ran 10-13 min while the lightest ran 3). Re-measure when a
 * new slow suite lands or one shard's `[integration] shard i/6 ... Ns` line in
 * the gate log runs well past the others.
 */
const SLOW = JSON.parse(readFileSync('scripts/ci/integration/suite-seconds.json', 'utf8')) as Record<string, number>;
const FALLBACK_SECONDS = 1;

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

for (const { shard, db, file } of assignShards(routes, shards, SLOW, FALLBACK_SECONDS)) {
  process.stdout.write(`${shard}\t${db}\t${file}\n`);
}
