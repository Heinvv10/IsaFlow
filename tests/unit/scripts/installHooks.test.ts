/**
 * INSTALLING THE HOOKS NEVER BREAKS A PUSH THAT IS RUNNING ONE.
 *
 * `scripts/ci/install-hooks.sh` runs on every `bun install` (`prepare`) in any worktree, and every worktree shares
 * `.git/hooks`. bash reads a script as it runs it: a hook rewritten in place under a pre-push still in its `bun run ci`
 * read the new file from the old offset and failed ("syntax error near unexpected token"), refusing a push whose CI
 * had passed. The installer renames a new file over the old one, so the running hook keeps its own (the old inode).
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
}, 30_000);
