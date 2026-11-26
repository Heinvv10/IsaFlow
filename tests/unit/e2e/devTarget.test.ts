/** The e2e dev-target allowlist (tests/e2e/helpers/devTarget.ts): dev and CI pass, production and anything unclear do not. */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FullConfig } from '@playwright/test';
import {
  assertDevOrCiBaseUrl, assertDevOrCiDatabaseEnv, assertDevOrCiDatabaseUrl, assertDevOrCiTarget, assertDevStorageState,
  assertDevServer, devBaseUrl, DevTargetError,
} from '../../e2e/helpers/devTarget';
import devTargetGlobalSetup from '../../e2e/helpers/devTargetGlobalSetup';

/** A made-up credential, joined here so no URL in this file looks like a real one to the secret scan. */
const FAKE_PASSWORD = ['not', 'a', 'password'].join('-');
function devStack(database: string): string {
  const url = new URL(`postgresql://100.96.203.105:7772/${database}?sslmode=disable`);
  url.username = 'postgres';
  url.password = FAKE_PASSWORD;
  return url.href;
}
const DEV_DB = devStack('isaflow_dev');
const PROD_DB = devStack('isaflow');
const CI_DB = 'postgresql://postgres@127.0.0.1:41234/isaflow_golden?sslmode=disable';
const CI = { GITHUB_ACTIONS: 'true' };

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** Every request answers `body`. @returns the addresses asked. */
function serverSays(body: unknown): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => { asked.push(url); return new Response(JSON.stringify(body)); });
  return asked;
}

describe('base URL', () => {
  it.each(['http://localhost:3200', 'http://localhost:3299', 'http://localhost:3300', 'http://localhost:3799', 'http://127.0.0.1:3457', 'http://localhost:3243/'])(
    'accepts the dev/CI server %s', (url) => { expect(assertDevOrCiBaseUrl(url)).toBe(url); });

  it.each([
    'http://localhost:3101', 'http://localhost:3111', 'http://localhost:3112', 'http://127.0.0.1:3101', 'http://127.0.0.1:3111',
    'http://127.0.0.1:3112', 'http://localhost', 'http://localhost:80', 'http://localhost:443', 'https://localhost',
  ])('refuses %s as a production port', (url) => { expect(() => assertDevOrCiBaseUrl(url)).toThrow(/a production port/); });

  it.each([
    'https://app.isaflow.co.za', 'https://admin.isaflow.co.za', 'http://app.isaflow.co.za:3200', 'https://isaflow.co.za',
    'http://100.96.203.105:3200', 'http://100.96.203.105:3111', 'http://velo-server:3200', 'http://0.0.0.0:3200', 'http://[::1]:3200',
    'http://localhost.example.com:3200', 'http://localhost:3200@app.isaflow.co.za',
  ])('refuses the host of %s', (url) => { expect(() => assertDevOrCiBaseUrl(url)).toThrow(/not localhost/); });

  it.each(['http://localhost:3000', 'http://localhost:3199', 'http://localhost:3800', 'http://localhost:7770', 'http://localhost:8080'])(
    'refuses %s, outside the dev ports', (url) => { expect(() => assertDevOrCiBaseUrl(url)).toThrow(/outside the dev ports/); });

  it.each([undefined, '', 'localhost:3200', '/accounting', 'not a url', 'ftp://localhost:3200', 'https://localhost:3200', 'http://u:p@localhost:3200'])(
    'fails closed on %s', (url) => { expect(() => assertDevOrCiBaseUrl(url)).toThrow(DevTargetError); });
});

