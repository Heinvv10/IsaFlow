/**
 * scripts/ci/mq-merge-already-tested.ts: a push to master skips its full run
 * only when it is a merge-queue merge whose exact tree passed both required
 * jobs as a pull_request run. Every case below that is not the happy path must
 * run everything.
 */
import { describe, expect, it, vi } from 'vitest';
import { decide, main, REQUIRED_JOBS, SKIP_EXIT, WORKFLOW_PATH, type Api, type Git } from '../../../scripts/ci/mq-merge-already-tested';

const P1 = '1'.repeat(40);
const P2 = '2'.repeat(40);
const HEAD = '3'.repeat(40);
const REPO = 'Heinvv10/IsaFlow';
const BRANCH = 'fix/s06-capture-key-standing-20261021';
const ENV = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/master', GITHUB_REPOSITORY: REPO };
const EVENT = { before: P1, after: HEAD, forced: false };

type GitState = { head: string; parents: string[]; ancestor: boolean; trees: Record<string, string>; subject: string };
const GOOD_GIT: GitState = {
  head: HEAD, parents: [P1, P2], ancestor: true, trees: { [HEAD]: 't', [P2]: 't' },
  subject: 'Merge pull request #763 from Heinvv10/fix/s06-capture-key-standing-20261021',
};

