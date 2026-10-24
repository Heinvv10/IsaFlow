/**
 * scripts/verify-deploy.sh runs the golden suite against PRODUCTION after a deploy, and a red run rolls the code
 * back. The a11y gate's baseline is recorded on dev data, so that run must be report-only. This runs the real
 * script against a stub health endpoint and a stub `bun`, and reads what the golden step was given.
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

async function runVerifyDeploy(inheritedGate?: string): Promise<{ code: number | null; gateSeenByGolden: string | null; out: string }> {
  server = createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const dir = mkdtempSync(path.join(tmpdir(), 'verify-deploy-'));
  const seen = path.join(dir, 'gate.txt');
  const bun = path.join(dir, 'bun');
  writeFileSync(bun, `#!/bin/bash\nif [[ "$*" == *test:e2e:golden* ]]; then printf '%s' "\${A11Y_GATE-<unset>}" > "${seen}"; fi\nexit 0\n`);
  chmodSync(bun, 0o755);

  const env = { ...process.env, BUN: bun, VERIFY_SKIP_INTEGRITY: '1', E2E_ADMIN_EMAIL: 'e@x', E2E_ADMIN_PASSWORD: 'p' } as Record<string, string | undefined>;
  delete env.A11Y_GATE;
  if (inheritedGate !== undefined) env.A11Y_GATE = inheritedGate;
  const child = spawn('bash', ['scripts/verify-deploy.sh', `http://127.0.0.1:${port}`], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise<number | null>((r) => child.on('close', r));
  let gateSeenByGolden: string | null = null;
  try { gateSeenByGolden = readFileSync(seen, 'utf8'); } catch { gateSeenByGolden = null; }
  return { code, gateSeenByGolden, out };
}

describe('verify-deploy.sh and the a11y gate', () => {
  it('runs the golden suite with A11Y_GATE=report', async () => {
    const r = await runVerifyDeploy();
    expect(r.out).toContain('OK: golden paths green');
    expect(r.code).toBe(0);
    expect(r.gateSeenByGolden).toBe('report');
  }, 30_000);

  it('report wins over a stricter value inherited from the caller', async () => {
    const r = await runVerifyDeploy('enforce');
    expect(r.gateSeenByGolden).toBe('report');
  }, 30_000);
});
