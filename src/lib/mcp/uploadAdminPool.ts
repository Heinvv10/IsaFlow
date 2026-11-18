/**
 * The MCP upload path's writes that no app role may make (S-07b: app_user and app_service hold no grant for them):
 * staging an upload's bytes (PUT /api/mcp/uploads/<token>) and the expiry sweep (clear expired bytes, delete rows 7
 * days past expiry). They run on the migration_admin login (BYPASSRLS, not the table owner), which 999q grants
 * SELECT, DELETE and UPDATE (staged_bytes, status) on mcp_upload_intents and nothing more there. Every statement on
 * this pool is fixed and parameterised; the stage names its row by id AND company_id, the sweep touches only rows
 * past their expiry.
 *
 * A pool of its own (as signInStampPool / routeAdminPool), small (3; UPLOAD_ADMIN_POOL_MAX), with a short connect
 * timeout: a busy pool fails a PUT fast (UploadStageLockTimeoutError, 503 + Retry-After) and makes the sweep skip a
 * turn, instead of queueing behind other admin writes. A stage also waits at most 2 s for a row a finalize holds.
 */
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool in this process. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import { log } from '@/lib/logger';
import { poolSizeFromEnv } from '@/lib/limits/poolLimits';

let _pool: pg.Pool | null = null;

export function uploadAdminPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required: MCP upload staging and its sweep (999q, S-07b)');
  _pool = new pg.Pool({
    connectionString: url,
    max: poolSizeFromEnv('UPLOAD_ADMIN_POOL_MAX', 3),
    connectionTimeoutMillis: 2_000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  // pg-pool re-emits a pooled or removed client's 'error' on the pool; unlistened, that is an uncaught exception.
  _pool.on('error', (err) => log.warn('upload admin pool error', { message: err.message }, 'mcp-uploads'));
  return _pool;
}