function fakeGit(over: Partial<GitState> = {}): Git {
  const s = { ...GOOD_GIT, ...over };
  return (args) => {
    const [cmd, ...rest] = args;
    if (cmd === 'rev-parse' && rest[0] === 'HEAD') return `${s.head}\n`;
    if (cmd === 'rev-parse') return `${s.trees[rest[0]!.replace('^{tree}', '')] ?? 'missing'}\n`;
    if (cmd === 'rev-list') return `${s.head} ${s.parents.join(' ')}\n`;
    if (cmd === 'merge-base') {
      if (s.ancestor) return '';
      throw Object.assign(new Error('not ancestor'), { status: 1 });
    }
    if (cmd === 'log') return `${s.subject}\n`;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

const greenJobs = REQUIRED_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success', head_sha: P2 }));
type ApiState = { pr: Record<string, unknown>; runs: Array<Record<string, unknown>>; jobs: Record<string, Array<Record<string, unknown>>> };
const GOOD_API: ApiState = {
  pr: { merged: true, merge_commit_sha: HEAD, head: { sha: P2, ref: BRANCH }, base: { ref: 'master' } },
  runs: [{ id: 7, path: WORKFLOW_PATH, event: 'pull_request', head_sha: P2, head_branch: BRANCH, head_repository: { full_name: REPO } }],
  jobs: { 7: greenJobs },
};

function fakeApi(over: Partial<ApiState> = {}): Api {
  const s = { ...GOOD_API, ...over };
  return async (path) => {
    if (path === `/repos/${REPO}/pulls/763`) return s.pr;
    if (path === `/repos/${REPO}/actions/runs?head_sha=${P2}&event=pull_request&per_page=100`) return { workflow_runs: s.runs };
    const m = /\/actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100$/.exec(path);
    if (m) return { jobs: s.jobs[m[1]!] ?? [] };
    throw new Error(`unexpected GET ${path}`);
  };
}

describe('decide', () => {
  it('skips a queue merge whose tree passed both required jobs', async () => {
    const v = await decide(ENV, EVENT, fakeGit(), fakeApi());
    expect(v.tested).toBe(true);
    expect(v.reason).toMatch(/PR #763.*run 7/);
  });

  it('skips a batch merge (maxBatch > 1): the batch PR from merge-queue/batch-* is the PR, its run the proof', async () => {
    const batch = 'merge-queue/batch-1761070000000';
    const v = await decide(ENV, EVENT, fakeGit({ subject: `Merge pull request #763 from Heinvv10/${batch}` }), fakeApi({
      pr: { ...GOOD_API.pr, head: { sha: P2, ref: batch } },
      runs: [{ ...GOOD_API.runs[0], head_branch: batch }],
    }));
    expect(v.tested).toBe(true);
  });

  it('a rerun attempt counts: a later run of the same head can carry the green jobs', async () => {
    const runs = [{ id: 8, path: WORKFLOW_PATH, event: 'pull_request', head_sha: P2, head_branch: BRANCH, head_repository: { full_name: REPO } }, ...GOOD_API.runs];
    expect((await decide(ENV, EVENT, fakeGit(), fakeApi({ runs, jobs: { 8: [greenJobs[0]!], 7: greenJobs } }))).tested).toBe(true);
  });

  const cases: Array<[string, () => Promise<{ tested: boolean; reason: string }>, RegExp]> = [
    ['a pull_request event', () => decide({ ...ENV, GITHUB_EVENT_NAME: 'pull_request' }, EVENT, fakeGit(), fakeApi()), /not push/],
    ['a push to another branch', () => decide({ ...ENV, GITHUB_REF: 'refs/heads/dev' }, EVENT, fakeGit(), fakeApi()), /not refs\/heads\/master/],
    ['a forced push', () => decide(ENV, { ...EVENT, forced: true }, fakeGit(), fakeApi()), /forced/],
    ['an event without forced', () => decide(ENV, { before: P1, after: HEAD }, fakeGit(), fakeApi()), /forced/],
    ['an event without shas', () => decide(ENV, { forced: false }, fakeGit(), fakeApi()), /no before\/after/],
    ['HEAD is not the pushed commit', () => decide(ENV, EVENT, fakeGit({ head: P2 }), fakeApi()), /not the pushed commit/],
    ['a direct (non-merge) commit', () => decide(ENV, EVENT, fakeGit({ parents: [P1] }), fakeApi()), /1 parent/],
    ['an octopus merge', () => decide(ENV, EVENT, fakeGit({ parents: [P1, P2, HEAD] }), fakeApi()), /3 parent/],
    ['several new commits (first parent is not before)', () => decide(ENV, { ...EVENT, before: '4'.repeat(40) }, fakeGit(), fakeApi()), /not the push's before/],
    ['master not merged into the PR first', () => decide(ENV, EVENT, fakeGit({ ancestor: false }), fakeApi()), /not an ancestor/],
    ['the merge changed the tree', () => decide(ENV, EVENT, fakeGit({ trees: { [HEAD]: 't', [P2]: 'u' } }), fakeApi()), /tree\(HEAD\) differs/],
    ['a hand-made merge subject', () => decide(ENV, EVENT, fakeGit({ subject: "Merge branch 'x'" }), fakeApi()), /is not "Merge pull request/],
    ['the PR is not merged', () => decide(ENV, EVENT, fakeGit(), fakeApi({ pr: { ...GOOD_API.pr, merged: false } })), /not merged/],
    ['the PR targeted another base', () => decide(ENV, EVENT, fakeGit(), fakeApi({ pr: { ...GOOD_API.pr, base: { ref: 'dev' } } })), /not merged into master/],
    ['the PR has no head branch', () => decide(ENV, EVENT, fakeGit(), fakeApi({ pr: { ...GOOD_API.pr, head: { sha: P2 } } })), /no head branch/],
    ['a green run of the same sha from another branch (another PR, another base)', () => decide(ENV, EVENT, fakeGit(), fakeApi({
      runs: [{ ...GOOD_API.runs[0], head_branch: 'feat/stacked' }],
    })), /no pull_request CI run for .* from fix\/s06/],
    ['a green run from a fork branch of the same name', () => decide(ENV, EVENT, fakeGit(), fakeApi({
      runs: [{ ...GOOD_API.runs[0], head_repository: { full_name: 'someone/IsaFlow' } }],
    })), /no pull_request CI run/],
    ['the PR head is not the second parent', () => decide(ENV, EVENT, fakeGit(), fakeApi({ pr: { ...GOOD_API.pr, head: { sha: P1 } } })), /is not the second parent/],
    ['the PR merge commit is not HEAD', () => decide(ENV, EVENT, fakeGit(), fakeApi({ pr: { ...GOOD_API.pr, merge_commit_sha: P1 } })), /is not HEAD/],
    ['no pull_request run at all', () => decide(ENV, EVENT, fakeGit(), fakeApi({ runs: [] })), /no pull_request CI run/],
    ['a run of another workflow file only', () => decide(ENV, EVENT, fakeGit(), fakeApi({ runs: [{ ...GOOD_API.runs[0], path: '.github/workflows/other.yml' }] })), /no pull_request CI run/],
    ['golden paths cancelled', () => decide(ENV, EVENT, fakeGit(), fakeApi({ jobs: { 7: [greenJobs[0]!, { ...greenJobs[1]!, conclusion: 'cancelled' }] } })), /green/],
    ['quality still running', () => decide(ENV, EVENT, fakeGit(), fakeApi({ jobs: { 7: [{ ...greenJobs[0]!, status: 'in_progress', conclusion: null }, greenJobs[1]!] } })), /green/],
    ['quality failed', () => decide(ENV, EVENT, fakeGit(), fakeApi({ jobs: { 7: [{ ...greenJobs[0]!, conclusion: 'failure' }, greenJobs[1]!] } })), /green/],
    ['required jobs green in different runs only', () => decide(ENV, EVENT, fakeGit(), fakeApi({
      runs: [...GOOD_API.runs, { id: 8, path: WORKFLOW_PATH, event: 'pull_request', head_sha: P2, head_branch: BRANCH, head_repository: { full_name: REPO } }],
      jobs: { 7: [greenJobs[0]!], 8: [greenJobs[1]!] },
    })), /green/],
    ['jobs for another sha', () => decide(ENV, EVENT, fakeGit(), fakeApi({ jobs: { 7: greenJobs.map((j) => ({ ...j, head_sha: P1 })) } })), /green/],
  ];

  it.each(cases)('runs everything on %s', async (_label, run, reason) => {
    const v = await run();
    expect(v.tested).toBe(false);
    expect(v.reason).toMatch(reason);
  });
});

describe('main (fail safe)', () => {
  const env = { ...ENV, GITHUB_EVENT_PATH: '/event.json' };
  const event = () => JSON.stringify(EVENT);
  const quiet = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  it('exits SKIP_EXIT only on the happy path, and says why', async () => {
    const out = quiet();
    expect(await main(env, fakeGit(), fakeApi(), event)).toBe(SKIP_EXIT);
    expect(out.mock.calls.join('')).toMatch(/ALREADY TESTED/);
    out.mockRestore();
  });

  it.each([
    ['an API error', fakeGit(), (async () => { throw new Error('GET x: HTTP 403'); }) as Api, event],
    ['a git error', (() => { throw new Error('fatal: bad revision'); }) as Git, fakeApi(), event],
    ['merge-base failing other than "not an ancestor" (shallow clone, exit 128)', ((args: string[]) => {
      if (args[0] === 'merge-base') throw Object.assign(new Error('fatal: no merge base'), { status: 128 });
      return fakeGit()(args);
    }) as Git, fakeApi(), event],
    ['an unreadable event', fakeGit(), fakeApi(), () => { throw new Error('ENOENT'); }],
    ['an event that is not JSON', fakeGit(), fakeApi(), () => '{'],
  ])('runs everything on %s', async (_label, git, api, readEvent) => {
    const out = quiet();
    expect(await main(env, git, api, readEvent as (p: string) => string)).toBe(0);
    expect(out.mock.calls.join('')).toMatch(/full run: could not check/);
    out.mockRestore();
  });
});