describe('database URL', () => {
  it('accepts isaflow_dev on the dev stack', () => { expect(assertDevOrCiDatabaseUrl(DEV_DB, {})).toBe(DEV_DB); });

  it('accepts the hosted throwaway database only with the CI marker', () => {
    expect(assertDevOrCiDatabaseUrl(CI_DB, CI)).toBe(CI_DB);
    for (const env of [{}, { GITHUB_ACTIONS: 'false' }, { CI: 'true' }]) expect(() => assertDevOrCiDatabaseUrl(CI_DB, env)).toThrow(DevTargetError);
  });

  it.each([
    PROD_DB,
    'postgresql://u@127.0.0.1:7772/isaflow',
    'postgresql://u@100.96.203.105:7772/isaflow_prod',
    'postgresql://u@100.96.203.105:7772/postgres',
    'postgresql://u@100.96.203.105:7772/',
    'postgresql://u@100.96.203.105:5432/isaflow_dev',
    'postgresql://u@db.example.com:7772/isaflow_dev',
    'postgresql://u@127.0.0.1:7772/isaflow_dev',
    'postgresql://u@db.example.com:5432/isaflow_golden',
    'postgresql://u@127.0.0.1/isaflow_golden',
    'postgresql://u@127.0.0.1:7772/isaflow_golden',
    'postgresql://u@localhost:7772/isaflow_golden',
    `${DEV_DB}&dbname=isaflow`,
    `${DEV_DB}&host=db.example.com`,
    `${DEV_DB}&port=5432`,
    `${DEV_DB}&options=-c%20search_path%3Dx`,
    `${DEV_DB}&service=production`,
    'mysql://u@100.96.203.105:7772/isaflow_dev',
    'postgresql://u@100.96.203.105:7772/%E0%A4%A',
    'isaflow_dev',
    '',
  ])('refuses %s, CI marker or not', (url) => {
    expect(() => assertDevOrCiDatabaseUrl(url, CI)).toThrow(DevTargetError);
    expect(() => assertDevOrCiDatabaseUrl(url, {})).toThrow(DevTargetError);
  });

  it('never echoes the password', () => {
    expect(() => assertDevOrCiDatabaseUrl(PROD_DB, {})).toThrow(expect.objectContaining({ message: expect.not.stringContaining(FAKE_PASSWORD) }));
  });

  it.each(['DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'SERVICE_DATABASE_URL', 'GOLDEN_HOSTED_DB_URL'])(
    'one production %s beside dev keys refuses the env', (key) => {
      expect(() => assertDevOrCiDatabaseEnv({ DATABASE_URL: DEV_DB, [key]: PROD_DB })).toThrow(new RegExp(key));
    });

  it('an env without a database, or with an empty one, passes', () => {
    expect(() => assertDevOrCiDatabaseEnv({ DATABASE_URL: '', PATH: '/usr/bin' })).not.toThrow();
  });
});

describe('target', () => {
  it('needs both the server and the databases', () => {
    expect(assertDevOrCiTarget('http://localhost:3200', { DATABASE_URL: DEV_DB })).toBe('http://localhost:3200');
    expect(() => assertDevOrCiTarget('http://localhost:3111', { DATABASE_URL: DEV_DB })).toThrow(/production port/);
    expect(() => assertDevOrCiTarget('http://localhost:3200', { DATABASE_URL: PROD_DB })).toThrow(/neither dev nor a CI database/);
  });

  /** No database but the case's own, and no BASE_URL: the unit run's env (a dummy URL, or dev) is not part of it. */
  const clearTargetEnv = (): void => {
    for (const k of Object.keys(process.env)) {
      if (k === 'BASE_URL' || k === 'GOLDEN_HOSTED_DB_URL' || k.includes('DATABASE_URL')) vi.stubEnv(k, '');
    }
  };

  it('devBaseUrl reads BASE_URL, defaults to the dev server and refuses a production one', () => {
    clearTargetEnv();
    expect(devBaseUrl(undefined)).toBe('http://localhost:3200');
    expect(() => devBaseUrl('http://localhost:3112')).toThrow(/production port/);
    vi.stubEnv('BASE_URL', 'http://localhost:3457');
    expect(devBaseUrl()).toBe('http://localhost:3457');
    vi.stubEnv('BASE_URL', 'http://localhost:3111');
    expect(() => devBaseUrl()).toThrow(/production port/);
  });

  it('devBaseUrl refuses a dev server while the env holds the production database', () => {
    clearTargetEnv();
    vi.stubEnv('DATABASE_URL', PROD_DB);
    expect(() => devBaseUrl('http://localhost:3200')).toThrow(/neither dev nor a CI database/);
  });

  const config = (...urls: (string | undefined)[]) => ({ projects: urls.map((baseURL) => ({ use: { baseURL } })) }) as unknown as FullConfig;

  it('the shared global setup passes an all-dev config', async () => {
    clearTargetEnv();
    const asked = serverSays({ testDatabase: true });
    await expect(devTargetGlobalSetup(config('http://localhost:3201', 'http://127.0.0.1:3202'))).resolves.toBeUndefined();
    expect(asked).toEqual(['http://localhost:3201', 'http://127.0.0.1:3202'].map((o) => `${o}/api/health/test-database`));
  });

  it('the shared global setup refuses a config with any production project, or none', async () => {
    clearTargetEnv();
    serverSays({ testDatabase: true });
    await expect(devTargetGlobalSetup(config('http://localhost:3200', 'http://localhost:3111'))).rejects.toThrow(/production port/);
    await expect(devTargetGlobalSetup(config(undefined))).rejects.toThrow(/is not set/);
    await expect(devTargetGlobalSetup(config())).rejects.toThrow(/is not set/);
  });

  it('the shared global setup refuses a dev config while the env holds the production database', async () => {
    clearTargetEnv();
    vi.stubEnv('DATABASE_URL', PROD_DB);
    await expect(devTargetGlobalSetup(config('http://localhost:3200'))).rejects.toThrow(/neither dev nor a CI database/);
  });

  it.each([
    'https://app.isaflow.co.za', 'https://admin.isaflow.co.za', 'http://localhost:3111', 'http://127.0.0.1:3101', 'http://localhost',
    'https://localhost:3200', 'http://100.96.203.105:3200', 'http://localhost:3000', '', 'null',
  ])('a saved session holding local storage for "%s" is refused', (origin) => {
    const state = { cookies: [], origins: [{ origin: 'http://localhost:3200' }, { origin }] };
    expect(() => assertDevStorageState(state)).toThrow(/storageState origin/);
  });

  it('local storage of dev servers passes; a malformed session is refused', () => {
    expect(() => assertDevStorageState({ cookies: [], origins: [{ origin: 'http://localhost:3200' }, { origin: 'http://127.0.0.1:3457' }] })).not.toThrow();
    expect(() => assertDevStorageState({ origins: [null] } as never)).toThrow(/storageState origin is not set/);
    expect(() => assertDevStorageState({ origins: {} } as never)).toThrow(/cannot be read/);
    expect(() => assertDevStorageState({ cookies: {} } as never)).toThrow(/cannot be read/);
  });

  const cookie = (domain: string) => ({ cookies: [{ domain: 'localhost' }, { domain }] });

  it('a saved session of this machine, or none, passes', () => {
    expect(() => assertDevStorageState(undefined)).not.toThrow();
    expect(() => assertDevStorageState({ cookies: [] })).not.toThrow();
    expect(() => assertDevStorageState(cookie('127.0.0.1'))).not.toThrow();
  });

  it.each(['admin.isaflow.co.za', '.isaflow.co.za', 'app.isaflow.co.za', '100.96.203.105'])('a saved session with a cookie for %s is refused', (domain) => {
    expect(() => assertDevStorageState(cookie(domain))).toThrow(/holds a cookie/);
  });

  it('a saved session file is read and judged; one that cannot be read is refused', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dev-target-state-'));
    try {
      const file = path.join(dir, 'state.json');
      writeFileSync(file, JSON.stringify(cookie('app.isaflow.co.za')));
      expect(() => assertDevStorageState(file)).toThrow(/holds a cookie/);
      writeFileSync(file, JSON.stringify(cookie('localhost')));
      expect(() => assertDevStorageState(file)).not.toThrow();
      writeFileSync(file, JSON.stringify({ cookies: [], origins: [{ origin: 'https://app.isaflow.co.za', localStorage: [{ name: 'k', value: 'v' }] }] }));
      expect(() => assertDevStorageState(file)).toThrow(/storageState origin/);
      writeFileSync(file, 'null');
      expect(() => assertDevStorageState(file)).toThrow(/cannot be read/);
      expect(() => assertDevStorageState(path.join(dir, 'missing.json'))).toThrow(/cannot be read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the server\'s database', () => {
  it('a yes is asked once; the question goes to the server itself, following no redirect', async () => {
    const seen: [string, string | undefined][] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => { seen.push([url, init?.redirect]); return new Response('{"testDatabase":true}'); });
    await assertDevServer('http://localhost:3611/accounting');
    await assertDevServer('http://localhost:3611');
    expect(seen).toEqual([['http://localhost:3611/api/health/test-database', 'error']]);
  });

  it.each([{ testDatabase: false }, { testDatabase: 'true' }, { status: 'ok' }, null])('refuses a server answering %j, every time it is asked', async (body) => {
    const asked = serverSays(body);
    await expect(assertDevServer('http://localhost:3612')).rejects.toThrow(/does not report a dev or CI database/);
    await expect(assertDevServer('http://localhost:3612')).rejects.toThrow(DevTargetError);
    expect(asked).toHaveLength(2);
  });

  it('refuses a server that cannot be reached or answers no JSON', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    await expect(assertDevServer('http://localhost:3613')).rejects.toThrow(/did not answer .*ECONNREFUSED/);
    vi.stubGlobal('fetch', async () => new Response('<html>another app</html>', { status: 404 }));
    await expect(assertDevServer('http://localhost:3613')).rejects.toThrow(/did not answer/);
  });

  it('asks nothing of an address that is not dev or CI', async () => {
    const asked = serverSays({ testDatabase: true });
    await expect(assertDevServer('http://localhost:3111')).rejects.toThrow(/production port/);
    expect(asked).toEqual([]);
  });
});
