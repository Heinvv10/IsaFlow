/**
 * scripts/ci/golden-free-port.ts: the golden-paths job must never start
 * `next dev` on a port another server already holds, or that server answers
 * the health check and the login (#939, 2026-10-29).
 */
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BAD_PORTS, canBind, pickFreePort } from '../../../scripts/ci/golden-free-port';

const held: Server[] = [];
afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function hold(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      held.push(srv);
      resolve((srv.address() as { port: number }).port);
    });
  });
}

describe('canBind', () => {
  it('a port held on 127.0.0.1 only (as docker-proxy holds 3310) is taken', async () => {
    const port = await hold('127.0.0.1');
    expect(await canBind(port)).toBe(false);
  });

  it('a port held on ::1 only is taken too: the probe binds dual-stack ::, as next dev -p does', async () => {
    const port = await hold('::1');
    expect(await canBind(port)).toBe(false);
  });

  it('a port nothing holds is free, and canBind releases it', async () => {
    const port = await hold('127.0.0.1');
    await new Promise((r) => held.pop()!.close(r));
    expect(await canBind(port)).toBe(true);
    expect(await canBind(port)).toBe(true);
  });
});

describe('pickFreePort', () => {
  it('skips a taken port and returns the free one', async () => {
    const seq = [0, 0.99];
    const port = await pickFreePort(3300, 3301, async (p) => p === 3301, () => seq.shift() ?? 0.99);
    expect(port).toBe(3301);
  });

  it('never returns a bad port, even when it is free', async () => {
    const [bad] = [...BAD_PORTS];
    expect(await pickFreePort(bad!, bad!, async () => true)).toBeNull();
  });

  it('returns null when every port in the range is taken', async () => {
    const port = await hold('127.0.0.1');
    expect(await pickFreePort(port, port)).toBeNull();
  });
});

describe('CLI', () => {
  const run = (...args: string[]) =>
    spawnSync('bun', ['scripts/ci/golden-free-port.ts', ...args], { encoding: 'utf8' });

  it('prints only a port in the range, exit 0', () => {
    const r = run('3300', '3799');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\d+\n$/);
    const port = Number(r.stdout);
    expect(port).toBeGreaterThanOrEqual(3300);
    expect(port).toBeLessThanOrEqual(3799);
  });

  it('exit 1 and no stdout when the only port is taken', async () => {
    const port = await hold('127.0.0.1');
    const r = run(String(port), String(port));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it.each([[[]], [['3300']], [['', '3799']], [['0', '10']], [['3300', '70000']], [['3799', '3300']], [['33a0', '3799']]])(
    'exit 2 on bad arguments %j',
    (args) => {
      const r = run(...(args as string[]));
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
    },
  );
});
