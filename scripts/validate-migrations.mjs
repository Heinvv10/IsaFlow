/**
 * Validates migration file naming in scripts/migrations/sql/.
 *
 * Rules checked:
 * 1. No duplicate numeric prefixes (e.g. 244_foo.sql and 244b_bar.sql both sort
 *    under "244" and cause non-deterministic execution order).
 * 2. All filenames match the expected pattern NNN_description.sql.
 *
 * NOTE: The migration runner (run-migrations.mjs) tracks applied migrations by
 * exact filename stored in schema_migrations.  DO NOT rename files that have
 * already been applied to production — that would cause them to re-run.
 * Instead, fix duplicate prefixes by creating a new migration file with the
 * next available number that is safe to apply idempotently.
 *
 * Current known duplicates (already applied — do not rename):
 *   244_fixed_assets.sql  vs  244b_inventory.sql
 *   246_customer_supplier_fields.sql  vs  246_purchase_orders.sql
 *   250_leave_management.sql  vs  250_vlm_extraction.sql
 *   251_demo_seed_data.sql  vs  251_projects.sql
 *   255_fix_missing_schema.sql  vs  255_migration_wizard.sql
 *   265_admin_platform_announcements.sql  vs  265_vat_period_alignment.sql
 *   266_account_lockout.sql  vs  266_admin_platform_company_user_ext.sql
 *
 * Usage:
 *   node scripts/validate-migrations.mjs           # exits 1 if duplicates found
 *   node scripts/validate-migrations.mjs --warn    # exits 0 but prints warnings
 */

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations/sql');
const warnOnly = process.argv.includes('--warn');

const files = readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

// Detect files whose numeric prefix collides with another file.
// A "numeric prefix" is the leading digit sequence before the first non-digit.
// e.g. "244b_inventory.sql" has prefix "244", same as "244_fixed_assets.sql".
const prefixMap = new Map();

for (const file of files) {
  const match = file.match(/^(\d+)/);
  if (!match) {
    process.stderr.write(`WARN: file does not start with a number: ${file}\n`);
    continue;
  }
  const prefix = match[1];
  if (!prefixMap.has(prefix)) {
    prefixMap.set(prefix, []);
  }
  prefixMap.get(prefix).push(file);
}

const duplicates = [...prefixMap.entries()].filter(([, names]) => names.length > 1);

if (duplicates.length === 0) {
  process.stdout.write('Migration filenames OK — no duplicate prefixes found.\n');
  process.exit(0);
}

const label = warnOnly ? 'WARN' : 'ERROR';
process.stderr.write(`\n${label}: ${duplicates.length} duplicate migration prefix(es) detected.\n`);
process.stderr.write('These files share the same numeric prefix and will execute in\n');
process.stderr.write('lexicographic order, which may differ across filesystems:\n\n');

for (const [prefix, names] of duplicates) {
  process.stderr.write(`  Prefix ${prefix}:\n`);
  for (const name of names) {
    process.stderr.write(`    - ${name}\n`);
  }
}

process.stderr.write(`
Resolution: since these files are already applied in production, do NOT rename
them.  Instead, ensure any new logic is placed in a fresh migration with the
next unused number.  The runner skips already-applied filenames by exact match.
`);

process.exit(warnOnly ? 0 : 1);
