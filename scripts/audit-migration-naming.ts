#!/usr/bin/env bun
/**
 * CI gate (run-ci.sh step "migration-naming", Static gates): fails when a
 * migration's version prefix clashes with another migration, so the clash
 * shows on the PR instead of aborting a production deploy. Rule and the frozen
 * list of historic clashes: scripts/ci/migrationPrefixRule.ts.
 *
 * Usage (from the repo root): bun scripts/audit-migration-naming.ts   # exit 1 on a new clash
 */
import { readdirSync } from 'fs';
import { findPrefixClashes, HISTORIC_PREFIX_CLASHES } from './ci/migrationPrefixRule';
import { MIGRATIONS_DIR } from './lib/migrationFiles';

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const clashes = findPrefixClashes(files);

process.stdout.write(
  `Scanned ${files.length} migration files (${HISTORIC_PREFIX_CLASHES.size} historic clashes allowlisted).\n`,
);
if (clashes.length === 0) {
  process.stdout.write('No new migration prefix clashes.\n');
  process.exit(0);
}
for (const c of clashes) {
  process.stderr.write(`ERROR: ${c.name}: ${c.detail}\n`);
}
process.stderr.write(
  `${clashes.length} migration prefix clash(es). Rename the new file to the next unused prefix ` +
    '(production deploy would abort with DUPLICATE_PENDING_VERSION / PENDING_VERSION_TAKEN).\n',
);
process.exit(1);
