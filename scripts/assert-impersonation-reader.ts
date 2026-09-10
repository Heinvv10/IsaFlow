/**
 * Deploy gate: fail unless public.control_session_impersonator() exists on DATABASE_URL.
 * The request path refuses every human review when it cannot see impersonation state, so
 * a database without the reader must stop the deploy rather than every approval.
 *
 *   DATABASE_URL=... bun scripts/assert-impersonation-reader.ts
 */
import pg from 'pg';
import { assertImpersonationReaderDeployed } from '../src/lib/auth/sessionImpersonation';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await assertImpersonationReaderDeployed(async (text) => (await pool.query<{ available: boolean }>(text)).rows);
    process.stdout.write('impersonation reader present\n');
  } finally { await pool.end(); }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
