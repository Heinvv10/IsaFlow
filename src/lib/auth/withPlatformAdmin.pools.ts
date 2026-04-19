// src/lib/auth/withPlatformAdmin.pools.ts
// Pool factories split into a separate module so tests can vi.doMock them
// without also mocking the core middleware.
import pg from 'pg';
import { log } from '@/lib/logger';

let _appPool: pg.Pool | null = null;
let _adminPool: pg.Pool | null = null;

function sslOpt() {
  return process.env.DATABASE_SSL === 'strict'
    ? { rejectUnauthorized: true }
    : process.env.DATABASE_SSL === 'disable'
      ? false
      : { rejectUnauthorized: false };
}

export function getAppPool(): pg.Pool {
  if (_appPool) return _appPool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  _appPool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.AUTH_POOL_MAX ?? 20),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl: sslOpt(),
  });
  _appPool.on('error', (err) =>
    log.warn('withPlatformAdmin app pool error', { message: err.message }, 'Auth')
  );
  return _appPool;
}

export function getPlatformAdminPool(): pg.Pool {
  if (_adminPool) return _adminPool;
  const url = process.env.PLATFORM_ADMIN_DATABASE_URL;
  if (!url) throw new Error('PLATFORM_ADMIN_DATABASE_URL required');
  _adminPool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PLATFORM_ADMIN_POOL_MAX ?? 10),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl: sslOpt(),
  });
  _adminPool.on('error', (err) =>
    log.warn('withPlatformAdmin admin pool error', { message: err.message }, 'Auth')
  );
  return _adminPool;
}
