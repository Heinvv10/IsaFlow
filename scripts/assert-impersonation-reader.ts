/**
 * Deploy gate: fail unless both impersonation reader functions exist on DATABASE_URL and
 * the roles that call them may EXECUTE them. Run by deploy.sh right after migrations, with
 * the application's own DATABASE_URL, and deploy.sh also requires the success line. It runs
 * unconditionally when loaded, so a renamed or wrapped invocation still checks. scripts/**
 * is outside tsconfig and no CI step runs this; tests/unit/scripts and the integration
 * suite cover the logic, which lives in src/lib/auth/sessionImpersonation.ts.
 *
 *   DATABASE_URL=... bun scripts/assert-impersonation-reader.ts
 */
import pg from 'pg';
import { runImpersonationReaderGate } from '../src/lib/auth/sessionImpersonation';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await runImpersonationReaderGate(async (text) => (await pool.query(text)).rows,
      (line) => process.stdout.write(line));
  } finally { await pool.end(); }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
