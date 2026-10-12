/**
 * plan — prints the integration gate's work list, one suite per line:
 *   <shard>\t<database>\t<file>
 * Every tests/integration/**\/*.int.test.ts, routed by ./suiteRoute.ts and
 * dealt round-robin (in path order) to <shards> shards per database.
 * Exits 1, naming the files, when a suite's guards cannot pass on either database.
 *
 * Run: bun scripts/ci/integration/plan.ts <shards>
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { routeSuite } from './suiteRoute';

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

const next = new Map<string, number>();
for (const { file, db } of routes) {
  const i = next.get(db) ?? 0;
  next.set(db, i + 1);
  process.stdout.write(`${(i % shards) + 1}\t${db}\t${file}\n`);
}
