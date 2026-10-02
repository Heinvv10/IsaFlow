/**
 * rev-d7-35ba3c9f2 (MEDIUM): the fixture-DB guards read the URL the way pg
 * does. pg-connection-string lets `?host=` / `?port=` override the authority,
 * so a check on `new URL().hostname` passed URLs that connect elsewhere. No
 * database is contacted here: the guard decides from the string alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertLocalFixtureDbUrl } from '../integration/fixtureDbGuard';
import { assertDisposable } from '../integration/mfa-impersonation-postgres.helpers';
import { assertChainFixtureDb } from '../integration/k053-chain.helpers';
import { isDisposableFixtureTarget } from './mcp/w2/generalLedgerStream.helpers';

const BOTH = ['isaflow_schema_fixture', 'isaflow_test'] as const;
const FIXTURE = 'postgres://127.0.0.1:55707/isaflow_schema_fixture';
const FIXTURE_TEST = 'postgres://127.0.0.1:55707/isaflow_test';

const REFUSED: Array<[string, string | undefined]> = [
  ['host override to the dev server', 'postgresql://localhost/isaflow_test?host=100.96.203.105&port=7772'],
  ['host override, fixture name', 'postgresql://127.0.0.1:55707/isaflow_schema_fixture?host=10.0.0.5'],
  ['port override', 'postgresql://localhost:55707/isaflow_test?port=1'],
  ['unix socket via host', 'postgresql://localhost/isaflow_test?host=/var/run/postgresql'],
  ['options parameter', 'postgresql://localhost:55707/isaflow_test?options=-c%20search_path%3Dx'],
  ['dbname parameter', 'postgresql://localhost:55707/isaflow_test?dbname=isaflow_dev'],
  ['the dev server itself', 'postgresql://100.96.203.105:7772/isaflow_dev'],
  ['the Supabase stack on localhost', 'postgresql://localhost:7772/isaflow_test'],
  ['the Supabase pooler on localhost', 'postgresql://127.0.0.1:7774/isaflow_test'],
  ['dev database name', 'postgresql://127.0.0.1:55707/isaflow_dev'],
  ['production database name', 'postgresql://127.0.0.1:55707/isaflow'],
  ['staging database name', 'postgresql://127.0.0.1:55707/isaflow_staging'],
  ['missing', undefined],
  ['not a URL', 'isaflow_test'],
];

describe('assertLocalFixtureDbUrl', () => {
  it.each(REFUSED)('refuses %s', (_label, url) => {
    expect(() => assertLocalFixtureDbUrl('DATABASE_URL', url, BOTH)).toThrow();
  });

  it.each([
    [FIXTURE],
    [FIXTURE_TEST],
    [`${FIXTURE}?sslmode=disable`],
    ['postgres://localhost:55707/isaflow_test'],
  ])('accepts the local fixture %s', (url) => {
    expect(() => assertLocalFixtureDbUrl('DATABASE_URL', url, BOTH)).not.toThrow();
  });

  it('holds a caller to its own names', () => {
    expect(() => assertLocalFixtureDbUrl('DATABASE_URL', FIXTURE_TEST, ['isaflow_schema_fixture'])).toThrow();
  });
});

describe('the three guards use it', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  function env(db: string, admin = db): void {
    vi.stubEnv('ISAFLOW_DISPOSABLE_AUTH_TEST', '1');
    vi.stubEnv('DATABASE_URL', db);
    vi.stubEnv('PLATFORM_ADMIN_DATABASE_URL', admin);
    vi.stubEnv('GOTRUE_URL', 'http://127.0.0.1:1/auth/v1');
  }
  const BYPASS = 'postgresql://localhost/isaflow_schema_fixture?host=100.96.203.105&port=7772';

  it('assertDisposable: the fixture passes, a host override on either URL does not', () => {
    env(FIXTURE);
    expect(() => assertDisposable()).not.toThrow();
    env(BYPASS, FIXTURE);
    expect(() => assertDisposable()).toThrow(/DATABASE_URL/);
    env(FIXTURE, BYPASS);
    expect(() => assertDisposable()).toThrow(/PLATFORM_ADMIN_DATABASE_URL/);
    env(FIXTURE_TEST);
    expect(() => assertDisposable()).toThrow();
  });

  it('assertChainFixtureDb: both fixture names pass, a host override does not', () => {
    env(FIXTURE);
    expect(() => assertChainFixtureDb()).not.toThrow();
    env(FIXTURE_TEST);
    expect(() => assertChainFixtureDb()).not.toThrow();
    env(BYPASS);
    expect(() => assertChainFixtureDb()).toThrow(/DATABASE_URL/);
  });

  it('isDisposableFixtureTarget: the fixture is a target, a host override is not', () => {
    env(FIXTURE);
    expect(isDisposableFixtureTarget()).toBe(true);
    env(BYPASS);
    expect(isDisposableFixtureTarget()).toBe(false);
    env(FIXTURE_TEST);
    expect(isDisposableFixtureTarget()).toBe(false);
  });
});
