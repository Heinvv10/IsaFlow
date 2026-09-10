/**
 * Deploy gate: fail unless both impersonation reader functions exist on DATABASE_URL and
 * app_user may EXECUTE them. Run by deploy.sh right after migrations. scripts/** is
 * outside tsconfig and no CI step runs this, so tests/unit/scripts covers it.
 *
 *   DATABASE_URL=... bun scripts/assert-impersonation-reader.ts
 */
import pg from 'pg';
import { assertImpersonationReaderDeployed } from '../src/lib/auth/sessionImpersonation';

type Query = Parameters<typeof assertImpersonationReaderDeployed>[0];
export async function runImpersonationReaderGate(query: Query, out: (line: string) => void): Promise<void> {
  await assertImpersonationReaderDeployed(query);
  out('impersonation readers present and executable by app_user\n');
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await runImpersonationReaderGate(async (text) => (await pool.query(text)).rows as Awaited<ReturnType<Query>>,
      (line) => process.stdout.write(line));
  } finally { await pool.end(); }
}

if (process.argv[1]?.includes('assert-impersonation-reader')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
