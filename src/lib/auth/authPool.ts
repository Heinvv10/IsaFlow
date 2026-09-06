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

let _pool: pg.Pool | null = null;

export function getAuthPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  _pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.AUTH_POOL_MAX ?? 20),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  _pool.on('error', (err) => log.warn('withAuth pool background error', { message: err.message }, 'Auth'));
  return _pool;
}
