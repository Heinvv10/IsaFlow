/**
 * INSTALLING THE HOOKS NEVER BREAKS A PUSH THAT IS RUNNING ONE.
 *
 * `scripts/ci/install-hooks.sh` runs on every `bun install` (`prepare`) in any worktree, and every worktree shares
 * `.git/hooks`. bash reads a script as it runs it: a hook rewritten in place under a pre-push still in its `bun run ci`
 * read the new file from the old offset and failed ("syntax error near unexpected token"), refusing a push whose CI
 * had passed. The installer renames a new file over the old one, so the running hook keeps its own (the old inode).
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const INSTALLER = path.join(process.cwd(), 'scripts', 'ci', 'install-hooks.sh');
let root = '';
afterEach(() => { if (root !== '') rmSync(root, { recursive: true, force: true }); });

/** A scratch repository with the installer and a pre-push hook source; git's own variables cleared (a hook sets them). */
function repo(): { dir: string; env: NodeJS.ProcessEnv; source: string; hook: string } {
  root = mkdtempSync(path.join(tmpdir(), 'install-hooks-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  execFileSync('git', ['init', '-q', root], { env });
  mkdirSync(path.join(root, 'scripts', 'ci', 'hooks'), { recursive: true });
  copyFileSync(INSTALLER, path.join(root, 'scripts', 'ci', 'install-hooks.sh'));
  return { dir: root, env, source: path.join(root, 'scripts', 'ci', 'hooks', 'pre-push'), hook: path.join(root, '.git', 'hooks', 'pre-push') };
}

const install = (dir: string, env: NodeJS.ProcessEnv): void => { execFileSync('bash', ['scripts/ci/install-hooks.sh'], { cwd: dir, env, stdio: 'ignore' }); };
/** No temporary file is left in `hooks`. */
const noTmp = (hooks: string): void => { expect(readdirSync(hooks).filter((f) => f.includes('.tmp.'))).toEqual([]); };

it('a hook still running when the hooks are reinstalled runs to its end as it was, and the new one takes a new file', async () => {
  const { dir, env, source, hook } = repo();
  // The first version sleeps, then prints: the second has different lines at the offset bash will read next.
  writeFileSync(source, '#!/usr/bin/env bash\nsleep 1\necho "first version ran to its end"\n');
  install(dir, env);
  const before = statSync(hook).ino;
  const running = spawn('bash', [hook], { cwd: dir, env });
  let out = '';
  let err = '';
  running.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  running.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  const done = new Promise<number>((resolve) => { running.on('close', (code) => resolve(code ?? -1)); });
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  writeFileSync(source, '#!/usr/bin/env bash\n# a second version, longer: ( ) and other lines a half-read script chokes on\necho "second version"\nexit 3\n');
  install(dir, env);
  expect(await done).toBe(0);
  expect(err).toBe('');
  expect(out).toBe('first version ran to its end\n');
  expect(statSync(hook).ino).not.toBe(before);
  expect(readFileSync(hook, 'utf8')).toContain('second version');
  expect(statSync(hook).mode & 0o111).not.toBe(0);
  noTmp(path.dirname(hook));
}, 30_000);

it('installs into a missing hooks directory, leaving no temporary file', () => {
  const { dir, env, source, hook } = repo();
  rmSync(path.dirname(hook), { recursive: true, force: true });
  writeFileSync(source, '#!/usr/bin/env bash\necho one\n');
  install(dir, env);
  expect(readFileSync(hook, 'utf8')).toContain('echo one');
  noTmp(path.dirname(hook));
});

it('installs through a symlinked hooks directory, and replaces a symlinked hook with a regular copy', () => {
  const { dir, env, source, hook } = repo();
  const elsewhere = path.join(dir, 'elsewhere-hooks');
  mkdirSync(elsewhere);
  rmSync(path.dirname(hook), { recursive: true, force: true });
  symlinkSync(elsewhere, path.dirname(hook));
  const target = path.join(dir, 'kept-target');
  writeFileSync(target, '#!/usr/bin/env bash\necho target\n');
  symlinkSync(target, path.join(elsewhere, 'pre-push'));
  writeFileSync(source, '#!/usr/bin/env bash\necho two\n');
  install(dir, env);
  expect(lstatSync(path.join(elsewhere, 'pre-push')).isSymbolicLink()).toBe(false);
  expect(readFileSync(path.join(elsewhere, 'pre-push'), 'utf8')).toContain('echo two');
  expect(readFileSync(target, 'utf8')).toContain('echo target');
  noTmp(elsewhere);
});

it('from a linked worktree, installs into the common hooks directory', () => {
  const { dir, env, source, hook } = repo();
  writeFileSync(source, '#!/usr/bin/env bash\necho three\n');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir, env });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'hooks'], { cwd: dir, env });
  const linked = path.join(dir, '..', `${path.basename(dir)}-linked`);
  execFileSync('git', ['worktree', 'add', '-q', linked], { cwd: dir, env });
  try {
    install(linked, env);
    expect(readFileSync(hook, 'utf8')).toContain('echo three');
    noTmp(path.dirname(hook));
  } finally {
    rmSync(linked, { recursive: true, force: true });
  }
});

it('two installs that back up a changed hook never write the same backup', () => {
  const { dir, env, source, hook } = repo();
  writeFileSync(source, '#!/usr/bin/env bash\necho a\n');
  install(dir, env);
  writeFileSync(hook, '#!/usr/bin/env bash\necho local edit 1\n');
  install(dir, env);
  writeFileSync(hook, '#!/usr/bin/env bash\necho local edit 2\n');
  install(dir, env);
  const backups = readdirSync(path.dirname(hook)).filter((f) => f.startsWith('pre-push.bak.'));
  expect(backups).toHaveLength(2);
  expect(backups.every((b) => /^pre-push\.bak\.\d+\.\d+$/.test(b))).toBe(true);
});

it('a copy that fails leaves no temporary file', () => {
  const { dir, env, source, hook } = repo();
  writeFileSync(source, '#!/usr/bin/env bash\necho x\n');
  install(dir, env);
  // A chmod that fails, after the copy and before the rename.
  const bin = path.join(dir, 'failing-bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'chmod'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(source, '#!/usr/bin/env bash\necho y\n');
  expect(() => install(dir, { ...env, PATH: `${bin}:${env.PATH ?? ''}` })).toThrow();
  noTmp(path.dirname(hook));
  expect(readFileSync(hook, 'utf8')).toContain('echo x');
});
