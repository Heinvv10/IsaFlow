/**
 * Probe whether a real, reachable Postgres is available to the unit suite.
 *
 * DB-backed unit tests must skip — not fail — when no DB is reachable, so the
 * suite is deterministic in CI and on machines where the dev stack is down.
 * Keying off `DATABASE_URL` alone is not enough: a URL can point at a stopped
 * DB (the 2026-05-15 outage left DATABASE_URL set but port 7772 refused, which
 * turned every guarded test red). This actually opens a short-timeout
 * connection and returns false on any failure.
 */
import { Client } from 'pg';
import { log } from '@/lib/logger';

let cached: boolean | undefined;

export async function isDbReachable(): Promise<boolean> {
  if (cached !== undefined) return cached;

  const url = process.env.DATABASE_URL;
  if (!url || url.includes('dummy')) {
    cached = false;
    return cached;
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    cached = true;
  } catch (err) {
    // Any connection failure means "no usable DB" → DB-backed tests skip.
    // Surface it (not a silent swallow) so a degraded run is debuggable.
    log.warn(
      'DB probe failed — DB-backed unit tests will skip',
      { err: err instanceof Error ? err.message : String(err) },
      'dbReachable',
    );
    cached = false;
  } finally {
    await client.end().catch(() => undefined);
  }
  return cached;
}
