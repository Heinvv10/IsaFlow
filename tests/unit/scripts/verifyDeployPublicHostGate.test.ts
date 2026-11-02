/**
 * verify-deploy.sh step 1b: the colour is asked as the public hosts ask (Host + X-Forwarded-Proto).
 * On 2026-11-02 Next 15 sent logged-out users to https://localhost:<PORT> and 500'd every logged-in
 * admin page, while the gate (which talks to localhost) stayed green. Each case runs the real script
 * against a stub colour; the stub `bun` makes the golden step a no-op and integrity is skipped.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

type Colour = (req: IncomingMessage, res: ServerResponse) => void;

/** A colour that behaves; `override` replaces its answer for one kind of request. */
const healthy = (override?: { loggedOut?: string; adminWithCookie?: number }): Colour => (req, res) => {
  if (req.url === '/api/health') res.statusCode = 200;
  else if (!req.headers.cookie) { res.statusCode = 307; res.setHeader('Location', override?.loggedOut ?? '/login'); }
  else res.statusCode = override?.adminWithCookie ?? 200;
  res.end('ok');
};

async function runGate(colour: Colour): Promise<{ code: number | null; out: string }> {
  server = createServer(colour);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const bun = path.join(mkdtempSync(path.join(tmpdir(), 'verify-host-')), 'bun');
  writeFileSync(bun, '#!/bin/bash\nexit 0\n');
  chmodSync(bun, 0o755);
  const env = { ...process.env, BUN: bun, VERIFY_SKIP_INTEGRITY: '1', E2E_ADMIN_EMAIL: 'e@x', E2E_ADMIN_PASSWORD: 'p' };
  const child = spawn('bash', ['scripts/verify-deploy.sh', `http://127.0.0.1:${port}`], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise<number | null>((r) => child.on('close', r));
  return { code, out };
}

describe('verify-deploy.sh public-host routing gate', () => {
  it('passes a colour whose redirects stay on the host and whose admin rewrite answers 200', async () => {
    const { out } = await runGate(healthy());
    expect(out).toContain('OK: public-host redirects and the admin rewrite stay on their host');
  }, 60_000);

  it('fails a colour that redirects logged-out users to localhost', async () => {
    const { code, out } = await runGate(healthy({ loggedOut: 'https://localhost:3112/login?returnTo=%2F' }));
    expect(code).not.toBe(0);
    expect(out).toContain("redirects to 'https://localhost:3112/login");
  }, 60_000);

  it('fails a colour whose admin rewrite 500s for a logged-in user', async () => {
    const { code, out } = await runGate(healthy({ adminWithCookie: 500 }));
    expect(code).not.toBe(0);
    expect(out).toContain('with a session cookie answered 500');
  }, 60_000);
});
