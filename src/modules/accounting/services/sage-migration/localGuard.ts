/**
 * The migration runner writes only to a local, throwaway database. This is the check, applied to every database URL the app's
 * pools would read from the environment (DATABASE_URL, and SERVICE_DATABASE_URL / PLATFORM_ADMIN_DATABASE_URL /
 * MIGRATION_ADMIN_DATABASE_URL when set: `serviceDatabaseUrl()` prefers the service one). A URL passes only when, as `pg` itself
 * parses it (pg-connection-string, not `new URL`: a `?host=` in the query overrides the authority):
 *   - it carries no query parameter but `sslmode`;
 *   - the host is 127.0.0.1 or localhost (no unix socket, no remote name);
 *   - it names its port (without one pg falls back to PGPORT) and the port is not the IsaFlow Supabase stack's 7770-7776,
 *     which publishes the dev and production servers on localhost too;
 *   - the database is isaflow_schema_fixture, isaflow_test or isaflow_sagemig_<name>.
 * Same logic as tests/integration/fixtureDbGuard.ts, which cannot be imported from src.
 */
import { parse } from 'pg-connection-string';

const SUPABASE_STACK_PORTS = new Set(['7770', '7771', '7772', '7773', '7774', '7775', '7776']);
const ALLOWED_DB = /^(isaflow_schema_fixture|isaflow_test|isaflow_sagemig_[a-z0-9_]+)$/;
const URL_ENV_NAMES = ['DATABASE_URL', 'SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL'] as const;

/** Why `raw` is not a local throwaway database, or null when it is. */
export function localDbProblem(raw: string | undefined): string | null {
  if (!raw) return 'is not set';
  if (!URL.canParse(raw)) return 'is not a URL';
  const extra = [...new URL(raw).searchParams.keys()].filter((k) => k !== 'sslmode');
  if (extra.length > 0) return `may carry no query parameter but sslmode (found ${extra.join(', ')})`;
  const pg = parse(raw);
  if (!pg.host || !['localhost', '127.0.0.1'].includes(pg.host)) return `must connect to localhost (pg reads host ${pg.host ?? 'none'})`;
  if (!pg.port || !/^\d+$/.test(String(pg.port))) return 'must name its port explicitly (without one pg falls back to PGPORT)';
  if (SUPABASE_STACK_PORTS.has(String(pg.port))) return `port ${pg.port} is the IsaFlow Supabase server (dev and production), not a throwaway database`;
  if (!pg.database || !ALLOWED_DB.test(pg.database)) {
    return `must name isaflow_schema_fixture, isaflow_test or isaflow_sagemig_<name> (pg opens ${pg.database ?? 'none'})`;
  }
  return null;
}

/** Throws unless DATABASE_URL (required) and every other database URL set in `env` is a local throwaway database. */
export function assertLocalDatabase(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of URL_ENV_NAMES) {
    const value = env[name];
    if (name !== 'DATABASE_URL' && (value === undefined || value === '')) continue;
    const problem = localDbProblem(value);
    if (problem) throw new Error(`Refusing to run the Sage migration: ${name} ${problem}. It runs against a local throwaway database only.`);
  }
}
