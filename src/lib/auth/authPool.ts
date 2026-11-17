// src/lib/auth/authPool.ts
//
// The pg Pool withAuth runs every request's transaction on. Its own pool,
// separate from src/lib/neon.ts, because withAuth needs a raw client it can
// BEGIN/COMMIT around and hand to the ALS scope.
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. This module builds its own Pool, so it must not depend on
// src/lib/neon.ts having been imported first. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import { log } from '@/lib/logger';
// The pool's numbers live in poolLimits.ts, a pure module, because
// src/lib/pdf/renderSemaphore.ts derives its own ceilings from them and must
// not pull `pg` into its graph to read two constants. See that file's header
// for the coupling.
import {
  AUTH_POOL_CONNECTION_TIMEOUT_MS, AUTH_POOL_IDLE_TIMEOUT_MS, authPoolMax,
} from '@/lib/limits/poolLimits';

let _pool: pg.Pool | null = null;

/**
 * Where (and as whom) a request transaction connects: the request pool's login (isaflow_app in production, which
 * may SET ROLE app_user), never the service pool's. Also the one source for a request's own sibling transaction
 * (companyOwnTx), so its rows land in the database, under the role, the request reads.
 */
export function authConnection(): Pick<pg.ClientConfig, 'connectionString' | 'ssl'> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  return {
    connectionString: url,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  };
}

export function getAuthPool(): pg.Pool {
  if (_pool) return _pool;
  _pool = new pg.Pool({
    ...authConnection(),
    max: authPoolMax(),
    connectionTimeoutMillis: AUTH_POOL_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: AUTH_POOL_IDLE_TIMEOUT_MS,
  });
  _pool.on('error', (err) => log.warn('withAuth pool background error', { message: err.message }, 'Auth'));
  return _pool;
}
