/**
 * scripts/lib/deployCiGreen.ts: deploy.sh skips its local `bun run ci` only
 * when GitHub shows every required check completed/success on the exact,
 * clean HEAD on origin/master. Every case below that is not the happy path
 * must run the full gate (exit 0, never SKIP_EXIT).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { REQUIRED_JOBS } from '../../../scripts/ci/mq-merge-already-tested';
import { decide, fetchPages, main, MAX_PAGES, REPO, SKIP_EXIT, type Cmd } from '../../../scripts/lib/deployCiGreen';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

type Run = { id: number; name: string; head_sha: string; status: string; conclusion: string | null; app: { slug: string } | null };
const ok = (name: string, id: number, over: Partial<Run> = {}): Run => ({
  id, name, head_sha: SHA, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, ...over,
});
// Shaped like master's real list: the two required checks among the matrix parts.
const GREEN: Run[] = [
  ok('Type Check, Lint & Test', 1), ok('Golden Paths E2E (blocking)', 2), ok('Golden chunk 1 of 6', 3),
  ok('Static gates, part 1/3', 4), ok('Browser & integration, part 2/5', 5), ok('CI route', 6),
];
const page = (runs: unknown[], total = runs.length) => ({ total_count: total, check_runs: runs });
const withRequired = (name: string, over: Partial<Run>) => GREEN.map((r) => (r.name === name ? { ...r, ...over } : r));

describe('decide', () => {
  it('skips when every required check is completed/success on the SHA', () => {
    const v = decide(SHA, [page(GREEN)]);
    expect(v.skip).toBe(true);
    expect(v.reason).toContain(SHA);
    expect(v.evidence).toEqual([
      `"Type Check, Lint & Test": completed/success sha=${SHA} app=github-actions id=1`,
      `"Golden Paths E2E (blocking)": completed/success sha=${SHA} app=github-actions id=2`,
    ]);
  });

  it('skips across pages when the pages add up to total_count', () => {
    expect(decide(SHA, [page(GREEN.slice(0, 3), 6), page(GREEN.slice(3), 6)]).skip).toBe(true);
  });

  it.each([
    ['failure', { conclusion: 'failure' }, /concluded failure/],
    ['cancelled', { conclusion: 'cancelled' }, /concluded cancelled/],
    ['skipped', { conclusion: 'skipped' }, /concluded skipped/],
    ['neutral', { conclusion: 'neutral' }, /concluded neutral/],
    ['queued', { status: 'queued', conclusion: null }, /is queued, not completed/],
    ['in progress', { status: 'in_progress', conclusion: null }, /is in_progress, not completed/],
    ['pending', { status: 'pending', conclusion: null }, /is pending, not completed/],
    ['completed with no conclusion', { conclusion: null }, /concluded null/],
    ['for another SHA', { head_sha: OTHER }, new RegExp(`is for ${OTHER}`)],
    ['from another app', { app: { slug: 'some-bot' } }, /from app some-bot/],
    ['from no app', { app: null }, /from app undefined/],
  ])('runs CI when a required check is %s', (_label, over, why) => {
    for (const name of REQUIRED_JOBS) {
      const v = decide(SHA, [page(withRequired(name, over as Partial<Run>))]);
      expect(v.skip).toBe(false);
      expect(v.reason).toMatch(why);
      expect(v.reason).toContain(name);
    }
  });

  it('runs CI when a required check is missing', () => {
    for (const name of REQUIRED_JOBS) {
      const v = decide(SHA, [page(GREEN.filter((r) => r.name !== name))]);
      expect(v.skip).toBe(false);
      expect(v.reason).toBe(`"${name}" has no check run on ${SHA}`);
    }
  });

  it('runs CI when any run of a required name is not green, even beside a green one', () => {
    const v = decide(SHA, [page([...GREEN, ok('Golden Paths E2E (blocking)', 9, { conclusion: 'failure' })])]);
    expect(v.skip).toBe(false);
    expect(v.reason).toMatch(/"Golden Paths E2E \(blocking\)" concluded failure/);
  });

  it('matches names exactly (commas, ampersands, parentheses), never by prefix or case', () => {
    const lookalikes = GREEN.map((r) => (r.name === 'Type Check, Lint & Test' ? { ...r, name: 'Type Check, Lint &amp; Test' } : r));
    expect(decide(SHA, [page(lookalikes)]).skip).toBe(false);
    const cased = GREEN.map((r) => (r.name === 'Golden Paths E2E (blocking)' ? { ...r, name: 'golden paths e2e (blocking)' } : r));
    expect(decide(SHA, [page(cased)]).skip).toBe(false);
  });

  it('runs CI when every check run is for the wrong SHA', () => {
    expect(decide(SHA, [page(GREEN.map((r) => ({ ...r, head_sha: OTHER })))]).skip).toBe(false);
    expect(decide(OTHER, [page(GREEN)]).skip).toBe(false);
  });

  it.each([
    ['no pages', []],
    ['an empty object', [{}]],
    ['null', [null]],
    ['a string', ['garbage']],
    ['an array', [[]]],
    ['check_runs not an array', [{ total_count: 2, check_runs: 'x' }]],
    ['no total_count', [{ check_runs: GREEN }]],
    ['zero check runs', [page([])]],
    ['fewer runs than total_count', [page(GREEN, 7)]],
    ['total_count changing between pages', [page(GREEN.slice(0, 3), 6), page(GREEN.slice(3), 7)]],
    ['a garbage element among the runs', [page([null, 'x', 3, ...GREEN.filter((r) => r.id !== 1)])]],
  ])('runs CI on %s', (_label, pages) => {
    expect(decide(SHA, pages as unknown[]).skip).toBe(false);
  });

  it('runs CI on a SHA that is not a full SHA, and on an empty required list', () => {
    expect(decide('abc123', [page(GREEN)]).skip).toBe(false);
    expect(decide('', [page(GREEN)]).skip).toBe(false);
    expect(decide(SHA, [page(GREEN)], []).skip).toBe(false);
  });
});

describe('REQUIRED_JOBS', () => {
  it('names a job in .github/workflows/ci.yml, each', () => {
    const ci = load(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, { name?: string }> };
    const names = Object.values(ci.jobs).map((j) => j.name);
    expect(REQUIRED_JOBS.length).toBe(2);
    for (const n of REQUIRED_JOBS) expect(names).toContain(n);
  });
});

describe('fetchPages', () => {
  it('pages until total_count is read, one argv element per path', () => {
    const calls: string[][] = [];
    const gh: Cmd = (args) => {
      calls.push(args);
      const n = Number(/page=(\d+)$/.exec(args[args.length - 1]!)![1]);
      return JSON.stringify(page(n === 1 ? GREEN.slice(0, 4) : GREEN.slice(4), 6));
    };
    expect(fetchPages(SHA, gh)).toHaveLength(2);
    expect(calls.map((a) => a[a.length - 1])).toEqual([1, 2].map((n) =>
      `repos/${REPO}/commits/${SHA}/check-runs?filter=latest&per_page=100&page=${n}`));
  });

  it('stops at MAX_PAGES, which decide() then reads as incomplete', () => {
    const gh: Cmd = () => JSON.stringify(page([GREEN[0]], 10_000));
    const pages = fetchPages(SHA, gh);
    expect(pages).toHaveLength(MAX_PAGES);
    expect(decide(SHA, pages).skip).toBe(false);
  });
});

type GitState = { head: string; status: string; mainline: string[] };
const GOOD: GitState = { head: SHA, status: '', mainline: [OTHER, SHA, 'c'.repeat(40)] };
function fakeGit(over: Partial<GitState> = {}): Cmd {
  const s = { ...GOOD, ...over };
  return (args) => {
    if (args.join(' ') === 'rev-parse HEAD') return `${s.head}\n`;
    if (args.join(' ') === 'status --porcelain --untracked-files=normal') return s.status;
    if (args.join(' ') === 'rev-list --first-parent origin/master') return `${s.mainline.join('\n')}\n`;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}
const ghGreen: Cmd = () => JSON.stringify(page(GREEN));

function runMain(git: Cmd, gh: Cmd) {
  let out = '';
  const code = main({ git, gh }, (s) => { out += s; });
  return { code, out };
}

describe('main', () => {
  it('exits SKIP_EXIT and logs the SHA, names and conclusions when GitHub shows it green', () => {
    const r = runMain(fakeGit(), ghGreen);
    expect(r.code).toBe(SKIP_EXIT);
    expect(r.out).toContain(`[deploy-ci]   "Type Check, Lint & Test": completed/success sha=${SHA}`);
    expect(r.out).toContain(`[deploy-ci]   "Golden Paths E2E (blocking)": completed/success sha=${SHA}`);
    expect(r.out).toMatch(/\[deploy-ci\] GitHub CI green, skipping the local CI gate: .*aaaa/);
  });

  it.each([
    ['a dirty tree', fakeGit({ status: ' M src/x.ts\n' }), ghGreen, /working tree differs/],
    ['an untracked file', fakeGit({ status: '?? stray.ts\n' }), ghGreen, /working tree differs/],
    ['HEAD not on origin/master', fakeGit({ mainline: [OTHER] }), ghGreen, /not on origin\/master's first-parent history/],
    ['a short HEAD', fakeGit({ head: 'abc' }), ghGreen, /not a full commit SHA/],
    ['a gh error', fakeGit(), (() => { throw new Error('HTTP 502: Bad Gateway\nmore'); }) as Cmd, /could not check \(HTTP 502: Bad Gateway\)/],
    ['gh not authenticated', fakeGit(), (() => { throw new Error('gh: To use GitHub CLI, please run: gh auth login'); }) as Cmd, /could not check/],
    ['garbage from gh', fakeGit(), (() => '<html>oops</html>') as Cmd, /could not check/],
    ['empty output from gh', fakeGit(), (() => '') as Cmd, /could not check/],
    ['a git error', (() => { throw new Error('not a git repository'); }) as Cmd, ghGreen, /could not check \(not a git repository\)/],
    ['a red check', fakeGit(), (() => JSON.stringify(page(withRequired('Type Check, Lint & Test', { conclusion: 'failure' })))) as Cmd, /concluded failure/],
  ])('runs the full gate (exit 0) on %s', (_label, git, gh, why) => {
    const r = runMain(git, gh);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[deploy-ci\] running the full local CI gate: /);
    expect(r.out).toMatch(why);
  });
});
