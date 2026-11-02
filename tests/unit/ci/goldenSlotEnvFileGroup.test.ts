// A provisioner run by a user outside the env file's group cannot chown a replacement to that group. It must then
// overwrite the file in place (same inode, so same group and mode) rather than rename a file the runners cannot read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, chownSync: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); } };
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('writeEnvFileAtomic without the right to chown', () => {
  it('writes in place: same inode, no temp file left', async () => {
    const { writeEnvFileAtomic } = await import('../../../scripts/ci/golden/slotEnvFile');
    const dir = mkdtempSync(join(tmpdir(), 'golden-env-group-'));
    dirs.push(dir);
    const real = join(dir, 'main.env.local');
    writeFileSync(real, 'A=1\n');
    const inode = statSync(real).ino;
    writeEnvFileAtomic(real, 'A=1\nB=2\n');
    expect(readFileSync(real, 'utf8')).toBe('A=1\nB=2\n');
    expect(statSync(real).ino).toBe(inode);
    expect(readdirSync(dir)).toEqual(['main.env.local']);
  });
});
