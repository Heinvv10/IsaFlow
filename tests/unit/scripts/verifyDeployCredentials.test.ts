/**
 * verify-deploy.sh step 2: which login the golden suite gets. With the dedicated verify login (E2E_VERIFY_*) the suite runs
 * in the Deploy Verification company as that user, with no approver, and only z22 keeps a platform admin; without it the
 * old Demo behaviour is unchanged and says so. Each case runs the real script against a stub colour and a stub `bun`
 * that records the environment the golden step receives, with a temp creds file (VERIFY_CREDS_FILE).
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

const KEYS = ['E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD', 'E2E_APPROVER_EMAIL', 'E2E_APPROVER_PASSWORD', 'E2E_VERIFY_EMAIL', 'E2E_VERIFY_PASSWORD',
  'GOLDEN_PLATFORM_ADMIN_EMAIL', 'GOLDEN_PLATFORM_ADMIN_PASSWORD'];

interface Run { code: number | null; out: string; golden: Record<string, string> | null }

/** `file` is the creds file's text (null: none), `env` what is exported. */
async function run(file: string | null, env: Record<string, string>): Promise<Run> {
  server = createServer((req, res) => {
    if (req.url !== '/api/health' && !req.headers.cookie) { res.statusCode = 307; res.setHeader('Location', '/login'); } else res.statusCode = 200;
    res.end('ok');
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-creds-'));
  const seen = path.join(dir, 'golden.txt');
  const bun = path.join(dir, 'bun');
  const dump = KEYS.map((k) => `printf '${k}=%s\\n' "\${${k}-<unset>}"`).join('; ');
  writeFileSync(bun, `#!/bin/bash\nif [[ "$*" == *test:e2e:golden* ]]; then { ${dump}; } > "${seen}"; fi\nexit 0\n`);
  chmodSync(bun, 0o755);
  const creds = path.join(dir, 'deploy.env');
  if (file !== null) writeFileSync(creds, file, { mode: 0o600 });
  const base = { ...process.env, BUN: bun, VERIFY_SKIP_INTEGRITY: '1', VERIFY_CREDS_FILE: creds } as Record<string, string | undefined>;
  for (const k of KEYS) delete base[k];
  const child = spawn('bash', ['scripts/verify-deploy.sh', `http://127.0.0.1:${port}`], { env: { ...base, ...env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise<number | null>((r) => child.on('close', r));
  let golden: Record<string, string> | null = null;
  try { golden = Object.fromEntries(readFileSync(seen, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])); } catch { /* the golden step never ran */ }
  return { code, out, golden };
}

/** Creds-file text, one literal per line (a long `KEY=value` literal reads as a secret to the pre-commit scan). */
const text = (...lines: string[]): string => `${lines.join('\n')}\n`;
const ADMIN = { E2E_ADMIN_EMAIL: 'admin@demo', E2E_ADMIN_PASSWORD: 'adm-pw' };
const APPROVER = { E2E_APPROVER_EMAIL: 'appr@demo', E2E_APPROVER_PASSWORD: 'appr-pw' };
const DEMO_LINE = 'deploy checks ran on the Demo company: provision the verify company';

describe('verify-deploy.sh credential selection', () => {
  it('with the verify login in the creds file: the suite logs in as it, no approver, z22 keeps the old admin as platform admin', async () => {
    const r = await run(text('E2E_VERIFY_EMAIL=deploy-verify@isaflow.dev', 'E2E_VERIFY_PASSWORD=p$w`d"1'), { ...ADMIN, ...APPROVER });
    expect(r.code).toBe(0);
    expect(r.golden).toMatchObject({
      E2E_ADMIN_EMAIL: 'deploy-verify@isaflow.dev', E2E_ADMIN_PASSWORD: 'p$w`d"1', // read literally, never shell-parsed
      E2E_APPROVER_EMAIL: '<unset>', E2E_APPROVER_PASSWORD: '<unset>',
      GOLDEN_PLATFORM_ADMIN_EMAIL: 'admin@demo', GOLDEN_PLATFORM_ADMIN_PASSWORD: 'adm-pw',
    });
    expect(r.out).toContain('deploy checks run in the Deploy Verification company as deploy-verify@isaflow.dev (not Demo)');
    expect(r.out).not.toContain(DEMO_LINE);
    expect(r.out).not.toContain('p$w`d"1');
  }, 60_000);

  it('an exported verify pair beats the file, as every other key does', async () => {
    const r = await run(text('E2E_VERIFY_EMAIL=file@x', 'E2E_VERIFY_PASSWORD=file-pw'), { ...ADMIN, E2E_VERIFY_EMAIL: 'env@x', E2E_VERIFY_PASSWORD: 'env-pw' });
    expect(r.golden).toMatchObject({ E2E_ADMIN_EMAIL: 'env@x', E2E_ADMIN_PASSWORD: 'env-pw' });
  }, 60_000);

  it('the admin pair can come from the creds file too', async () => {
    const r = await run(text('E2E_ADMIN_EMAIL=fileadmin@x', 'E2E_ADMIN_PASSWORD=fa-pw', 'E2E_VERIFY_EMAIL=v@x', 'E2E_VERIFY_PASSWORD=v-pw'), {});
    expect(r.golden).toMatchObject({ E2E_ADMIN_EMAIL: 'v@x', GOLDEN_PLATFORM_ADMIN_EMAIL: 'fileadmin@x', GOLDEN_PLATFORM_ADMIN_PASSWORD: 'fa-pw' });
  }, 60_000);

  it('an exported platform admin pair is kept for z22', async () => {
    const r = await run(null, { ...ADMIN, E2E_VERIFY_EMAIL: 'v@x', E2E_VERIFY_PASSWORD: 'v-pw', GOLDEN_PLATFORM_ADMIN_EMAIL: 'pa@x', GOLDEN_PLATFORM_ADMIN_PASSWORD: 'pa-pw' });
    expect(r.golden).toMatchObject({ E2E_ADMIN_EMAIL: 'v@x', GOLDEN_PLATFORM_ADMIN_EMAIL: 'pa@x', GOLDEN_PLATFORM_ADMIN_PASSWORD: 'pa-pw' });
  }, 60_000);

  it('without the verify login: exactly today (admin and approver as given, no platform admin pair) plus one loud Demo line', async () => {
    const r = await run('', { ...ADMIN, ...APPROVER });
    expect(r.code).toBe(0);
    expect(r.golden).toMatchObject({ ...ADMIN, ...APPROVER, E2E_VERIFY_EMAIL: '<unset>', GOLDEN_PLATFORM_ADMIN_EMAIL: '<unset>', GOLDEN_PLATFORM_ADMIN_PASSWORD: '<unset>' });
    expect(r.out.split(DEMO_LINE).length - 1).toBe(1);
    expect(r.out).not.toContain('Deploy Verification company as');
  }, 60_000);

  it('without the verify login and without admin creds it still fails, as before', async () => {
    const r = await run(null, {});
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD not set');
    expect(r.golden).toBeNull();
  }, 60_000);

  it('one half of the verify pair fails the gate', async () => {
    for (const half of [{ E2E_VERIFY_EMAIL: 'v@x' }, { E2E_VERIFY_PASSWORD: 'v-pw' }]) {
      const r = await run(null, { ...ADMIN, ...half });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('only one of E2E_VERIFY_EMAIL/E2E_VERIFY_PASSWORD is set');
      expect(r.golden).toBeNull();
    }
  }, 60_000);

  it('the verify login with no platform admin anywhere fails before the suite, naming z22', async () => {
    const r = await run(null, { E2E_VERIFY_EMAIL: 'v@x', E2E_VERIFY_PASSWORD: 'v-pw' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('z22');
    expect(r.golden).toBeNull();
  }, 60_000);
});
