// The run's time limits: a whole-run watchdog that ends the process (dropping the deploy locks with it) and a bound on every request to the app.
import { createServer, type Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../../../scripts/ci/golden-hosted/seed-demo-app';
import { startWatchdog } from '../../../scripts/deploy/verifyCompany/watchdog';
import { REQUEST_TIMEOUT_MS, RUN_WATCHDOG_MS } from '../../../scripts/deploy/verifyCompany/identity';
import { acquireDeployLocks } from '../../../scripts/deploy/verifyCompany/deployLock';

let server: Server | null = null;
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the limits', () => {
  it('are 20 minutes for the whole run and 60 seconds per request', () => {
    expect(RUN_WATCHDOG_MS).toBe(20 * 60_000);
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
  });
});

describe('startWatchdog', () => {
  it('fires after its time, and not when cancelled', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const cancel = startWatchdog(1000, fired);
    vi.advanceTimersByTime(999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
    const fired2 = vi.fn();
    startWatchdog(1000, fired2)();
    vi.advanceTimersByTime(5000);
    expect(fired2).not.toHaveBeenCalled();
  });

  it('a real hung run exits non-zero, says why on stderr, and the deploy locks it held are free afterwards', async () => {
    const d = mkdtempSync(join(tmpdir(), 'verify-wd-'));
    dirs.push(d);
    const lock = join(d, 'l.lock');
    const mod = (f: string) => JSON.stringify(join(process.cwd(), 'scripts/deploy/verifyCompany', f));
    const script = `import { acquireDeployLocks } from ${mod('deployLock.ts')}; import { startWatchdog } from ${mod('watchdog.ts')};
      await acquireDeployLocks([${JSON.stringify(lock)}]); startWatchdog(700); process.stdout.write('held\\n'); setInterval(() => {}, 1000);`;
    const child = spawn('bun', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    await new Promise<void>((resolve) => child.stdout.on('data', (c: Buffer) => { if (c.toString().includes('held')) resolve(); }));
    expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(1); // held while it runs
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code).toBe(3);
    expect(err).toMatch(/still running after .*giving up.*locks drop/);
    await new Promise((r) => setTimeout(r, 300));
    expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(0);
  }, 30_000);
});

describe('Client request bound', () => {
  async function hung(): Promise<string> {
    server = createServer(() => { /* never answers */ });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('a request to an app that never answers is cut off at the bound (login and calls alike)', async () => {
    const base = await hung();
    const c = new Client(base, 150);
    const t0 = Date.now();
    await expect(c.login('e', 'p')).rejects.toThrow(/timed out|abort/i);
    await expect(c.get('/api/x')).rejects.toThrow(/timed out|abort/i);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('without a bound (the hosted CI default) nothing is aborted: a slow answer is waited for', async () => {
    server = createServer((_q, res) => { setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, data: { ok: 1 } })); }, 300); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await expect(new Client(base).get('/api/x')).resolves.toEqual({ ok: 1 });
  });
});

describe('the lock refusal', () => {
  it('names the lock file and how to find the holder', async () => {
    const d = mkdtempSync(join(tmpdir(), 'verify-wd-'));
    dirs.push(d);
    const lock = join(d, 'held.lock');
    const holder = spawn('flock', ['-n', lock, 'sleep', '30']);
    try {
      await new Promise((r) => setTimeout(r, 300));
      await expect(acquireDeployLocks([lock])).rejects.toThrow(new RegExp(`holds ${lock.replace(/[.\\/]/g, '\\$&')}.*lsof ${lock.replace(/[.\\/]/g, '\\$&')}.*fuser -v`, 's'));
    } finally {
      holder.kill();
    }
  });
});
