/**
 * scripts/lib/deployCiGreen.ts end to end with faked git and gh: master's
 * branch protection must require exactly REQUIRED_JOBS, the required checks
 * must come from a push run of ci.yml on master, and only a skip prints the
 * `verified HEAD` line deploy.sh compares with HEAD. Anything else exits 0
 * (full local CI), never SKIP_EXIT.
 */
import { describe, expect, it } from 'vitest';
import { REQUIRED_JOBS, WORKFLOW_PATH } from '../../../scripts/ci/mq-merge-already-tested';
import { ciSuiteIds, main, protectionMismatch, REPO, SKIP_EXIT, type Cmd } from '../../../scripts/lib/deployCiGreen';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const SUITE = 77;

const run = (over: Record<string, unknown> = {}) => ({
  id: 1, path: WORKFLOW_PATH, event: 'push', head_branch: 'master', head_sha: SHA, check_suite_id: SUITE, ...over,
});
const runs = (list: unknown[], total = list.length) => ({ total_count: total, workflow_runs: list });
const PROTECTION = { strict: false, contexts: [...REQUIRED_JOBS] };
const checkRuns = (over: Record<string, unknown> = {}) => {
  const list = REQUIRED_JOBS.map((name, i) => ({
    id: i + 1, name, head_sha: SHA, status: 'completed', conclusion: 'success',
    app: { slug: 'github-actions' }, check_suite: { id: SUITE }, ...over,
  }));
  return { total_count: list.length, check_runs: list };
};

describe('protectionMismatch', () => {
  it('accepts exactly the REQUIRED_JOBS contexts, in any order', () => {
    expect(protectionMismatch(PROTECTION)).toBeNull();
    expect(protectionMismatch({ contexts: [...REQUIRED_JOBS].reverse() })).toBeNull();
  });

  it.each([
    ['an extra required context', { contexts: [...REQUIRED_JOBS, 'Security scan'] }],
    ['a missing required context', { contexts: [REQUIRED_JOBS[0]] }],
    ['a renamed context', { contexts: [REQUIRED_JOBS[0], 'Golden Paths E2E'] }],
    ['no required contexts', { contexts: [] }],
    ['no contexts field (a 403/404 body)', { message: 'Resource not accessible by integration', status: '403' }],
    ['non-string contexts', { contexts: [1, 2] }],
    ['null', null],
    ['a string', 'garbage'],
  ])('refuses %s', (_label, body) => {
    expect(protectionMismatch(body)).toEqual(expect.any(String));
  });

  it('refuses an empty REQUIRED_JOBS even against empty protection', () => {
    expect(protectionMismatch({ contexts: [] }, [])).toEqual(expect.any(String));
  });
});

describe('ciSuiteIds', () => {
  it('returns the check suites of push runs of ci.yml on master for the SHA', () => {
    const r = ciSuiteIds(runs([run(), run({ id: 2, check_suite_id: 88 }), run({ id: 3, path: '.github/workflows/other.yml', check_suite_id: 99 })]), SHA);
    expect('ids' in r && [...r.ids].sort()).toEqual([SUITE, 88]);
  });

  it.each([
    ['another workflow', [run({ path: '.github/workflows/other.yml' })]],
    ['a pull_request run', [run({ event: 'pull_request' })]],
    ['a run on another branch', [run({ head_branch: 'feature' })]],
    ['a run for another SHA', [run({ head_sha: OTHER })]],
    ['a run with no check suite', [run({ check_suite_id: null })]],
    ['no runs', []],
  ])('has nothing to trust with only %s', (_label, list) => {
    expect(ciSuiteIds(runs(list), SHA)).toEqual({ reason: expect.any(String) });
  });

  it.each([
    ['an incomplete list', runs([run()], 2)],
    ['garbage', 'garbage'],
    ['null', null],
    ['no workflow_runs', { total_count: 1 }],
  ])('refuses %s', (_label, body) => {
    expect(ciSuiteIds(body, SHA)).toEqual({ reason: expect.any(String) });
  });
});

