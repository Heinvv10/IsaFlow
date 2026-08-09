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

  // An omitted database is the same hazard as a mismatched one: pg falls back
  // to PGDATABASE or the role name, so `postgresql://platform_admin@host` sends
  // the admin pool to a database called `platform_admin` while the app uses
  // `isaflow`. Dropping the trailing /dbname is the exact one-character typo
  // this guard exists to catch, so it must fail boot — not warn.
  it('throws when a privileged URL omits its database', () => {
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://platform_admin@db.internal:7772';
    expect(() => validateEnv()).toThrow(/PLATFORM_ADMIN_DATABASE_URL must name a database/);
  });

  // The example must be the database this variable actually needs, not a
  // literal — pasting the hint verbatim should clear both checks, not just this
  // one. Pinned against a non-default name so a hardcoded example fails here.
  it('suggests the database DATABASE_URL resolved to, not a hardcoded name', () => {
    process.env.DATABASE_URL = `${BASE}/isaflow_staging?sslmode=disable`;
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://platform_admin@db.internal:7772';
    expect(() => validateEnv()).toThrow(/e\.g\. …:5432\/isaflow_staging/);
  });

  it('throws when DATABASE_URL omits its database', () => {
    process.env.DATABASE_URL = 'postgresql://app_user@db.internal:7772';
    expect(() => validateEnv()).toThrow(/DATABASE_URL must name a database/);
  });

  it('throws when MIGRATION_ADMIN_DATABASE_URL omits its database', () => {
    process.env.MIGRATION_ADMIN_DATABASE_URL = 'postgresql://migration_admin@db.internal:7772';
    expect(() => validateEnv()).toThrow(/MIGRATION_ADMIN_DATABASE_URL must name a database/);
  });

  // No user segment either: parse() yields user '' and database null. Earlier
  // revisions resolved this to the OS username and skipped the comparison,
  // which was a live bypass. Requiring the name closes it by construction.
  it('throws when a privileged URL names neither a database nor a user', () => {
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://db.internal:7772';
    expect(() => validateEnv()).toThrow(/PLATFORM_ADMIN_DATABASE_URL must name a database/);
  });

  it('is unaffected by PGDATABASE, which it deliberately does not consult', () => {
    process.env.PGDATABASE = 'isaflow_dev';
    expect(() => validateEnv()).not.toThrow();
    process.env.PLATFORM_ADMIN_DATABASE_URL =
      'postgresql://platform_admin@db.internal:7772/isaflow_dev';
    expect(() => validateEnv()).toThrow(/isaflow_dev/);
  });
});
