// The pre-step that stops a dev server an earlier timed-out job of this runner left in the runner's slot port window. It
// must stop that and nothing else: the window also holds other worktrees' dev servers and docker-proxy.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inWorkspace, parseListeners, selectOrphans } from '../../../scripts/ci/golden/killSlotOrphans';

const SS = [
  'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
  'LISTEN 0      511          0.0.0.0:3300      0.0.0.0:*     users:(("docker-proxy",pid=111,fd=4))',
  'LISTEN 0      511        127.0.0.1:3341      0.0.0.0:*     users:(("next-server (v1",pid=222,fd=19))',
  'LISTEN 0      511                *:3777            *:*     users:(("next-server (v1",pid=333,fd=19),("node",pid=334,fd=20))',
  'LISTEN 0      511             [::]:3300         [::]:*     users:(("docker-proxy",pid=112,fd=4))',
  'LISTEN 0      4096       127.0.0.1:5432      0.0.0.0:*',
].join('\n');

describe('parseListeners', () => {
  it('reads port and pid from ss -ltnp, every pid of a line, v4 and v6, and skips a line with no pid', () => {
    expect(parseListeners(SS)).toEqual([
      { pid: 111, port: 3300 }, { pid: 222, port: 3341 }, { pid: 333, port: 3777 }, { pid: 334, port: 3777 }, { pid: 112, port: 3300 },
    ]);
  });
});

describe('inWorkspace', () => {
  it('is true for the workspace and what is inside it, not for a sibling that shares its prefix', () => {
    expect(inWorkspace('/w/IsaFlow/IsaFlow', '/w/IsaFlow/IsaFlow')).toBe(true);
    expect(inWorkspace('/w/IsaFlow/IsaFlow/node_modules/.bin', '/w/IsaFlow/IsaFlow')).toBe(true);
    expect(inWorkspace('/w/IsaFlow/IsaFlow2', '/w/IsaFlow/IsaFlow')).toBe(false);
    expect(inWorkspace('/home/hein/Workspace/IsaFlow', '/w/IsaFlow/IsaFlow')).toBe(false);
    expect(inWorkspace(null, '/w/IsaFlow/IsaFlow')).toBe(false);
    expect(inWorkspace('/anything', '')).toBe(false);
  });
});

describe('selectOrphans', () => {
  const cwds: Record<number, string | null> = { 111: '/', 222: '/w/IsaFlow/IsaFlow', 333: '/w/IsaFlow/IsaFlow', 334: null, 112: '/other' };
  const cwdOf = (pid: number) => cwds[pid] ?? null;
  const all = parseListeners(SS);

  it('picks only listeners in the window whose cwd is in the workspace', () => {
    expect(selectOrphans(all, 3300, 3465, '/w/IsaFlow/IsaFlow', cwdOf, new Set())).toEqual([222]);
    expect(selectOrphans(all, 3300, 3799, '/w/IsaFlow/IsaFlow', cwdOf, new Set())).toEqual([222, 333]);
  });

  it('leaves docker-proxy and other worktrees alone, even inside the window', () => {
    expect(selectOrphans(all, 3300, 3300, '/w/IsaFlow/IsaFlow', cwdOf, new Set())).toEqual([]);
  });

  it('never picks a protected pid (this process and its ancestors) nor a process whose cwd cannot be read', () => {
    expect(selectOrphans(all, 3300, 3799, '/w/IsaFlow/IsaFlow', cwdOf, new Set([333]))).toEqual([222]);
    expect(selectOrphans(all, 3777, 3777, '/w/IsaFlow/IsaFlow', cwdOf, new Set())).toEqual([333]);
  });
});

describe('the script, against real listeners', () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
  const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), 'golden-orphan-')); dirs.push(d); return d; };
  const listenerIn = async (cwd: string, port: number): Promise<ChildProcess> => {
    const c = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1', () => process.stdout.write('up\\n'))`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(c);
    await new Promise<void>((resolve, reject) => { c.stdout!.once('data', () => resolve()); c.once('exit', () => reject(new Error('listener exited'))); });
    return c;
  };
  const run = (first: number, last: number, workspace: string) =>
    spawnSync('bun', ['scripts/ci/golden/killSlotOrphans.ts', String(first), String(last)], { cwd: join(__dirname, '../../..'), env: { ...process.env, GITHUB_WORKSPACE: workspace }, encoding: 'utf8', timeout: 60_000 });
  const gone = async (c: ChildProcess): Promise<boolean> => { for (let i = 0; i < 50 && c.exitCode === null && c.signalCode === null; i++) await new Promise((r) => setTimeout(r, 100)); return c.exitCode !== null || c.signalCode !== null; };

  it('stops a listener of the workspace in the window, and leaves a foreign one and one outside the window running', async () => {
    const workspace = scratch();
    const elsewhere = scratch();
    // Ascending, so the window [inside, foreign] holds those two and never the third.
    const [inside, foreign, outside] = [await freePort(), await freePort(), await freePort()].sort((a, b) => a - b);
    const orphan = await listenerIn(workspace, inside!);
    const peer = await listenerIn(elsewhere, foreign!);
    const outsider = await listenerIn(workspace, outside!);
    const res = run(inside!, foreign!, workspace);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`stopping pid ${orphan.pid}`);
    expect(await gone(orphan)).toBe(true);
    expect(peer.exitCode === null && peer.signalCode === null).toBe(true);
    expect(outsider.exitCode === null && outsider.signalCode === null).toBe(true);
  }, 90_000);

  it('does nothing, and exits 0, without GITHUB_WORKSPACE', async () => {
    const port = await freePort();
    const c = await listenerIn(scratch(), port);
    const res = run(port, port, '');
    expect(res.status).toBe(0);
    expect(c.exitCode === null && c.signalCode === null).toBe(true);
  }, 90_000);
});
