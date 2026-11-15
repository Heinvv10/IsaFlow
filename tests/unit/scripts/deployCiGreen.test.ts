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
import { decide, fetchPages, MAX_PAGES, REPO, type Cmd } from '../../../scripts/lib/deployCiGreen';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

type Run = {
  id: number; name: string; head_sha: string; status: string; conclusion: string | null;
  app: { slug: string } | null; check_suite?: { id: number } | null;
};
const SUITE = 77;
const SUITES = new Set([SUITE]);
const ok = (name: string, id: number, over: Partial<Run> = {}): Run => ({
  id, name, head_sha: SHA, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: SUITE }, ...over,
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
    const v = decide(SHA, [page(GREEN)], SUITES);
    expect(v.skip).toBe(true);
    expect(v.reason).toContain(SHA);
    expect(v.evidence).toEqual([
      `"Type Check, Lint & Test": completed/success sha=${SHA} app=github-actions suite=77 id=1`,
      `"Golden Paths E2E (blocking)": completed/success sha=${SHA} app=github-actions suite=77 id=2`,
    ]);
  });

  it('skips across pages when the pages add up to total_count', () => {
    expect(decide(SHA, [page(GREEN.slice(0, 3), 6), page(GREEN.slice(3), 6)], SUITES).skip).toBe(true);
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
    ['from another workflow\'s check suite', { check_suite: { id: 78 } }, /not from a push run of \.github\/workflows\/ci\.yml/],
    ['in no check suite', { check_suite: null }, /not from a push run of \.github\/workflows\/ci\.yml/],
  ])('runs CI when a required check is %s', (_label, over, why) => {
    for (const name of REQUIRED_JOBS) {
      const v = decide(SHA, [page(withRequired(name, over as Partial<Run>))], SUITES);
      expect(v.skip).toBe(false);
      expect(v.reason).toMatch(why);
      expect(v.reason).toContain(name);
    }
  });

  it('runs CI when a required check is missing', () => {
    for (const name of REQUIRED_JOBS) {
      const v = decide(SHA, [page(GREEN.filter((r) => r.name !== name))], SUITES);
      expect(v.skip).toBe(false);
      expect(v.reason).toBe(`"${name}" has no check run on ${SHA}`);
    }
  });

  it('runs CI when any run of a required name is not green, even beside a green one', () => {
    const v = decide(SHA, [page([...GREEN, ok('Golden Paths E2E (blocking)', 9, { conclusion: 'failure' })])], SUITES);
    expect(v.skip).toBe(false);
    expect(v.reason).toMatch(/"Golden Paths E2E \(blocking\)" concluded failure/);
  });

  it('matches names exactly (commas, ampersands, parentheses), never by prefix or case', () => {
    const lookalikes = GREEN.map((r) => (r.name === 'Type Check, Lint & Test' ? { ...r, name: 'Type Check, Lint &amp; Test' } : r));
    expect(decide(SHA, [page(lookalikes)], SUITES).skip).toBe(false);
    const cased = GREEN.map((r) => (r.name === 'Golden Paths E2E (blocking)' ? { ...r, name: 'golden paths e2e (blocking)' } : r));
    expect(decide(SHA, [page(cased)], SUITES).skip).toBe(false);
  });

  it('runs CI when every check run is for the wrong SHA', () => {
    expect(decide(SHA, [page(GREEN.map((r) => ({ ...r, head_sha: OTHER })))], SUITES).skip).toBe(false);
    expect(decide(OTHER, [page(GREEN)], SUITES).skip).toBe(false);
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
    expect(decide(SHA, pages as unknown[], SUITES).skip).toBe(false);
  });

  it('runs CI on a SHA that is not a full SHA, and on an empty required list', () => {
    expect(decide('abc123', [page(GREEN)], SUITES).skip).toBe(false);
    expect(decide('', [page(GREEN)], SUITES).skip).toBe(false);
    expect(decide(SHA, [page(GREEN)], SUITES, []).skip).toBe(false);
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
    expect(decide(SHA, pages, SUITES).skip).toBe(false);
  });
});
