/**
 * The migrations the runner would apply on top of a database, in its order:
 * scripts/apply-migrations.ts planApply over the repo's files, given the names
 * the database's schema_migrations already tracks (one per line, in the file
 * named by the first argument). Prints one file name per line. phase-a.sh
 * uses it to list what is pending on production's schema before applying.
 *
 * Run: bun scripts/ci/prod-baseline/pending.ts <applied-names-file>
 */
import { readFileSync } from 'node:fs';
import { planApply } from '../../apply-migrations';
import { loadMigrationFiles } from '../../lib/migrationFiles';

/** Pending file names, given the tracked names; a tracked name's checksum does not decide whether it is pending. */
export function pendingNames(appliedText: string): string[] {
  const applied = appliedText.split('\n').map((s) => s.trim()).filter(Boolean)
    .map((name) => ({ name, version: '', checksum: null }));
  return planApply(loadMigrationFiles(), applied).toApply.map((f) => f.name);
}

if ((import.meta as { main?: boolean }).main) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: bun scripts/ci/prod-baseline/pending.ts <applied-names-file>\n');
    process.exit(2);
  }
  for (const name of pendingNames(readFileSync(file, 'utf8'))) process.stdout.write(`${name}\n`);
}
