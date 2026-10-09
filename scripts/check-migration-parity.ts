/**
 * Pre-deploy migration-parity gate. Run by scripts/deploy.sh BEFORE the CI gate.
 *
 *   bun scripts/check-migration-parity.ts [--apply-dev] [--verbose]
 *
 * Dev  = DATABASE_URL (must name isaflow_dev).
 * Prod = PARITY_PROD_DATABASE_URL (must name isaflow); opened READ ONLY, never written.
 * --apply-dev applies PENDING migrations missing on dev, in order, one transaction
 * each, under the runner's advisory lock, stopping at the first failure.
 * Nothing else is auto-fixed. Exit 0 only when no FAIL remains. URLs are never printed.
 * Logic: scripts/lib/migrationParity.ts (rules) and scripts/lib/migrationParityRun.ts (IO).
 */
import { loadMigrationFiles } from './lib/migrationFiles';
import { runParityGate } from './lib/migrationParityRun';

async function main(): Promise<number> {
  const devUrl = process.env.DATABASE_URL;
  const prodUrl = process.env.PARITY_PROD_DATABASE_URL;
  if (!devUrl) throw new Error('DATABASE_URL (dev) not set');
  if (!prodUrl) throw new Error('PARITY_PROD_DATABASE_URL (prod, read-only) not set');
  return runParityGate({
    devUrl,
    prodUrl,
    files: loadMigrationFiles(),
    applyDev: process.argv.includes('--apply-dev'),
    verbose: process.argv.includes('--verbose'),
  });
}

// Unconditional: no import.meta.main guard, so a runtime that lacks it cannot skip the gate and exit 0.
main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`migration parity gate error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
);