type World = { head: string; status: string; mainline: string[]; protection: unknown; runs: unknown; checks: unknown };
const GOOD: World = {
  head: SHA, status: '', mainline: [OTHER, SHA], protection: PROTECTION, runs: runs([run()]), checks: checkRuns(),
};
function fakes(over: Partial<World> = {}, ghThrows?: RegExp): { git: Cmd; gh: Cmd } {
  const w = { ...GOOD, ...over };
  const git: Cmd = (args) => {
    const a = args.join(' ');
    if (a === 'rev-parse HEAD') return `${w.head}\n`;
    if (a === 'status --porcelain --untracked-files=normal') return w.status;
    if (a === 'rev-list --first-parent origin/master') return `${w.mainline.join('\n')}\n`;
    throw new Error(`unexpected git ${a}`);
  };
  const gh: Cmd = (args) => {
    const path = args[args.length - 1]!;
    if (ghThrows?.test(path)) throw new Error(`gh: HTTP 403: Resource not accessible (${path})\nmore`);
    if (path === `repos/${REPO}/branches/master/protection/required_status_checks`) return JSON.stringify(w.protection);
    if (path === `repos/${REPO}/actions/runs?head_sha=${w.head}&event=push&per_page=100`) return JSON.stringify(w.runs);
    if (path.startsWith(`repos/${REPO}/commits/${w.head}/check-runs?`)) return JSON.stringify(w.checks);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { git, gh };
}
function runMain(over: Partial<World> = {}, ghThrows?: RegExp) {
  let out = '';
  const code = main(fakes(over, ghThrows), (s) => { out += s; });
  return { code, out };
}

describe('main', () => {
  it('exits SKIP_EXIT and prints the evidence and the verified full SHA when every source agrees', () => {
    const r = runMain();
    expect(r.code).toBe(SKIP_EXIT);
    expect(r.out).toContain(`[deploy-ci]   "Type Check, Lint & Test": completed/success sha=${SHA} app=github-actions suite=${SUITE}`);
    expect(r.out).toContain(`[deploy-ci]   "Golden Paths E2E (blocking)": completed/success sha=${SHA}`);
    expect(r.out.match(/^\[deploy-ci\] verified HEAD ([0-9a-f]{40})$/gm)).toEqual([`[deploy-ci] verified HEAD ${SHA}`]);
    expect(r.out).toMatch(/\[deploy-ci\] GitHub CI green, skipping the local CI gate: /);
  });

  it.each([
    ['a dirty tree', { status: ' M src/x.ts\n' }, undefined, /working tree differs/],
    ['an untracked file', { status: '?? stray.ts\n' }, undefined, /working tree differs/],
    ['HEAD not on origin/master', { mainline: [OTHER] }, undefined, /not on origin\/master's first-parent history/],
    ['a short HEAD', { head: 'abc' }, undefined, /not a full commit SHA/],
    ['protection requiring one more check', { protection: { contexts: [...REQUIRED_JOBS, 'Security scan'] } }, undefined, /branch protection requires/],
    ['protection requiring one fewer check', { protection: { contexts: [REQUIRED_JOBS[0]] } }, undefined, /branch protection requires/],
    ['a 403 on the protection read', {}, /protection/, /could not check \(gh: HTTP 403/],
    ['a 403 body on the protection read', { protection: { message: 'Forbidden' } }, undefined, /no list of required contexts/],
    ['an error reading workflow runs', {}, /actions\/runs/, /could not check/],
    ['no ci.yml push run for HEAD', { runs: runs([run({ event: 'pull_request' })]) }, undefined, /no push run of/],
    ['checks from another workflow\'s suite', { runs: runs([run({ check_suite_id: 5 })]) }, undefined, /no push run of|not from a push run/],
    ['a gh error on check runs', {}, /check-runs/, /could not check/],
    ['garbage check runs', { checks: '<html>oops</html>' }, undefined, /not a check-runs response/],
    ['a red check', { checks: checkRuns({ conclusion: 'failure' }) }, undefined, /concluded failure/],
    ['a pending check', { checks: checkRuns({ status: 'in_progress', conclusion: null }) }, undefined, /in_progress, not completed/],
  ])('runs the full gate (exit 0), with no verified line, on %s', (_label, over, ghThrows, why) => {
    const r = runMain(over as Partial<World>, ghThrows);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('verified HEAD');
    expect(r.out).toMatch(/\[deploy-ci\] running the full local CI gate: /);
    expect(r.out).toMatch(why);
  });

  it('runs the full gate on a git error', () => {
    let out = '';
    const code = main({ git: () => { throw new Error('not a git repository'); }, gh: fakes().gh }, (s) => { out += s; });
    expect(code).toBe(0);
    expect(out).toMatch(/could not check \(not a git repository\)/);
  });
});
