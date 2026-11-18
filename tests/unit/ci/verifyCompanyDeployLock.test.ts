// The deploy locks a real provisioning run holds: taken with flock(1) like deploy.sh does, refused while another holder has them,
// dropped on release or when the holder dies. Temp lock files only: the real /tmp/isaflow-*.lock are never touched.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDeployLocks } from '../../../scripts/deploy/verifyCompany/deployLock';
import { DEPLOY_LOCK_FILES } from '../../../scripts/deploy/verifyCompany/identity';

const dirs: string[] = [];
function lockFiles(n = 2): string[] {
  const d = mkdtempSync(join(tmpdir(), 'verify-locks-'));
  dirs.push(d);
  return Array.from({ length: n }, (_, i) => join(d, `l${i}.lock`));
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Whether another process can take `file` right now: what deploy.sh's `flock -n 9` would see. */
const free = (file: string): boolean => spawnSync('flock', ['-n', file, 'true']).status === 0;

describe('acquireDeployLocks', () => {
  it('names the two locks deploy.sh and bluegreen.sh hold', () => {
    expect(DEPLOY_LOCK_FILES).toEqual(['/tmp/isaflow-deploy.lock', '/tmp/isaflow-colours.lock']);
  });

  it('holds every lock until released: a deploy\'s own flock -n is refused meanwhile, and succeeds after', async () => {
    const files = lockFiles();
    const held = await acquireDeployLocks(files);
    expect(files.map(free)).toEqual([false, false]);
    await held.release();
    expect(files.map(free)).toEqual([true, true]);
  });

  it('refuses while a deploy holds one, naming it, and leaves nothing held', async () => {
    const files = lockFiles();
    const deploy = spawn('flock', ['-n', files[1]!, 'sleep', '30']); // a deploy holding the second lock
    try {
      await new Promise((r) => setTimeout(r, 300));
      await expect(acquireDeployLocks(files)).rejects.toThrow(new RegExp(`holds ${files[1]!.replace(/[.\\/]/g, '\\$&')}`));
      expect(free(files[0]!)).toBe(true); // the first was taken, then given back
    } finally {
      deploy.kill();
    }
  });

  it('drops its locks when its holder goes away without releasing (a killed run)', async () => {
    const files = lockFiles(1);
    // A separate holder process that takes the lock through this module and is then killed.
    const script = `import { acquireDeployLocks } from ${JSON.stringify(join(process.cwd(), 'scripts/deploy/verifyCompany/deployLock.ts'))};
      await acquireDeployLocks(${JSON.stringify(files)}); process.stdout.write('held\\n'); setInterval(() => {}, 1000);`;
    const holder = spawn('bun', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', (d: Buffer) => { if (d.toString().includes('held')) resolve(); });
      holder.on('close', () => reject(new Error('holder exited early')));
    });
    expect(free(files[0]!)).toBe(false);
    holder.kill('SIGKILL');
    await new Promise((r) => holder.on('close', r));
    await new Promise((r) => setTimeout(r, 300));
    expect(free(files[0]!)).toBe(true);
  }, 30_000);
});
