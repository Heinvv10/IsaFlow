/**
 * guardDevTarget under the REAL Playwright runner: pointed anywhere but dev or CI, no hook and no test of a guarded
 * file runs. A beforeAll guard would not do this: Playwright runs the other beforeAll and afterAll hooks after one throws.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BAD_PORTS } from '../../../scripts/ci/golden-free-port';

const ROOT = path.resolve(__dirname, '../../..');
const OUTPUT = mkdtempSync(path.join(os.tmpdir(), 'dev-target-probe-'));

/** A stand-in app server on a free dev port, giving `testDatabase` as its answer to the database question. */
async function appServer(testDatabase: boolean): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ testDatabase })); });
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 3200 + Math.floor(Math.random() * 600);
    if (BAD_PORTS.has(port)) continue; // fetch refuses it
    const listening = await new Promise<boolean>((resolve) => {
      const failed = (): void => resolve(false);
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve(true); });
    });
    if (listening) return { server, url: `http://127.0.0.1:${port}` };
  }
  throw new Error('no free dev port for the probe server');
}
const servers: Server[] = [];
/** DEV and OTHER are on a test database; NOT_TEST is a dev server that is not. */
let DEV = '';
let OTHER = '';
let NOT_TEST = '';
beforeAll(async () => {
  const started = [await appServer(true), await appServer(true), await appServer(false)];
  servers.push(...started.map((s) => s.server));
  [DEV, OTHER, NOT_TEST] = started.map((s) => s.url) as [string, string, string];
});
afterAll(() => { for (const s of servers) s.close(); rmSync(OUTPUT, { recursive: true, force: true }); });
const ALL = ['first-beforeAll', 'second-beforeAll', 'test', 'nested-beforeAll', 'nested-test', 'nested-afterAll', 'afterAll'];

function probe(extra: Record<string, string>): Promise<{ code: number; out: string; ran: string[] }> {
  // The probe judges every *DATABASE_URL* of its env: the unit run's own (a dummy, or dev) are not part of the case.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.includes('DATABASE_URL') && k !== 'GOLDEN_HOSTED_DB_URL'));
  return new Promise((resolve) => {
    execFile(path.join(ROOT, 'node_modules/.bin/playwright'), ['test', '-c', 'tests/fixtures/dev-target-probe/probe.config.ts'],
      { cwd: ROOT, env: { ...env, PROBE_OUTPUT_DIR: OUTPUT, ...extra } as unknown as NodeJS.ProcessEnv, timeout: 90_000 }, (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`;
        const ran = [...out.matchAll(/PROBE-RAN (\S+)/g)].map((m) => m[1]!);
        resolve({ code: err ? Number(err.code ?? 1) : 0, out, ran });
      });
  });
}

describe('guardDevTarget in a Playwright run', () => {
  it('lets every hook and test run against a dev server', async () => {
    // Not the default port: the guard must hand on the URL it judged.
    const r = await probe({ PROBE_BASE_URL: DEV });
    expect(r.code, r.out).toBe(0);
    expect(r.ran.sort()).toEqual([...ALL].sort());
  }, 120_000);

  it.each(['http://localhost:3111', 'http://localhost:3112', 'http://localhost:3101', 'https://app.isaflow.co.za', ''])(
    'runs no hook and no test against "%s", and fails', async (url) => {
      const r = await probe({ PROBE_BASE_URL: url });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('dev-target guard');
      expect(r.ran).toEqual([]);
    }, 120_000);

  it('runs no hook and no test against a dev server that is not on a test database', async () => {
    const r = await probe({ PROBE_BASE_URL: NOT_TEST });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('does not report a dev or CI database');
    expect(r.ran).toEqual([]);
  }, 120_000);

  it('without a beforeAll, a refused file runs no test and no each-hook that asks for a guarded fixture', async () => {
    const refused = await probe({ PROBE_BASE_URL: NOT_TEST, PROBE_EACH_ONLY: '1' });
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('does not report a dev or CI database');
    expect(refused.ran).toEqual([]);
    const allowed = await probe({ PROBE_BASE_URL: DEV, PROBE_EACH_ONLY: '1' });
    expect(allowed.code, allowed.out).toBe(0);
    expect(allowed.ran).toEqual(['beforeEach', 'beforeEach-second', 'test', 'afterEach'].map((k) => `each-${k}`));
  }, 240_000);

  it.each(['1', ''])('refuses a later test.use that names a server off a test database (beforeAll "%s")', async (beforeAll) => {
    const r = await probe({ PROBE_BASE_URL: DEV, PROBE_BROWSER_HOOKS: '1', PROBE_BEFORE_ALL: beforeAll, PROBE_OVERRIDE_URL: NOT_TEST });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('does not report a dev or CI database');
    expect(r.out).not.toContain("Executable doesn't exist");
    expect(r.ran.filter((x) => x.startsWith('overridden'))).toEqual([]);
  }, 120_000);

  it('refuses a file whose spec took an address of its own that is off a test database', async () => {
    const r = await probe({ PROBE_BASE_URL: DEV, PROBE_NAMED_URL: NOT_TEST });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('does not report a dev or CI database');
    expect(r.ran).toEqual([]);
  }, 120_000);

  it.each(['1', ''].flatMap((beforeAll) => [
    ['a later test.use that names a production port', { PROBE_OVERRIDE_URL: 'http://localhost:3111', PROBE_BEFORE_ALL: beforeAll }, 'production port', 'overridden'],
    ['a saved session holding a production cookie', { PROBE_COOKIE_DOMAIN: 'admin.isaflow.co.za', PROBE_BEFORE_ALL: beforeAll }, 'storageState holds a cookie', 'session'],
  ] as const))('refuses %s: none of its hooks, nor its test, runs (%o)', async (_what, extra, why, name) => {
    const r = await probe({ PROBE_BASE_URL: DEV, PROBE_BROWSER_HOOKS: '1', ...extra });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(why);
    // A hook that got as far as launching a browser was not refused, even where none is installed.
    expect(r.out).not.toContain("Executable doesn't exist");
    expect(r.ran.filter((x) => x.startsWith(name))).toEqual([]);
  }, 120_000);

  it.each([
    ['a later test.use on another dev server', { PROBE_OVERRIDE_URL: 'other' }, 'overridden'],
    ['a saved session of this machine', { PROBE_COOKIE_DOMAIN: 'localhost' }, 'session'],
  ])('allows %s', async (_what, extra, name) => {
    const r = await probe({ PROBE_BASE_URL: DEV, PROBE_BEFORE_ALL: '1', ...extra, ...('PROBE_OVERRIDE_URL' in extra ? { PROBE_OVERRIDE_URL: OTHER } : {}) });
    expect(r.code, r.out).toBe(0);
    expect(r.ran.filter((x) => x.startsWith(name))).toEqual(
      ['beforeAll', 'beforeEach', 'beforeEach-second', 'test', 'afterEach'].map((k) => `${name}-${k}`));
  }, 120_000);

  it('runs nothing when the runner holds the production database, even against a dev server', async () => {
    const user = 'probe-user';
    const r = await probe({ PROBE_BASE_URL: DEV, DATABASE_URL: `postgresql://${user}@100.96.203.105:7772/isaflow` });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('neither dev nor a CI database');
    expect(r.out).not.toContain(user);
    expect(r.ran).toEqual([]);
  }, 120_000);
});
