/**
 * The diff-scoped steps of the pre-push gate (`bun run ci prepush`, scripts/ci/run-ci.sh).
 * The full gate runs on GitHub; this only runs the part of lint and the unit tests that a push can
 * have changed, against the merge base with origin/master.
 *   bun scripts/ci/prepush.ts lint   eslint on the changed files under src/ and pages/
 *   bun scripts/ci/prepush.ts unit   vitest on the unit files whose import graph holds a changed file
 * No merge base (a shallow clone, no origin/master) runs the whole of the step: slower, never weaker.
 */
import { spawnSync } from 'node:child_process';

const LINTED = /^(src|pages)\/.*\.(ts|tsx|js|jsx|mjs)$/;

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** Merge base of HEAD and origin/master, or null when there is none. */
export function mergeBase(): string | null {
  const r = git(['merge-base', 'HEAD', 'origin/master']);
  return r.ok && r.out !== '' ? r.out : null;
}

/** Files changed since `base`, committed or not, deletions excluded. */
export function changedFiles(base: string): string[] {
  const committed = git(['diff', '--name-only', '--diff-filter=d', `${base}...HEAD`]);
  const working = git(['diff', '--name-only', '--diff-filter=d', 'HEAD']);
  if (!committed.ok || !working.ok) throw new Error('git diff failed');
  return [...new Set([...committed.out.split('\n'), ...working.out.split('\n')].filter(Boolean))];
}

function exec(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } });
  return r.status ?? 1;
}

function lint(base: string | null): number {
  if (base === null) {
    process.stdout.write('[prepush] no merge base with origin/master: linting everything\n');
    return exec('bun', ['run', 'lint']);
  }
  const files = changedFiles(base).filter((f) => LINTED.test(f));
  if (files.length === 0) {
    process.stdout.write('[prepush] lint: no changed file under src/ or pages/\n');
    return 0;
  }
  process.stdout.write(`[prepush] lint: ${files.length} changed file(s)\n`);
  return exec('bunx', ['eslint', '--report-unused-disable-directives', '--no-error-on-unmatched-pattern', ...files]);
}

function unit(base: string | null): number {
  if (base === null) {
    process.stdout.write('[prepush] no merge base with origin/master: running every unit test\n');
    return exec('bun', ['run', 'test:unit']);
  }
  process.stdout.write(`[prepush] unit tests affected by the diff against ${base.slice(0, 10)}\n`);
  return exec('bunx', ['vitest', 'run', '--changed', base, '--passWithNoTests']);
}

const step = process.argv[2];
if (process.argv[1]?.endsWith('prepush.ts')) {
  if (step !== 'lint' && step !== 'unit') {
    process.stderr.write('usage: prepush.ts lint|unit\n');
    process.exit(2);
  }
  process.exit((step === 'lint' ? lint : unit)(mergeBase()));
}
