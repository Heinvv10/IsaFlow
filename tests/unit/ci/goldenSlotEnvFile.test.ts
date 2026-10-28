// The shared CI env file is replaced by rename, so a runner copying it never sees half a file; the symlink it is
// reached through, and its mode, survive.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEnvFileAtomic } from '../../../scripts/ci/golden/slotEnvFile';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'golden-env-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('writeEnvFileAtomic', () => {
  it('writes through a symlink without replacing it, keeps the mode and leaves no temp file', () => {
    const dir = scratch();
    const real = join(dir, 'main.env.local');
    const link = join(dir, 'isaflow-ci.env');
    writeFileSync(real, 'A=1\n');
    chmodSync(real, 0o640);
    symlinkSync(real, link);
    writeEnvFileAtomic(link, 'A=1\nB=2\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(real);
    expect(readFileSync(real, 'utf8')).toBe('A=1\nB=2\n');
    expect(statSync(real).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir).sort()).toEqual(['isaflow-ci.env', 'main.env.local']);
  });

  it('fails on a path that does not exist instead of creating a file nobody reads', () => {
    expect(() => writeEnvFileAtomic(join(scratch(), 'missing.env'), 'A=1\n')).toThrow();
  });
});
