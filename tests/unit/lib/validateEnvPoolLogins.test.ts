import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateEnv } from '@/lib/validateEnv';

/**
 * S-07b (migration 915): the request pool logs in as isaflow_app and the
 * service pool as isaflow_service. validateEnv refuses every half-done or
 * swapped combination, and in production reports a request pool that is not
 * on isaflow_app yet.
 */

const SECRET = 'x'.repeat(32);
const url = (user: string): string => `postgresql://${user}:pw@db.internal:7772/isaflow?sslmode=disable`;

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: url('postgres'),
    JWT_SECRET: SECRET,
    ENCRYPTION_KEY: SECRET,
    PORTAL_JWT_SECRET: SECRET,
    PLATFORM_ADMIN_DATABASE_URL: url('platform_admin'),
    IMPERSONATION_JWT_SECRET: SECRET,
    CRON_SECRET: SECRET,
    NODE_ENV: 'test',
  });
  delete process.env.SERVICE_DATABASE_URL;
  delete process.env.MIGRATION_ADMIN_DATABASE_URL;
  delete process.env.PGDATABASE;
});

afterEach(() => {
  process.env = saved;
  vi.restoreAllMocks();
});

describe('validateEnv — the app pools\' logins (S-07b)', () => {
  it('accepts today\'s env (owner, no service URL) and the finished rollout', () => {
    expect(() => validateEnv()).not.toThrow();
    process.env.DATABASE_URL = url('isaflow_app');
    process.env.SERVICE_DATABASE_URL = url('isaflow_service');
    expect(() => validateEnv()).not.toThrow();
  });

  it.each([
    ['the request pool on isaflow_service', 'isaflow_service', 'isaflow_service', /DATABASE_URL must not log in as isaflow_service/],
    ['the service pool on isaflow_app', 'postgres', 'isaflow_app', /SERVICE_DATABASE_URL must not log in as isaflow_app/],
    ['the service pool on the owner once the request pool is isaflow_app', 'isaflow_app', 'postgres',
      /SERVICE_DATABASE_URL must log in as isaflow_service, not "postgres"/],
    ['the two swapped', 'isaflow_service', 'isaflow_app', /DATABASE_URL must not log in as isaflow_service/],
  ])('refuses %s', (_, app, service, msg) => {
    process.env.DATABASE_URL = url(app);
    process.env.SERVICE_DATABASE_URL = url(service);
    expect(() => validateEnv()).toThrow(msg);
  });

  it('reads the role out of the pooler\'s <role>.<tenant> user', () => {
    process.env.DATABASE_URL = url('isaflow_app.tenant1');
    expect(() => validateEnv()).toThrow(/DATABASE_URL logs in as isaflow_app but SERVICE_DATABASE_URL is not set/);
    process.env.SERVICE_DATABASE_URL = url('isaflow_service.tenant1');
    expect(() => validateEnv()).not.toThrow();
  });

  it('in production, reports a request pool not yet on isaflow_app, and requires MIGRATION_ADMIN_DATABASE_URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_ADMIN_URL = 'https://admin.isaflow.co.za';
    expect(() => validateEnv()).toThrow(/MIGRATION_ADMIN_DATABASE_URL/);
    process.env.MIGRATION_ADMIN_DATABASE_URL = url('migration_admin');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    validateEnv();
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/S-07b: the request pool logs in as "postgres", not isaflow_app/);
    stderr.mockClear();
    process.env.DATABASE_URL = url('isaflow_app');
    process.env.SERVICE_DATABASE_URL = url('isaflow_service');
    validateEnv();
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toMatch(/S-07b/);
  });
});
