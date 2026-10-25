/**
 * scripts/verify-deploy.sh runs the golden suite against PRODUCTION after a deploy, and a red run rolls the code
 * back. The a11y gate's baseline is recorded on dev data, so n-a11y-main-screens must not be part of that run.
 * This runs the real script against a stub health endpoint and a stub `bun` that records its arguments, then asks
 * Playwright itself which tests those arguments select.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** The arguments verify-deploy.sh gave `bun` for the golden step, split after the script name. */
async function goldenStepArgs(): Promise<{ code: number | null; args: string[]; out: string }> {
  server = createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const dir = mkdtempSync(path.join(tmpdir(), 'verify-deploy-'));
  const seen = path.join(dir, 'args.txt');
  const bun = path.join(dir, 'bun');
  writeFileSync(bun, `#!/bin/bash\nif [[ "$*" == *test:e2e:golden* ]]; then printf '%s\\n' "$@" > "${seen}"; fi\nexit 0\n`);
  chmodSync(bun, 0o755);

  const env = { ...process.env, BUN: bun, VERIFY_SKIP_INTEGRITY: '1', E2E_ADMIN_EMAIL: 'e@x', E2E_ADMIN_PASSWORD: 'p' };
  const child = spawn('bash', ['scripts/verify-deploy.sh', `http://127.0.0.1:${port}`], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise<number | null>((r) => child.on('close', r));
  const all = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
  return { code, args: all.slice(all.indexOf('test:e2e:golden') + 1), out };
}

describe('verify-deploy.sh and the a11y gate', () => {
  it('runs the golden suite without the n-a11y spec: Playwright lists none of it, and still lists the rest', async () => {
    const r = await goldenStepArgs();
    expect(r.out).toContain('OK: golden paths green');
    expect(r.code).toBe(0);
    const listed = execFileSync('npx', ['playwright', 'test', '--list', '--config', 'playwright-golden.config.ts', ...r.args], { encoding: 'utf8', timeout: 60_000 });
    const tests = listed.split('\n').filter((l) => /\.spec\.ts:\d+:\d+/.test(l));
    expect(tests.filter((l) => l.includes('n-a11y-main-screens'))).toEqual([]);
    expect(tests.length).toBeGreaterThanOrEqual(10); // the exclusion removed one file, not the suite
    expect(tests.some((l) => l.includes('m-migration-wizard'))).toBe(true);
  }, 90_000);

  it('the listing WITHOUT the script\'s arguments does include the spec (the check can go red)', () => {
    const listed = execFileSync('npx', ['playwright', 'test', '--list', '--config', 'playwright-golden.config.ts'], { encoding: 'utf8', timeout: 60_000 });
    expect(listed.split('\n').some((l) => l.includes('n-a11y-main-screens'))).toBe(true);
  }, 90_000);
});
