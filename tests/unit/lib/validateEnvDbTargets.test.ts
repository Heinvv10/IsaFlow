import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateEnv } from '@/lib/validateEnv';

/**
 * Regression guard for the 2026-08-09 incident: prod's
 * PLATFORM_ADMIN_DATABASE_URL named `isaflow_dev` while DATABASE_URL named
 * `isaflow`. Because withPlatformAdmin routes every /api/admin/* query through
 * the platform-admin pool (via the ALS request client in lib/neon), the whole
 * admin console silently read and wrote the dev database for ~3.5 months while
 * auth still resolved against prod. Presence checks alone did not catch it.
 */

const BASE = 'postgresql://app_user@db.internal:7772';
const SECRET = 'x'.repeat(32);

const REQUIRED = {
  DATABASE_URL: `${BASE}/isaflow?sslmode=disable`,
  JWT_SECRET: SECRET,
  ENCRYPTION_KEY: SECRET,
  PORTAL_JWT_SECRET: SECRET,
  PLATFORM_ADMIN_DATABASE_URL: `postgresql://platform_admin@db.internal:7772/isaflow?sslmode=disable`,
  IMPERSONATION_JWT_SECRET: SECRET,
  CRON_SECRET: SECRET,
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  for (const [k, v] of Object.entries(REQUIRED)) process.env[k] = v;
  delete process.env.MIGRATION_ADMIN_DATABASE_URL;
  // PGDATABASE participates in pg's resolution order, so a stray value would
  // silently change what every case below resolves to.
  delete process.env.PGDATABASE;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  process.env = saved;
});

describe('validateEnv — privileged pool database targets', () => {
  it('passes when every DB URL names the same database', () => {
    expect(() => validateEnv()).not.toThrow();
  });

  it('throws when PLATFORM_ADMIN_DATABASE_URL names a different database', () => {
    process.env.PLATFORM_ADMIN_DATABASE_URL =
      `postgresql://platform_admin@db.internal:7772/isaflow_dev?sslmode=disable`;
    expect(() => validateEnv()).toThrow(/PLATFORM_ADMIN_DATABASE_URL/);
    expect(() => validateEnv()).toThrow(/isaflow_dev/);
  });

  it('throws when MIGRATION_ADMIN_DATABASE_URL names a different database', () => {
    process.env.MIGRATION_ADMIN_DATABASE_URL =
      `postgresql://migration_admin@db.internal:7772/isaflow_staging?sslmode=disable`;
    expect(() => validateEnv()).toThrow(/MIGRATION_ADMIN_DATABASE_URL/);
  });

  it('ignores MIGRATION_ADMIN_DATABASE_URL when it is not set', () => {
    delete process.env.MIGRATION_ADMIN_DATABASE_URL;
    expect(() => validateEnv()).not.toThrow();
  });

  it('allows a different host or port for the same database (pooler vs direct)', () => {
    process.env.PLATFORM_ADMIN_DATABASE_URL =
      `postgresql://platform_admin@pooler.internal:6543/isaflow?sslmode=disable`;
    expect(() => validateEnv()).not.toThrow();
  });

  it('ignores query parameters when comparing database names', () => {
    process.env.PLATFORM_ADMIN_DATABASE_URL =
      `postgresql://platform_admin@db.internal:7772/isaflow`;
    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects a garbage privileged URL as a mismatch', () => {
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'not-a-url';
    expect(() => validateEnv()).toThrow(/PLATFORM_ADMIN_DATABASE_URL/);
  });

  // The database of a `socket:` URL lives in `?db=`, not the path. Parsing with
  // `new URL()` yields the socket directory for both of these, comparing equal
  // and letting a genuine cross-database mismatch through undetected.
  it('detects a mismatch between socket URLs differing only by ?db=', () => {
    process.env.DATABASE_URL = 'socket:/var/run/postgresql?db=isaflow';
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'socket:/var/run/postgresql?db=isaflow_dev';
    expect(() => validateEnv()).toThrow(/isaflow_dev/);
  });

  it('accepts socket URLs naming the same database', () => {
    process.env.DATABASE_URL = 'socket:/var/run/postgresql?db=isaflow';
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'socket:/var/run/postgresql?db=isaflow';
    expect(() => validateEnv()).not.toThrow();
  });

  it('treats percent-encoded and plain spellings of one database as equal', () => {
    process.env.PLATFORM_ADMIN_DATABASE_URL =
      `postgresql://platform_admin@db.internal:7772/isa%66low?sslmode=disable`;
    expect(() => validateEnv()).not.toThrow();
  });

  // pg defaults an unnamed database to the connecting role's name. That is a
  // real divergence, not an incomparable one: the admin pool would land on a
  // database called `platform_admin` while the app uses `isaflow`. Dropping the
  // trailing /dbname is the exact typo this guard exists to catch, so it must
  // fail boot rather than emit a warning that scrolls past in the logs.
  it('throws when a privileged URL omits its database and falls back to the role', () => {
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://platform_admin@db.internal:7772';
    expect(() => validateEnv()).toThrow(/platform_admin/);
  });

  it('throws when DATABASE_URL omits its database and falls back to the role', () => {
    process.env.DATABASE_URL = 'postgresql://app_user@db.internal:7772';
    expect(() => validateEnv()).toThrow(/app_user/);
  });

  it('accepts a pathless pair that PGDATABASE resolves to one database', () => {
    process.env.PGDATABASE = 'isaflow';
    process.env.DATABASE_URL = 'postgresql://app_user@db.internal:7772';
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://platform_admin@db.internal:7772';
    expect(() => validateEnv()).not.toThrow();
  });

  it('does not let PGDATABASE mask an explicitly named mismatch', () => {
    process.env.PGDATABASE = 'isaflow';
    process.env.PLATFORM_ADMIN_DATABASE_URL =
      'postgresql://platform_admin@db.internal:7772/isaflow_dev';
    expect(() => validateEnv()).toThrow(/isaflow_dev/);
  });

  it('warns without throwing when no database, PGDATABASE, or role is available', () => {
    process.env.DATABASE_URL = 'postgresql://db.internal:7772';
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://db.internal:7772';
    expect(() => validateEnv()).not.toThrow();
  });
});

