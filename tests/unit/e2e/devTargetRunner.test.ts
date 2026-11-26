/**
 * guardDevTarget under the REAL Playwright runner: pointed anywhere but dev or CI, no hook and no test of a guarded
 * file runs. A beforeAll guard would not do this: Playwright runs the other beforeAll and afterAll hooks after one throws.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const ALL = ['first-beforeAll', 'second-beforeAll', 'test', 'nested-beforeAll', 'nested-test', 'nested-afterAll', 'afterAll'];

function probe(extra: Record<string, string>): Promise<{ code: number; out: string; ran: string[] }> {
  // The probe judges every *DATABASE_URL* of its env: the unit run's own (a dummy, or dev) are not part of the case.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.includes('DATABASE_URL') && k !== 'GOLDEN_HOSTED_DB_URL'));
  return new Promise((resolve) => {
    execFile(path.join(ROOT, 'node_modules/.bin/playwright'), ['test', '-c', 'tests/fixtures/dev-target-probe/probe.config.ts'],
      { cwd: ROOT, env: { ...env, ...extra } as NodeJS.ProcessEnv, timeout: 90_000 }, (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`;
        const ran = [...out.matchAll(/PROBE-RAN (\S+)/g)].map((m) => m[1]!);
        resolve({ code: err ? Number(err.code ?? 1) : 0, out, ran });
      });
  });
}

describe('guardDevTarget in a Playwright run', () => {
  it('lets every hook and test run against a dev server', async () => {
    const r = await probe({ PROBE_BASE_URL: 'http://localhost:3200' });
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

  it('runs nothing when the runner holds the production database, even against a dev server', async () => {
    const user = 'probe-user';
    const r = await probe({ PROBE_BASE_URL: 'http://localhost:3200', DATABASE_URL: `postgresql://${user}@100.96.203.105:7772/isaflow` });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('neither dev nor a CI database');
    expect(r.out).not.toContain(user);
    expect(r.ran).toEqual([]);
  }, 120_000);
});
