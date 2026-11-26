/** What /api/health/test-database answers: the e2e guard writes only where it says yes. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { isTestDatabaseServer } from '@/lib/observability/testDatabase';

const db = vi.hoisted(() => ({ name: 'isaflow_dev' as unknown, fails: false }));
vi.mock('@/lib/neon', () => ({ sql: async () => { if (db.fails) throw new Error('down'); return [{ name: db.name }]; } }));

const { default: handler } = await import('../../../pages/api/health/test-database');

const url = (database: string, query = ''): string => `postgresql://probe@127.0.0.1:5999/${database}${query}`;

afterEach(() => { vi.unstubAllEnvs(); db.name = 'isaflow_dev'; db.fails = false; });

describe('isTestDatabaseServer', () => {
  it.each(['isaflow_dev', 'isaflow_golden'])('yes on %s, with every database URL a test one and empty ones ignored', (name) => {
    expect(isTestDatabaseServer(name, { DATABASE_URL: url(name, '?sslmode=disable'), APP_DATABASE_URL: '', PATH: '/bin' })).toBe(true);
  });

  it.each(['isaflow', 'postgres', 'isaflow_dev2', '', undefined, 1])('no when connected to %s', (name) => {
    expect(isTestDatabaseServer(name, {})).toBe(false);
  });

  it.each([
    ['DATABASE_URL', url('isaflow')], ['PLATFORM_ADMIN_DATABASE_URL', url('isaflow')], ['MIGRATION_ADMIN_DATABASE_URL', 'not a url'],
    ['SERVICE_DATABASE_URL', url('isaflow_dev', '?dbname=isaflow')], ['APP_DATABASE_URL', url('isaflow_dev', '?host=elsewhere')],
  ])('no when %s holds %s, whatever the connected database', (key, value) => {
    expect(isTestDatabaseServer('isaflow_dev', { DATABASE_URL: url('isaflow_dev'), [key]: value })).toBe(false);
  });
});

describe('GET /api/health/test-database', () => {
  async function ask(method = 'GET'): Promise<{ status: number; body: unknown }> {
    const out = { status: 0, body: undefined as unknown };
    const res = {
      setHeader: () => undefined,
      status(code: number) { out.status = code; return this; },
      json(body: unknown) { out.body = body; return this; },
    } as unknown as NextApiResponse;
    await handler({ method } as NextApiRequest, res);
    return out;
  }
  const only = (database: string): void => {
    for (const k of Object.keys(process.env)) if (k.includes('DATABASE_URL')) vi.stubEnv(k, '');
    vi.stubEnv('DATABASE_URL', url(database));
  };

  it('answers the one boolean for the connected database and the server env', async () => {
    only('isaflow_dev');
    expect(await ask()).toEqual({ status: 200, body: { testDatabase: true } });
    db.name = 'isaflow';
    expect(await ask()).toEqual({ status: 200, body: { testDatabase: false } });
    db.name = 'isaflow_dev';
    only('isaflow');
    expect(await ask()).toEqual({ status: 200, body: { testDatabase: false } });
  });

  it('says no when the database cannot be asked, and to any method but GET', async () => {
    only('isaflow_dev');
    db.fails = true;
    expect(await ask()).toEqual({ status: 503, body: { testDatabase: false } });
    expect(await ask('POST')).toEqual({ status: 405, body: { testDatabase: false } });
  });
});
