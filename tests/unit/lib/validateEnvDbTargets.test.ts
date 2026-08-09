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

  it('throws when a privileged URL is unparseable', () => {
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'not-a-url';
    expect(() => validateEnv()).toThrow(/PLATFORM_ADMIN_DATABASE_URL/);
  });
});
