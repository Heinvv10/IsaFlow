/**
 * The rubric harness's database guard (master plan wave 4, MW): tests/e2e/rubric/_rubricDatabaseGuard.ts. Adapted from the
 * security review's attack test (PR #1209): every *DATABASE_URL the dev server sees is judged, host and port pinned,
 * redirecting query parameters refused, and the server's project dir must be its cwd.
 */
import { describe, expect, it } from 'vitest';
import {
  DEV_DB_HOST, DEV_DB_PORT, assertConnectedDev, assertDevDatabase, assertDevDatabases, assertProjectDirs, nextProjectDir,
  parseProcEnviron,
} from '../../e2e/rubric/_rubricDatabaseGuard';

const DEV = `postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow_dev?sslmode=disable`;
const refused = (fn: () => unknown, msg: RegExp) => expect(fn).toThrow(msg);

describe('one database URL', () => {
  it('pins dev Supabase', () => {
    expect([DEV_DB_HOST, DEV_DB_PORT]).toEqual(['100.96.203.105', 7772]);
  });

  it('accepts dev', () => {
    expect(() => assertDevDatabase(DEV)).not.toThrow();
    expect(() => assertDevDatabase(`postgres://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow_dev`)).not.toThrow();
  });

  it.each([
    ['postgresql://u@prodhost:5432/isaflow_dev', /host is "prodhost"/],
    [`postgresql://u@${DEV_DB_HOST}:5432/isaflow_dev`, /port is "5432"/],
    [`postgresql://u@${DEV_DB_HOST}/isaflow_dev`, /port is "default"/],
    ['postgresql://u@localhost:7772/isaflow_dev', /host is "localhost"/],
    [`postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow_dev?host=/var/run/postgresql&port=5432`, /parameter "host"/],
    [`postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow_dev?hostaddr=10.0.0.9`, /parameter "hostaddr"/],
    [`postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow_dev?port=5432`, /parameter "port"/],
    [`postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow_dev?options=-c%20search_path%3Dprod`, /parameter "options"/],
    [`postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow_dev?DBNAME=isaflow`, /parameter "DBNAME"/],
    [`postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow_dev?dbname=isaflow`, /parameter "dbname"/],
    [`postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow_dev_prod`, /not isaflow_dev/],
    [`postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow`, /"isaflow", not isaflow_dev/],
    [`postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/ISAFLOW_DEV`, /not isaflow_dev/],
    ['socket://u@/var/run/postgresql/isaflow_dev', /not a URL/],
    ['mysql://u@h/isaflow_dev', /must be postgres/],
    ['not a url', /not a URL/],
    ['', /empty/],
  ])('refuses %s', (url, msg) => {
    refused(() => assertDevDatabase(url), msg);
  });

  // Round 2 of the security review (PR #1209): spellings that still name dev are accepted, the rest refused.
  const H = `${DEV_DB_HOST}:${DEV_DB_PORT}`;
  const PG = 'postgresql://'; // split off: the pre-commit secret scan reads `scheme://x:y@` as a password
  it.each([
    `${PG}u@prod:5432@${H}/isaflow_dev`, // the last @ ends the userinfo, for WHATWG and pg alike
    `postgresql://u@${DEV_DB_HOST}:07772/isaflow_dev`,
    `postgresql://u@${H}/isaflow%5Fdev`,
    `postgresql://u@${H}/isaflow_dev#host=prod`,
    `postgresql://u@${H}/isaflow_dev?sslmode=disable&sslmode=x`,
  ])('accepts %s (still dev, as both parsers read it)', (url) => {
    expect(() => assertDevDatabase(url)).not.toThrow();
  });

  it.each([
    [`postgresql://u@${H}@prod:5432/isaflow_dev`, /host is "prod"/],
    [`postgresql://u@${H},prod:5432/isaflow_dev`, /not a URL/],
    [`postgresql://u@${H}/isaflow_dev?application_name=x&host=prod`, /parameter "host"/],
    [`postgresql://u@${H}/isaflow_dev?Host=prod`, /parameter "Host"/],
    [`postgresql://u@${H}/isaflow_dev?%68ost=prod`, /parameter "host"/],
    [`postgresql://u@${H}/isaflow_dev%3Fhost%3Dprod`, /database is "isaflow_dev\?host=prod"/],
    [`postgresql://u@[::ffff:100.96.203.105]:7772/isaflow_dev`, /host is "\[::ffff:6460:cb69\]"/],
    [`postgresql://u@${H}/isaflow_dev?sslmode=disable&sslcert=/x`, /parameter "sslcert"/],
    [`postgresql://u@${H}/isaflow_dev?connect_timeout=1&sslrootcert=system`, /parameter "sslrootcert"/],
  ])('refuses %s', (url, msg) => {
    refused(() => assertDevDatabase(url), msg);
  });
});

describe('every *DATABASE_URL the server sees', () => {
  it('accepts dev for every key', () => {
    expect(assertDevDatabases({ DATABASE_URL: DEV, PLATFORM_ADMIN_DATABASE_URL: DEV, MIGRATION_ADMIN_DATABASE_URL: DEV, OTHER: 'x' }))
      .toEqual(['DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL']);
  });

  it.each([
    'SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DIRECT_DATABASE_URL',
  ])('refuses a production %s beside a dev DATABASE_URL', (key) => {
    refused(() => assertDevDatabases({ DATABASE_URL: DEV, [key]: `postgresql://u@${DEV_DB_HOST}:${DEV_DB_PORT}/isaflow` }),
      new RegExp(`${key}: .*not isaflow_dev`));
  });

  it('refuses a key that is present but empty (pg would fall back to its defaults)', () => {
    refused(() => assertDevDatabases({ DATABASE_URL: DEV, SERVICE_DATABASE_URL: '' }), /SERVICE_DATABASE_URL: .*empty/);
  });

  it('refuses a server with no DATABASE_URL', () => {
    refused(() => assertDevDatabases({ SERVICE_DATABASE_URL: DEV }), /no DATABASE_URL/);
  });
});

