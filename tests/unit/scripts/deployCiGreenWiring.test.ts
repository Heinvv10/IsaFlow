/**
 * deploy.sh section 1a: the REAL lines of the CI gate run under bash, in a
 * throwaway git repo, with $BUN replaced by a stub that logs its arguments and
 * exits (and prints a `verified HEAD` line) as each case asks. Running
 * deploy.sh itself would deploy production. `bun run ci` is skipped only when
 * deployCiGreen.ts exits 10 AND its one verified SHA is still HEAD, the tree
 * is clean, and GIT_SHA names it. Anything else runs it; a failing
 * `bun run ci` still aborts, and SKIP_CI=1 is unchanged.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const lines = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith('# 1a. CI gate'));
const end = lines.findIndex((l) => l === 'echo "Building production bundle..."');
const GATE = lines.slice(start, end).join('\n');

const dir = mkdtempSync(join(tmpdir(), 'deploy-ci-gate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const stub = join(dir, 'bun');
writeFileSync(stub, [
  '#!/bin/bash',
  'echo "$*" >> "$CALLS"',
  'case "$1" in',
  '  */scripts/lib/deployCiGreen.ts) printf "%b" "$GREEN_OUT"; exit "$GREEN_RC" ;;',
  '  run) exit "$CI_RC" ;;',
  'esac',
  'exit 99',
].join('\n'));
chmodSync(stub, 0o755);

// Inside a git hook (pre-push runs the unit tests) git exports GIT_DIR and friends. Inherited, they point
// this throwaway repo's init, config and commit at the REAL repository. Every git child here runs without them.
const NO_GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const repo = join(dir, 'repo');
const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: NO_GIT_ENV });
spawnSync('git', ['init', '-q', repo], { env: NO_GIT_ENV });
git('config', 'status.showUntrackedFiles', 'no'); // as in the real repo: the gate must still see untracked files
writeFileSync(join(repo, 'a.txt'), 'a\n');
git('add', 'a.txt');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
const HEAD = git('rev-parse', 'HEAD').stdout.trim();
if (!/^[0-9a-f]{40}$/.test(HEAD) || git('log', '--format=%s').stdout.trim() !== 'one') throw new Error('throwaway repo setup failed');
const SHORT = HEAD.slice(0, 10);
const verified = (sha: string) => `[deploy-ci] evidence\\n[deploy-ci] verified HEAD ${sha}\\n`;

let n = 0;
function gate(env: Record<string, string>) {
  const calls = join(dir, `calls-${++n}`);
  writeFileSync(calls, '');
  const r = spawnSync('bash', ['-c', `set -e\nBUN=${JSON.stringify(stub)}\nREPO_DIR=/repo\n${GATE}\necho GATE_PASSED`], {
    cwd: repo, encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: dir, CALLS: calls, GIT_SHA: SHORT, GREEN_RC: '0', GREEN_OUT: '', CI_RC: '0', ...env },
  });
  return { status: r.status, out: r.stdout, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}
const CHECK = '/repo/scripts/lib/deployCiGreen.ts';

describe('deploy.sh CI gate wiring', () => {
  it('finds the section', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(GATE).toContain('$BUN run ci');
  });

  it('skips bun run ci on exit 10 with the verified SHA still HEAD, clean, and named by GIT_SHA', () => {
    const r = gate({ GREEN_RC: '10', GREEN_OUT: verified(HEAD) });
    expect(r.calls).toEqual([CHECK]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`verified HEAD ${HEAD}`); // the check's own output still reaches deploy.log
    expect(r.out).toContain(`GitHub already passed every required check on ${HEAD} (HEAD, release ${SHORT}); local bun run ci skipped`);
    expect(r.out).toContain('GATE_PASSED');
  });

  it.each([
    ['no verified line', { GREEN_OUT: '[deploy-ci] something\\n' }],
    ['a verified SHA that is not HEAD', { GREEN_OUT: verified('c'.repeat(40)) }],
    ['a short verified SHA', { GREEN_OUT: verified(SHORT) }],
    ['two verified lines', { GREEN_OUT: verified(HEAD) + verified(HEAD) }],
    ['GIT_SHA naming another commit', { GREEN_OUT: verified(HEAD), GIT_SHA: 'deadbee' }],
    ['GIT_SHA empty', { GREEN_OUT: verified(HEAD), GIT_SHA: '' }],
  ])('runs bun run ci on exit 10 with %s', (_label, env) => {
    const r = gate({ GREEN_RC: '10', ...env });
    expect(r.calls).toEqual([CHECK, 'run ci']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Running CI gate (bun run ci)...');
  });

  it('runs bun run ci on exit 10 when the tree has changed since the check (untracked file)', () => {
    writeFileSync(join(repo, 'stray.txt'), 'x\n');
    try {
      const r = gate({ GREEN_RC: '10', GREEN_OUT: verified(HEAD) });
      expect(r.calls).toEqual([CHECK, 'run ci']);
    } finally {
      rmSync(join(repo, 'stray.txt'));
    }
  });

  it.each(['0', '1', '2', '11', '127', '139'])('runs bun run ci when the check exits %s, verified line or not', (rc) => {
    const r = gate({ GREEN_RC: rc, GREEN_OUT: verified(HEAD) });
    expect(r.calls).toEqual([CHECK, 'run ci']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Running CI gate (bun run ci)...');
  });

  it('still aborts the deploy when the full gate fails', () => {
    const r = gate({ GREEN_RC: '0', CI_RC: '1' });
    expect(r.calls).toEqual([CHECK, 'run ci']);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain('GATE_PASSED');
  });

  it('SKIP_CI=1 bypasses both, as before', () => {
    const r = gate({ SKIP_CI: '1', GREEN_RC: '10', GREEN_OUT: verified(HEAD) });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('WARNING: SKIP_CI=1');
  });
});