/**
 * The guard is only as good as its agreement with the driver. Pin the
 * resolution order against pg's real ConnectionParameters — the class
 * `new pg.Pool({ connectionString })` builds — so a future pg change that moves
 * the PGDATABASE/role fallback breaks this test instead of silently making the
 * guard check something the driver does not do.
 */
describe('effective database resolution matches pg.ConnectionParameters', () => {
  const CASES: Array<{ url: string; pgdatabase?: string }> = [
    { url: 'postgresql://platform_admin@db.internal:7772/isaflow' },
    { url: 'postgresql://platform_admin@db.internal:7772' },
    { url: 'postgresql://platform_admin@db.internal:7772', pgdatabase: 'isaflow_dev' },
    { url: 'postgresql://platform_admin@db.internal:7772/isaflow', pgdatabase: 'isaflow_dev' },
    { url: 'socket:/var/run/postgresql?db=isaflow' },
    { url: 'postgresql://platform_admin@db.internal:7772/isa%66low' },
  ];

  it.each(CASES)('resolves $url the same way pg does', async ({ url, pgdatabase }) => {
    if (pgdatabase === undefined) delete process.env.PGDATABASE;
    else process.env.PGDATABASE = pgdatabase;

    const { default: ConnectionParameters } = await import('pg/lib/connection-parameters.js');
    const pgResolved = new ConnectionParameters({ connectionString: url }).database;

    // Same inputs through validateEnv: a mismatch against a DATABASE_URL pinned
    // to pg's own answer would throw; agreement must not.
    process.env.DATABASE_URL = url;
    process.env.PLATFORM_ADMIN_DATABASE_URL = `postgresql://someone@db.internal:7772/${pgResolved}`;
    expect(() => validateEnv()).not.toThrow();
  });
});