describe('the connected server', () => {
  it('accepts isaflow_dev on the dev stack', () => {
    expect(() => assertConnectedDev({ database: 'isaflow_dev', port: 5436 })).not.toThrow();
  });

  it.each([
    [{ database: 'isaflow', port: 5436 }, /connected to "isaflow"/],
    [{ database: 'isaflow_dev', port: 5432 }, /server port 5432/],
  ])('refuses %j', (row, msg) => {
    refused(() => assertConnectedDev(row), msg);
  });
});

describe('/proc environ', () => {
  it('splits on NUL and keeps "=" inside values', () => {
    expect(parseProcEnviron('A=1\0DATABASE_URL=postgresql://u@h/x?a=b\0\0EMPTY=\0junk\0'))
      .toEqual({ A: '1', DATABASE_URL: 'postgresql://u@h/x?a=b', EMPTY: '' });
  });
});

describe('the server project dir', () => {
  it.each([
    [['next-server (v15.5.28)'], undefined],
    [['node', '/t/node_modules/.bin/next', 'dev', '-p', '3277'], undefined],
    [['bun', 'x', 'next', 'dev', '--port=3277', '.'], '.'],
    [['node', '/t/node_modules/next/dist/bin/next', 'dev', '-H', 'localhost', '-p', '3277', '/other'], '/other'],
    [['sh', '-c', 'next dev -p 3277 ../other'], '../other'],
    [['bash', '-c', 'cd /x && bun run dev'], undefined],
    [['bash', '-c', 'cd /x && nohup node_modules/.bin/next dev -p 3277 > $SCR/log 2>&1 &'], undefined],
    [['bash', '-c', 'next dev -p 3277 2>&1 | tee log'], undefined],
    [['bash', '-c', 'next dev -p 3277 ../other > log'], '../other'],
    [['node', '/t/node_modules/next/dist/bin/next.js', 'dev', '../other'], '../other'],
    [['node', '/t/node_modules/.bin/next', 'dev', '--turbo', '../other'], '../other'],
    [['node', '/t/node_modules/.bin/next', 'dev', '-p3277', '../other'], '../other'],
  ])('%j names %s', (argv, dir) => {
    expect(nextProjectDir(argv)).toBe(dir);
  });

  it('accepts a chain whose next CLI names no dir, or its own cwd', () => {
    expect(() => assertProjectDirs([
      { argv: ['next-server (v15.5.28)'], cwd: '/srv/base' },
      { argv: ['node', '/srv/base/node_modules/.bin/next', 'dev', '-p', '3277', '.'], cwd: '/srv/base' },
    ], '/srv/base')).not.toThrow();
  });

  it.each([
    [['node', 'next', 'dev', '-p', '3277', '/srv/prod'], '/srv/base'],
    [['sh', '-c', 'next dev ../prod -p 3277'], '/srv/base'],
  ])('refuses %j run from %s', (argv, cwd) => {
    refused(() => assertProjectDirs([{ argv: ['next-server (v15.5.28)'], cwd: '/srv/base' }, { argv, cwd }], '/srv/base'),
      /project dir .* is not the server's cwd/);
  });
});

/** `next start` loads .env.production*: only a server started with `next dev` is the server the env rebuild models. */
describe('only a next dev server', () => {
  const server = { argv: ['next-server (v15.5.28)'], cwd: '/srv/base' };
  it.each([
    [['node', '/srv/base/node_modules/.bin/next', 'start']],
    [['node', '/srv/base/node_modules/.bin/next', 'start', '-p', '3277', '.']],
    [['node', '/srv/base/node_modules/next/dist/bin/next.js', 'start']],
    [['sh', '-c', 'next start -p 3277']],
  ])('refuses %j', (argv) => {
    refused(() => assertProjectDirs([server, { argv, cwd: '/srv/base' }], '/srv/base'), /started with "next start"/);
  });

  it('refuses next start even beside a next dev in the chain', () => {
    refused(() => assertProjectDirs([server, { argv: ['next', 'start'], cwd: '/srv/base' }, { argv: ['next', 'dev'], cwd: '/srv/base' }],
      '/srv/base'), /started with "next start"/);
  });

  it.each([
    [[server]],
    [[{ argv: ['node', 'server.js'], cwd: '/srv/base' }]],
    [[server, { argv: ['node', '/srv/base/node_modules/.bin/next', '-p', '3277'], cwd: '/srv/base' }]],
    [[server, { argv: ['bash', '-c', 'cd /srv/base && bun run dev'], cwd: '/srv/base' }]],
  ])('refuses a chain with no recognisable next dev: %j', (chain) => {
    refused(() => assertProjectDirs(chain, '/srv/base'), /no "next dev" in the listener's process chain/);
  });

  it('accepts next.js dev', () => {
    expect(() => assertProjectDirs([server, { argv: ['node', '/srv/base/node_modules/next/dist/bin/next.js', 'dev'], cwd: '/srv/base' }],
      '/srv/base')).not.toThrow();
  });
});
