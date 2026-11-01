/**
 * scripts/verify-deploy.sh runs the golden suite against PRODUCTION after a deploy, and a red run rolls the code
 * back. The a11y gate is a dev/CI gate (its baseline is keyed to dev data), so n-a11y-main-screens must not be part
 * of that run - and must not even be LOADED, or a missing @axe-core/playwright would break a deploy check.
 *
 * This runs the real script against a stub health endpoint and a stub `bun` that records the environment it was
 * given, then asks Playwright which tests that environment selects, with `@axe-core/playwright` made unresolvable
 * (a --require trap): loading the spec would crash the listing.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { devOnlySpecFiles } from '../../e2e/golden-paths/helpers/devOnlySpecs';

const GOLDEN_DIR = path.resolve(__dirname, '../../e2e/golden-paths');
const EXCLUDED = devOnlySpecFiles(GOLDEN_DIR).map((f) => f.replace('.spec.ts', ''));
const PREFIX = ['s2-shell', 'q-top-nav', 'm-migration'];

let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** What verify-deploy.sh handed the golden step: its arguments and the one variable the config reads. */
async function goldenStep(): Promise<{ code: number | null; args: string[]; skipA11y: string; out: string }> {
  server = createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const dir = mkdtempSync(path.join(tmpdir(), 'verify-deploy-'));
  const seen = path.join(dir, 'step.txt');
  const bun = path.join(dir, 'bun');
  writeFileSync(bun, `#!/bin/bash\nif [[ "$*" == *test:e2e:golden* ]]; then { printf 'GOLDEN_SKIP_A11Y=%s\\n' "\${GOLDEN_SKIP_A11Y-<unset>}"; printf '%s\\n' "$@"; } > "${seen}"; fi\nexit 0\n`);
  chmodSync(bun, 0o755);

  const env = { ...process.env, BUN: bun, VERIFY_SKIP_INTEGRITY: '1', E2E_ADMIN_EMAIL: 'e@x', E2E_ADMIN_PASSWORD: 'p' } as Record<string, string | undefined>;
  delete env.GOLDEN_SKIP_A11Y;
  const child = spawn('bash', ['scripts/verify-deploy.sh', `http://127.0.0.1:${port}`], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise<number | null>((r) => child.on('close', r));
  const lines = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
  return { code, skipA11y: lines[0]!.replace('GOLDEN_SKIP_A11Y=', ''), args: lines.slice(lines.indexOf('test:e2e:golden') + 1), out };
}

/** A --require module that makes `@axe-core/playwright` fail to resolve, exactly as a missing package would. */
function axeTrap(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'axe-trap-')), 'trap.js');
  writeFileSync(file, `const M = require('module'); const orig = M._resolveFilename;
M._resolveFilename = function (request, ...rest) { if (request === '@axe-core/playwright') throw new Error("TRAP: Cannot find module '@axe-core/playwright'"); return orig.call(this, request, ...rest); };\n`);
  return file;
}

function listTests(env: Record<string, string>, args: string[] = []): string[] {
  const out = execFileSync('npx', ['playwright', 'test', '--list', '--config', 'playwright-golden.config.ts', ...args], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env, NODE_OPTIONS: `--require ${axeTrap()}` },
  });
  return out.split('\n').filter((l) => /\.spec\.ts:\d+:\d+/.test(l));
}

describe('verify-deploy.sh and the a11y gate', () => {
  it('runs the golden suite with the a11y spec ignored: not listed, not even loaded (axe unresolvable), the rest still listed', async () => {
    const r = await goldenStep();
    expect(r.out).toContain('OK: golden paths green');
    expect(r.code).toBe(0);
    expect(r.skipA11y).toBe('1');
    const tests = listTests({ GOLDEN_SKIP_A11Y: r.skipA11y }, r.args); // throws if the spec were loaded
    expect(EXCLUDED.length).toBe(18);
    expect(tests.filter((l) => EXCLUDED.some((n) => l.includes(`${n}.spec.ts`)))).toEqual([]);
    expect(tests.length).toBeGreaterThanOrEqual(10); // one file left out, not the suite
    for (const p of PREFIX) expect(tests.some((l) => l.includes(p))).toBe(true);
  }, 90_000);

  it('control: without the variable the spec IS loaded, and with axe unresolvable that crashes the listing', () => {
    expect(() => listTests({ GOLDEN_SKIP_A11Y: '' })).toThrow(/TRAP: Cannot find module '@axe-core\/playwright'/);
  }, 90_000);

  it('the marker decides: a marked spec in a copied suite is not listed, an unmarked one is, and neither is loaded when ignored', () => {
    const dir = mkdtempSync(path.join(path.resolve(__dirname, '../../..'), '.golden-marker-')); // inside the repo so @playwright/test resolves
    const spec = (title: string, marker: boolean) =>
      `${marker ? '// golden:dev-only\n' : ''}import { test } from '@playwright/test';\ntest('${title}', () => {});\n`;
    writeFileSync(path.join(dir, 'zz-marked.spec.ts'), spec('marked', true));
    writeFileSync(path.join(dir, 'zz-plain.spec.ts'), spec('plain', false));
    const cfg = path.join(dir, 'cfg.ts');
    writeFileSync(cfg, `import { defineConfig } from '@playwright/test';\nimport { devOnlySpecPattern } from ${JSON.stringify(path.join(GOLDEN_DIR, 'helpers/devOnlySpecs.ts'))};\n` +
      `export default defineConfig({ testDir: ${JSON.stringify(dir)}, testIgnore: devOnlySpecPattern(${JSON.stringify(dir)}) });\n`);
    let out: string;
    try {
      out = execFileSync('npx', ['playwright', 'test', '--list', '--config', cfg], { encoding: 'utf8', timeout: 60_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(out).toContain('zz-plain.spec.ts');
    expect(out).not.toContain('zz-marked.spec.ts');
  }, 90_000);
});
