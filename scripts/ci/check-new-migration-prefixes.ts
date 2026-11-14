/**
 * check-new-migration-prefixes — fails when a migration file added relative to origin/master shares its numeric
 * prefix with any other file in scripts/migrations/sql/. Historic duplicates are not touched (see
 * ./newMigrationPrefixRule.ts). Closes #1380.
 *
 * Run: bun scripts/ci/check-new-migration-prefixes.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { findNewPrefixCollisions } from './newMigrationPrefixRule';

const BASE = 'origin/master';
const DIR = 'scripts/migrations/sql';

const errors: string[] = [];
try {
  const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', `${BASE}...HEAD`, '--', `${DIR}/`], { encoding: 'utf8' });
  const added = diff.split('\n').filter((p) => p.endsWith('.sql')).map((p) => path.basename(p));
  const all = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
  errors.push(...findNewPrefixCollisions(added, all));
  process.stdout.write(`${added.length} migration(s) added since ${BASE}; `);
} catch (err) {
  errors.push(`could not run the check (is ${BASE} fetched?): ${(err as Error).message}`);
}

if (errors.length) {
  process.stderr.write(`ERROR: new migration prefix collides:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('none shares a numeric prefix with another file\n');
